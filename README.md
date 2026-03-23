# openclaw-plugin-blomp-swift

An [OpenClaw](https://openclaws.io) plugin that connects your agent to
[Blomp Cloud Storage](https://blomp.com) via the OpenStack Swift API.

## Features

| Tool | Description |
|---|---|
| `blomp_list` | List containers, or objects inside a container |
| `blomp_upload` | Upload a local file (auto-SLO for files ≥ 1 GiB) |
| `blomp_upload_slo` | Explicitly upload as a Static Large Object |
| `blomp_download` | Download an object to a local path |
| `blomp_delete` | Delete an object or an entire container |

Blomp-specific behaviour is handled automatically:
- Keystone **v2** authentication via `https://authenticate.blomp.com/v2.0/tokens`
- Tenant is hardcoded to `storage` (the only tenant on Blomp)
- SLO segments land in `<container>/.file-segments/<objectName>/` because
  Blomp does not allow creating additional containers
- Auth tokens are cached in-process and refreshed 5 minutes before expiry

---

## Installation

### 1. Copy plugin files

Place the following files anywhere OpenClaw can load plugins from
(e.g. `~/.openclaw/plugins/blomp-swift/`):

```
blomp-swift/
  plugin.ts        ← TypeScript source
  plugin.js        ← compiled output (run `npm run build` or use pre-built)
  SKILL.md         ← agent instructions (copy to your skills folder)
  package.json
  tsconfig.json
```

### 2. Build (if using TypeScript source)

```bash
cd blomp-swift
npm install
npm run build
```

### 3. Add credentials to `openclaw.config.json`

```json
{
  "plugins": {
    "blomp-swift": {
      "username": "your@blomp-email.com",
      "password": "your-blomp-password"
    }
  }
}
```

> **Security tip:** Keep `openclaw.config.json` out of version control.
> Add it to your `.gitignore`.

### 4. Install the skill

Copy `SKILL.md` into your OpenClaw skills folder
(typically `~/.openclaw/skills/blomp-swift/SKILL.md`).

### 5. Register the plugin

In your `openclaw.config.json` plugin list (or via the OpenClaw UI),
point OpenClaw at the compiled `plugin.js`:

```json
{
  "plugins": {
    "blomp-swift": {
      "username": "your@blomp-email.com",
      "password": "your-blomp-password",
      "_pluginPath": "./plugins/blomp-swift/plugin.js"
    }
  }
}
```

---

## Example prompts

```
"Show me all my Blomp containers"
"List files in my backups container"
"Upload /home/me/photo.jpg to my photos container"
"Upload /data/ubuntu.iso to isos as ubuntu-24-04.iso"
"Download report.pdf from docs to /tmp/report.pdf"
"Delete old-backup.tar from backups"
"Delete the entire temp container"   ← agent will confirm before proceeding
```

---

## Blomp technical notes

- Free tier: 200 GB of object storage
- Auth: OpenStack Keystone v2
- No container creation from SLO uploads — all segments stay in-container
- Swift API docs: https://docs.openstack.org/api-ref/object-store/

---

## License

MIT
