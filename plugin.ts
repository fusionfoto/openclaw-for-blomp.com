/**
 * blomp-swift — OpenClaw plugin for Blomp Cloud Storage (OpenStack Swift)
 *
 * Blomp specifics:
 *   - Auth:    Keystone v2  →  https://authenticate.blomp.com/v2.0/tokens
 *   - Tenant:  storage  (fixed for all Blomp accounts)
 *   - SLO:     segments stored inside the same container under .file-segments/
 *              (Blomp does NOT allow creating extra containers)
 *
 * Config keys expected in openclaw.config.json  ➜  plugins.blomp-swift:
 *   username   string   Your Blomp account e-mail
 *   password   string   Your Blomp account password
 *
 * Tools registered:
 *   blomp_list        – list containers, or objects inside a container
 *   blomp_upload      – upload a local file (auto-SLO for files ≥ 1 GiB)
 *   blomp_download    – download an object to a local path
 *   blomp_delete      – delete an object or an entire container
 *   blomp_upload_slo  – explicitly upload as a Static Large Object (chunked)
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { IncomingMessage } from "http";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BlompConfig {
  username: string;
  password: string;
}

interface AuthToken {
  token: string;
  storageUrl: string;
  expiresAt: number; // epoch ms
}

interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTH_URL = "https://authenticate.blomp.com/v2.0/tokens";
const TENANT_NAME = "storage";
const SLO_SEGMENT_SIZE = 1_073_741_824; // 1 GiB per segment
const SLO_AUTO_THRESHOLD = 1_073_741_824; // auto-SLO for files ≥ 1 GiB
const SEGMENT_PREFIX = ".file-segments"; // Blomp stores SLO chunks here
const AUTH_MAX_RETRIES = 4;       // total attempts (1 initial + 3 retries)
const AUTH_RETRY_BASE_MS = 500;   // base delay for exponential back-off

const HTTP_TIMEOUT_MS = 30_000;   // socket inactivity timeout per attempt
const HTTP_MAX_RETRIES = 4;       // total attempts for general HTTP calls
const HTTP_RETRY_BASE_MS = 300;   // base delay: 300 ms, 600 ms, 1.2 s, …
const DELETE_CONCURRENCY = 16;    // max parallel DELETE requests in flight

// ─── Auth cache (in-process, refreshed when within 5 min of expiry) ──────────

let _authCache: AuthToken | null = null;

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Obtain a valid Keystone v2 token, using the in-process cache when possible.
 * On network/server errors the POST is retried up to AUTH_MAX_RETRIES times
 * with exponential back-off (500 ms, 1 s, 2 s, …).
 * 4xx responses (bad credentials, etc.) are NOT retried — they are re-thrown
 * immediately so the caller receives a clear error.
 */
