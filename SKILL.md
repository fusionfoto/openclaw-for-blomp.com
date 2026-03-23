# Blomp Cloud Storage Skill (OpenStack Swift)

You have access to Blomp Cloud Storage via OpenStack Swift through the following tools:

- `blomp_list` — list containers or objects
- `blomp_upload` — upload a file (auto-SLO for files ≥ 1 GiB)
- `blomp_upload_slo` — explicitly upload as a Static Large Object
- `blomp_download` — download an object to local disk
- `blomp_delete` — delete an object or an entire container

## Provider specifics

- **Auth**: Keystone v2 at `https://authenticate.blomp.com/v2.0/tokens`
- **Tenant**: always `storage` (fixed for all Blomp accounts)
- **SLO segments**: stored inside the same container under `.file-segments/<objectName>/`
  because Blomp does **not** allow creating additional containers.
- Auth tokens are cached and refreshed automatically before expiry.

---

## When to use each tool

| User intent | Tool |
|---|---|
| "Show me my containers" / "What files do I have?" | `blomp_list` |
| "List files in container X" | `blomp_list` with `container` |
| "Upload this file" (< 1 GiB) | `blomp_upload` |
| "Upload this file" (≥ 1 GiB) | `blomp_upload` (auto-routes to SLO) |
| "Upload as large object" / "upload in chunks" | `blomp_upload_slo` |
| "Download file X" | `blomp_download` |
| "Delete file X" / "Remove object Y" | `blomp_delete` with `object_name` |
| "Delete container X" / "Remove all files in X" | `blomp_delete` without `object_name` |

---

## Step-by-step guides

### Listing

```
User: show me my containers
→ blomp_list()

User: list files in my "backups" container
→ blomp_list(container="backups")

User: find all .mp4 files in "videos"
→ blomp_list(container="videos", prefix=".mp4")   # or filter by extension after listing
```

### Uploading

```
User: upload /home/user/photo.jpg to my "photos" container
→ blomp_upload(local_path="/home/user/photo.jpg", container="photos")

User: upload /data/bigfile.iso to "isos" as "ubuntu-24.iso"
→ blomp_upload(local_path="/data/bigfile.iso", container="isos", object_name="ubuntu-24.iso")
  # file is ≥ 1 GiB → automatically uploaded as SLO

User: explicitly upload in chunks to "archives"
→ blomp_upload_slo(local_path="...", container="archives")
```

### Downloading

```
User: download "report.pdf" from "docs" to /tmp/report.pdf
→ blomp_download(container="docs", object_name="report.pdf", local_path="/tmp/report.pdf")
```

### Deleting

```
User: delete "old-backup.tar" from "backups"
→ blomp_delete(container="backups", object_name="old-backup.tar")

User: delete the entire "temp" container
→ blomp_delete(container="temp")
  ⚠️  This deletes ALL objects inside "temp" — confirm with the user first.
```

---

## Important rules

1. **Always confirm before deleting a whole container** — this is irreversible.
2. **Do not attempt to create extra containers for SLO segments** — Blomp forbids it.
   Segments always go into `.file-segments/<objectName>/` inside the same container.
3. **Local paths must be accessible** on the machine running OpenClaw.
   If a user gives a relative path, resolve it from the current working directory.
4. When a tool returns `success: false`, report the `message` to the user and ask
   them to check their credentials or network.
5. **Token refresh is automatic** — never ask the user to re-authenticate manually
   unless they report repeated 401 errors.