async function getAuth(cfg: BlompConfig): Promise<AuthToken> {
  const now = Date.now();
  if (_authCache && _authCache.expiresAt - now > 5 * 60 * 1000) {
    return _authCache;
  }

  const body = JSON.stringify({
    auth: {
      tenantName: TENANT_NAME,
      passwordCredentials: {
        username: cfg.username,
        password: cfg.password,
      },
    },
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < AUTH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = AUTH_RETRY_BASE_MS * Math.pow(2, attempt - 1); // 500, 1000, 2000 ms
      console.warn(
        `[blomp-swift] Auth attempt ${attempt + 1}/${AUTH_MAX_RETRIES} after ${delay} ms (last error: ${lastError?.message})`
      );
      await sleep(delay);
    }

    try {
      const raw = await httpPost(AUTH_URL, body, {
        "Content-Type": "application/json",
      });

      const json = JSON.parse(raw) as {
        access: {
          token: { id: string; expires: string };
          serviceCatalog: Array<{
            type: string;
            endpoints: Array<{ publicURL: string }>;
          }>;
        };
      };

      const tokenId = json.access.token.id;
      const expiresAt = new Date(json.access.token.expires).getTime();

      const objectStore = json.access.serviceCatalog.find(
        (s) => s.type === "object-store"
      );
      if (!objectStore || !objectStore.endpoints[0]) {
        throw new Error("No object-store endpoint in Blomp service catalog.");
      }
      const storageUrl = objectStore.endpoints[0].publicURL;

      _authCache = { token: tokenId, storageUrl, expiresAt };
      return _authCache;
    } catch (err) {
      const error = err as Error;
      // 4xx errors indicate bad credentials or a misconfiguration — no point retrying.
      if (error.message.startsWith("HTTP 4")) {
        throw new Error(`[blomp-swift] Auth failed (not retrying): ${error.message}`);
      }
      lastError = error;
      // 5xx / network errors fall through to the next retry iteration.
    }
  }

  throw new Error(
    `[blomp-swift] Auth failed after ${AUTH_MAX_RETRIES} attempts. Last error: ${lastError?.message}`
  );
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true for errors worth retrying (network glitches, 5xx).
 * 4xx errors mean the request is broken — no retrying will fix them.
 */
function isRetryable(err: Error): boolean {
  return !err.message.startsWith("HTTP 4");
}

/**
 * Run `fn` up to `maxAttempts` times with exponential back-off.
 * Non-retryable (4xx) errors are re-thrown immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  label: string
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[blomp-swift] ${label}: retry ${attempt}/${maxAttempts - 1} in ${delay} ms (${lastError?.message})`
      );
      await sleep(delay);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (!isRetryable(lastError)) throw lastError;
    }
  }
  throw new Error(
    `[blomp-swift] ${label} failed after ${maxAttempts} attempts: ${lastError?.message}`
  );
}

/**
 * Single-attempt POST. Rejects on HTTP 4xx/5xx or timeout.
 * getAuth supplies its own retry loop on top of this.
 */
function httpPostOnce(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error("HTTP_TIMEOUT")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** POST with automatic retry. */
function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>
): Promise<string> {
  return withRetry(
    () => httpPostOnce(url, body, headers),
    HTTP_MAX_RETRIES,
    HTTP_RETRY_BASE_MS,
    `POST ${url}`
  );
}

/**
 * Single-attempt request for small payloads (GET, DELETE, manifest PUT).
 * Always resolves — callers inspect res.status. Rejects on network/timeout only.
 */
function httpRequestOnce(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyBuffer?: Buffer
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(bodyBuffer ? { "Content-Length": bodyBuffer.length.toString() } : {}),
        },
        timeout: HTTP_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers as Record<string, string>,
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => { req.destroy(new Error("HTTP_TIMEOUT")); });
    req.on("error", reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/**
 * httpRequest with retry. 5xx responses are thrown so withRetry can catch them;
 * 4xx pass through as resolved values so callers handle them without surprises.
 */
async function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyBuffer?: Buffer
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return withRetry(
    async () => {
      const res = await httpRequestOnce(method, url, headers, bodyBuffer);
      if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${res.body}`);
      return res;
    },
    HTTP_MAX_RETRIES,
    HTTP_RETRY_BASE_MS,
    `${method} ${url}`
  );
}

/**
 * Concurrency-limited parallel task runner (zero external dependencies).
 * Dispatches up to `limit` tasks simultaneously; collects all results in order,
 * wrapping each as { ok: true, value } or { ok: false, error }.
 */
async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<Array<{ ok: true; value: T } | { ok: false; error: Error }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: Error }> =
    new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err as Error };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
  return results;
}
function swiftHeaders(token: string, extra: Record<string, string> = {}) {
  return { "X-Auth-Token": token, ...extra };
}

/**
 * Single-attempt streaming PUT. Pipes `readable` directly into the request
 * so no body data is buffered in memory. Rejects on network/timeout errors;
 * always resolves on a completed HTTP exchange regardless of status code.
 *
 * NOTE: Because the readable is consumed on the first attempt, streaming PUTs
 * are NOT retried automatically — the caller must recreate the stream if it
 * wishes to retry (blompUpload and blompUploadSlo do this via fresh
 * fs.createReadStream calls for each segment).
 */
function httpPutStream(
  url: string,
  headers: Record<string, string>,
  readable: NodeJS.ReadableStream
): Promise<{ status: number; etag: string; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "PUT",
        headers,
        timeout: HTTP_TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            etag: (res.headers["etag"] ?? "").replace(/"/g, ""),
            body,
          });
        });
        res.on("error", reject);
      }
    );

    req.on("timeout", () => { req.destroy(new Error("HTTP_TIMEOUT")); });
    req.on("error", reject);
    readable.on("error", reject);
    readable.pipe(req);
  });
}

// ─── Tool implementations ────────────────────────────────────────────────────

/**
 * List containers (no args) or objects inside a container.
 */
async function blompList(
  cfg: BlompConfig,
  container?: string,
  prefix?: string
): Promise<ToolResult> {
  const auth = await getAuth(cfg);
  const base = container
    ? `${auth.storageUrl}/${encodeURIComponent(container)}`
    : auth.storageUrl;
  const qs = new URLSearchParams({ format: "json" });
  if (prefix) qs.set("prefix", prefix);

  const res = await httpRequest(
    "GET",
    `${base}?${qs}`,
    swiftHeaders(auth.token)
  );
  if (res.status !== 200) {
    return { success: false, message: `List failed: HTTP ${res.status}` };
  }

  const items = JSON.parse(res.body) as unknown[];
  return {
    success: true,
    message: `Found ${items.length} ${container ? "object(s)" : "container(s)"}.`,
    data: items,
  };
}

/**
 * Upload a local file, streaming directly from disk.
 * Automatically promotes to SLO for files ≥ 1 GiB.
 */
async function blompUpload(
  cfg: BlompConfig,
  localPath: string,
  container: string,
  objectName?: string
): Promise<ToolResult> {
  const resolvedName = objectName ?? path.basename(localPath);
  const stat = fs.statSync(localPath);

  if (stat.size >= SLO_AUTO_THRESHOLD) {
    return blompUploadSlo(cfg, localPath, container, resolvedName);
  }

  const auth = await getAuth(cfg);
  const url = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(resolvedName)}`;

  const res = await httpPutStream(
    url,
    swiftHeaders(auth.token, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size.toString(),
    }),
    fs.createReadStream(localPath)
  );

  if (res.status === 201 || res.status === 200) {
    return {
      success: true,
      message: `Uploaded '${resolvedName}' to container '${container}' (${stat.size} bytes).`,
    };
  }
  return {
    success: false,
    message: `Upload failed: HTTP ${res.status} — ${res.body}`,
  };
}

/**
 * Explicitly upload as a Static Large Object, streaming each segment from disk.
 * A ReadStream with start/end byte offsets is used per segment so only one
 * segment's worth of data is in flight at a time — no full-file buffer needed.
 * Segments are placed in <container>/.file-segments/<objectName>/<partN>
 * (Blomp does not allow creating additional containers.)
 */
async function blompUploadSlo(
  cfg: BlompConfig,
  localPath: string,
  container: string,
  objectName?: string
): Promise<ToolResult> {
  const resolvedName = objectName ?? path.basename(localPath);
  const auth = await getAuth(cfg);
  const stat = fs.statSync(localPath);
  const totalSize = stat.size;
  const numSegments = Math.ceil(totalSize / SLO_SEGMENT_SIZE);

  const manifest: Array<{ path: string; etag: string; size_bytes: number }> = [];

  for (let i = 0; i < numSegments; i++) {
    const start = i * SLO_SEGMENT_SIZE;
    const end = Math.min(start + SLO_SEGMENT_SIZE, totalSize) - 1; // inclusive
    const segSize = end - start + 1;

    const segName = `${SEGMENT_PREFIX}/${resolvedName}/${String(i).padStart(8, "0")}`;
    const segUrl = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(segName)}`;

    const segStream = fs.createReadStream(localPath, { start, end });

    const segRes = await httpPutStream(
      segUrl,
      swiftHeaders(auth.token, {
        "Content-Type": "application/octet-stream",
        "Content-Length": segSize.toString(),
      }),
      segStream
    );

    if (segRes.status !== 201 && segRes.status !== 200) {
      return {
        success: false,
        message: `Segment ${i} upload failed: HTTP ${segRes.status} — ${segRes.body}`,
      };
    }

    manifest.push({
      path: `/${container}/${segName}`,
      etag: segRes.etag,
      size_bytes: segSize,
    });
  }

  // PUT the SLO manifest (small JSON — keeping as buffer is fine here)
  const manifestUrl = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(resolvedName)}?multipart-manifest=put`;
  const manifestBody = Buffer.from(JSON.stringify(manifest));

  const mRes = await httpRequest(
    "PUT",
    manifestUrl,
    swiftHeaders(auth.token, {
      "Content-Type": "application/json",
      "X-Static-Large-Object": "true",
    }),
    manifestBody
  );

  if (mRes.status === 201 || mRes.status === 200) {
    return {
      success: true,
      message: `Uploaded '${resolvedName}' as SLO (${numSegments} segments, ${totalSize} bytes total).`,
    };
  }
  return {
    success: false,
    message: `SLO manifest PUT failed: HTTP ${mRes.status} — ${mRes.body}`,
  };
}

/**
 * Download an object, streaming directly to disk without buffering in memory.
 * Creates any missing parent directories before writing.
 */
async function blompDownload(
  cfg: BlompConfig,
  container: string,
  objectName: string,
  localPath: string
): Promise<ToolResult> {
  const auth = await getAuth(cfg);
  const url = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(objectName)}`;

  const destPath = path.isAbsolute(localPath)
    ? localPath
    : path.join(process.cwd(), localPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  return new Promise((resolve) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: "GET",
      headers: swiftHeaders(auth.token),
    };

    const req = https.request(options, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        // Drain and discard the response body so the socket is released cleanly.
        res.resume();
        resolve({
          success: false,
          message: `Download failed: HTTP ${res.statusCode}`,
        });
        return;
      }

      const fileStream = fs.createWriteStream(destPath);

      res.pipe(fileStream);

      fileStream.on("finish", () => {
        const bytes = fs.statSync(destPath).size;
        resolve({
          success: true,
          message: `Downloaded '${objectName}' from '${container}' to '${destPath}' (${bytes} bytes).`,
        });
      });

      fileStream.on("error", (err: Error) => {
        resolve({
          success: false,
          message: `Failed to write to '${destPath}': ${err.message}`,
        });
      });

      res.on("error", (err: Error) => {
        resolve({
          success: false,
          message: `Stream error while downloading '${objectName}': ${err.message}`,
        });
      });
    });

    req.on("error", (err: Error) => {
      resolve({
        success: false,
        message: `Request error for '${objectName}': ${err.message}`,
      });
    });

    req.end();
  });
}

/**
 * Delete a single object, or all objects in a container in parallel then
 * delete the container itself.
 *
 * Object deletes run DELETE_CONCURRENCY at a time. Any individual failures
 * are collected and reported without aborting the rest of the batch.
 */
async function blompDelete(
  cfg: BlompConfig,
  container: string,
  objectName?: string
): Promise<ToolResult> {
  const auth = await getAuth(cfg);

  if (objectName) {
    const url = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(objectName)}`;
    const res = await httpRequest("DELETE", url, swiftHeaders(auth.token));
    if (res.status === 204 || res.status === 200) {
      return { success: true, message: `Deleted '${objectName}' from '${container}'.` };
    }
    return { success: false, message: `Delete failed: HTTP ${res.status}` };
  }

  // ── Container delete: list → parallel-delete objects → delete container ──

  const listRes = await blompList(cfg, container);
  if (!listRes.success) return listRes;

  const objects = listRes.data as Array<{ name: string }>;

  if (objects.length > 0) {
    const tasks = objects.map((obj) => () => {
      const url = `${auth.storageUrl}/${encodeURIComponent(container)}/${encodeURIComponent(obj.name)}`;
      return httpRequest("DELETE", url, swiftHeaders(auth.token));
    });

    const results = await pLimit(tasks, DELETE_CONCURRENCY);

    const failures = results
      .map((r, i) => ({ r, name: objects[i].name }))
      .filter(({ r }) => {
        if (!r.ok) return true;
        const status = (r as { ok: true; value: { status: number } }).value.status;
        return status !== 204 && status !== 200;
      })
      .map(({ name, r }) => {
        const detail = r.ok
          ? `HTTP ${(r as { ok: true; value: { status: number } }).value.status}`
          : (r as { ok: false; error: Error }).error.message;
        return `${name} (${detail})`;
      });

    if (failures.length > 0) {
      return {
        success: false,
        message:
          `Deleted ${objects.length - failures.length}/${objects.length} objects, ` +
          `but ${failures.length} failed: ${failures.join(", ")}`,
      };
    }
  }

  const containerUrl = `${auth.storageUrl}/${encodeURIComponent(container)}`;
  const delRes = await httpRequest("DELETE", containerUrl, swiftHeaders(auth.token));

  if (delRes.status === 204 || delRes.status === 200) {
    return {
      success: true,
      message: `Deleted container '${container}' and all ${objects.length} object(s).`,
    };
  }
  return {
    success: false,
    message: `Objects deleted but container DELETE failed: HTTP ${delRes.status}`,
  };
}

// ─── OpenClaw plugin entry point ─────────────────────────────────────────────

export default function register(openclaw: {
  config: { plugins?: { "blomp-swift"?: BlompConfig } };
  registerTool: (
    name: string,
    description: string,
    schema: object,
    handler: (args: Record<string, string>) => Promise<string>
  ) => void;
}) {
  const cfg = openclaw.config?.plugins?.["blomp-swift"];

  if (!cfg?.username || !cfg?.password) {
    console.warn(
      "[blomp-swift] Missing credentials in openclaw.config.json → plugins[\"blomp-swift\"]. Plugin disabled."
    );
    return;
  }

  // ── blomp_list ──────────────────────────────────────────────────────────────
  openclaw.registerTool(
    "blomp_list",
    "List Blomp containers or objects inside a container.",
    {
      type: "object",
      properties: {
        container: {
          type: "string",
          description: "Container name. Omit to list all containers.",
        },
        prefix: {
          type: "string",
          description:
            "Optional object name prefix filter (only used when container is given).",
        },
      },
    },
    async (args) => {
      const result = await blompList(cfg, args.container, args.prefix);
      return JSON.stringify(result, null, 2);
    }
  );

  // ── blomp_upload ────────────────────────────────────────────────────────────
  openclaw.registerTool(
    "blomp_upload",
    "Upload a local file to a Blomp container. Automatically uses SLO for files ≥ 1 GiB.",
    {
      type: "object",
      required: ["local_path", "container"],
      properties: {
        local_path: { type: "string", description: "Absolute local file path." },
        container: {
          type: "string",
          description: "Target Blomp container name.",
        },
        object_name: {
          type: "string",
          description:
            "Object name in the container. Defaults to the file's basename.",
        },
      },
    },
    async (args) => {
      const result = await blompUpload(
        cfg,
        args.local_path,
        args.container,
        args.object_name
      );
      return JSON.stringify(result, null, 2);
    }
  );

  // ── blomp_upload_slo ────────────────────────────────────────────────────────
  openclaw.registerTool(
    "blomp_upload_slo",
    "Explicitly upload a file to Blomp as a Static Large Object (1 GiB segments). " +
      "Segments are stored under <container>/.file-segments/<objectName>/.",
    {
      type: "object",
      required: ["local_path", "container"],
      properties: {
        local_path: { type: "string", description: "Absolute local file path." },
        container: {
          type: "string",
          description: "Target Blomp container name.",
        },
        object_name: {
          type: "string",
          description: "Object name. Defaults to the file's basename.",
        },
      },
    },
    async (args) => {
      const result = await blompUploadSlo(
        cfg,
        args.local_path,
        args.container,
        args.object_name
      );
      return JSON.stringify(result, null, 2);
    }
  );

  // ── blomp_download ──────────────────────────────────────────────────────────
  openclaw.registerTool(
    "blomp_download",
    "Download an object from a Blomp container to a local path.",
    {
      type: "object",
      required: ["container", "object_name", "local_path"],
      properties: {
        container: { type: "string", description: "Source container name." },
        object_name: { type: "string", description: "Object name to download." },
        local_path: {
          type: "string",
          description: "Destination local file path.",
        },
      },
    },
    async (args) => {
      const result = await blompDownload(
        cfg,
        args.container,
        args.object_name,
        args.local_path
      );
      return JSON.stringify(result, null, 2);
    }
  );

  // ── blomp_delete ────────────────────────────────────────────────────────────
  openclaw.registerTool(
    "blomp_delete",
    "Delete an object from Blomp, or delete an entire container and all its objects.",
    {
      type: "object",
      required: ["container"],
      properties: {
        container: { type: "string", description: "Container name." },
        object_name: {
          type: "string",
          description:
            "Object to delete. Omit to delete the entire container (and all objects within it).",
        },
      },
    },
    async (args) => {
      const result = await blompDelete(cfg, args.container, args.object_name);
      return JSON.stringify(result, null, 2);
    }
  );
}
