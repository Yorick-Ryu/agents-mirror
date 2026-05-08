# Agents Mirror Maintenance Notes

## Purpose

This document is for maintaining the Cloudflare Worker and R2 buckets that
mirror AI coding agent tools.

The maintained Cloudflare resources are:

- Worker: `agents-mirror`
- Worker route: `claude.beiapi.cn/*`
- R2 bucket: `claude-code-releases`
- R2 public download domain: `download.beiapi.cn`
- Legacy R2 download domain: `claude-download.beiapi.cn`

The Worker is responsible for:

- Fetching the current Claude Code release metadata from the upstream release
  service.
- Fetching npm tarballs from the public npm registry.
- Fetching portable Windows Node.js zip files.
- Writing all required files into R2.
- Serving the installer and uninstaller scripts.
- Serving R2 objects under `/claude-code-releases/*` through the Worker route.

## Local Maintenance Paths

Worker project:

- `/root/agents-mirror`

Important files:

- `/root/agents-mirror/wrangler.toml`
- `/root/agents-mirror/src/index.js`
- `/root/agents-mirror/README.md`

Local Cloudflare API token:

- `/root/.cloudflare-api-token`

Do not publish `/root/.cloudflare-api-token`.

## Cloudflare Configuration

Worker config is defined in:

- `/root/agents-mirror/wrangler.toml`

Current Worker route:

```toml
routes = [
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" }
]
```

Current schedule:

```toml
triggers = { crons = ["20 4 * * *"] }
```

R2 binding:

```toml
[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "claude-code-releases"
```

Key Worker vars:

- `PUBLIC_BASE_URL=https://claude.beiapi.cn`
- `DOWNLOAD_BASE_URL=https://download.beiapi.cn/claude-code-releases`
- `R2_BASE_URL=https://download.beiapi.cn`
- `UPSTREAM_BASE_URL=https://downloads.claude.ai/claude-code-releases`
- `NPM_REGISTRY_BASE_URL=https://registry.npmjs.org`
- `NODE_DIST_BASE_URL=https://nodejs.org/dist`
- `NODE_VERSION=v24.15.0`
- `PLATFORMS=win32-x64,win32-arm64`
- `PART_SIZE=16777216`

## R2 Object Layout

Claude Code release files:

```text
claude-code-releases/latest
claude-code-releases/{version}/manifest.json
claude-code-releases/{version}/win32-x64/claude.exe
claude-code-releases/{version}/win32-arm64/claude.exe
```

npm package tarballs:

```text
npm/{version}/claude-code-{version}.tgz
npm/{version}/claude-code-win32-x64-{version}.tgz
npm/{version}/claude-code-win32-arm64-{version}.tgz
npm/{version}/manifest.json
```

Node.js portable runtime:

```text
node/{node_version}/node-{node_version}-win-x64.zip
node/{node_version}/node-{node_version}-win-arm64.zip
node/latest
```

Only old objects under `claude-code-releases/{old_version}/` are pruned by the
current Worker cleanup routine. The `npm/` and `node/` prefixes are retained.

## Sync Flow

The current Claude Code sync entrypoint is `syncLatest(env)` in:

- `/root/agents-mirror/src/index.js`

The sync does this:

1. Reads latest version from `UPSTREAM_BASE_URL/latest`.
2. Reads official manifest from `UPSTREAM_BASE_URL/{version}/manifest.json`.
3. Syncs npm tarballs for `@anthropic-ai/claude-code` and platform packages.
4. Syncs configured portable Node.js zip files.
5. Uploads platform `claude.exe` files to R2 with multipart upload.
6. Writes `claude-code-releases/{version}/manifest.json`.
7. Writes `claude-code-releases/latest`.
8. Deletes old version directories under `claude-code-releases/`.

The large `claude.exe` files use R2 multipart upload with range fetches from the
upstream download URL. The part size is controlled by `PART_SIZE`.

## Manual Operations

Check deployed Worker status:

```bash
curl -s https://claude.beiapi.cn/admin/status
```

Check latest mirrored version from R2 public domain:

```bash
curl -s https://download.beiapi.cn/claude-code-releases/latest
```

Trigger a manual sync:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://claude.beiapi.cn/admin/sync
```

If `ADMIN_TOKEN` is not configured in the Worker environment, `/admin/sync` is
open. Keep `ADMIN_TOKEN` configured in Cloudflare.

Check that the installer served by the Worker contains expected maintenance
markers:

```bash
curl -s https://claude.beiapi.cn/install.ps1 | rg -n "ANTHROPIC_BASE_URL|DISABLE_AUTOUPDATER|Test-JsonProperty"
```

Check that the uninstaller is served:

```bash
curl -s https://claude.beiapi.cn/uninstall.ps1 | rg -n "RemoveSettings|RemoveBackups|Uninstall"
```

Check R2 object headers through the public R2 domain:

```bash
curl -I https://download.beiapi.cn/claude-code-releases/latest
curl -I https://download.beiapi.cn/claude-code-releases/2.1.133/manifest.json
```

Replace `2.1.133` with the current version from the `latest` object.

## Deployment

Deploy the Worker:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler deploy
```

The expected deploy output should mention:

- Worker name: `agents-mirror`
- R2 binding: `CLAUDE_RELEASES: claude-code-releases`
- Route: `claude.beiapi.cn/*`
- Schedule: `20 4 * * *`

If Wrangler asks for interactive login, the API token was not picked up or is
invalid. Verify:

```bash
test -s /root/.cloudflare-api-token
```

Wrangler may warn that the installed version is old. That warning does not
block deployment if the command exits successfully.

## R2 Bucket Maintenance

Create the R2 bucket if rebuilding from scratch:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler r2 bucket create claude-code-releases
```

List objects in the bucket with the Cloudflare API:

```bash
curl -sS -H "Authorization: Bearer $(cat /root/.cloudflare-api-token)" \
  "https://api.cloudflare.com/client/v4/accounts/4e528d4c6e70aee6dd9fec89af0e0522/r2/buckets/claude-code-releases/objects?per_page=100" |
  jq -r '.result[] | [.key, .size, .last_modified] | @tsv'
```

Read a small object:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler r2 object get claude-code-releases/claude-code-releases/latest --file -
```

Delete a bad object only when necessary:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler r2 object delete claude-code-releases/path/to/object
```

Prefer rerunning `/admin/sync` after deleting a bad mirrored object so the
Worker recreates it with the same metadata rules as normal sync.

## Worker Secret Maintenance

Set or rotate the admin sync token:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler secret put ADMIN_TOKEN
```

After changing `ADMIN_TOKEN`, verify `/admin/sync` requires the new bearer
token.

## Public Smoke Tests

These commands are for validating the maintained Worker from a Windows client.

Install:

```powershell
irm https://claude.beiapi.cn/install.ps1 | iex
```

Install and write API key:

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/install.ps1))) -ApiKey "YOUR_API_KEY"
```

Uninstall and keep `settings.json`:

```powershell
irm https://claude.beiapi.cn/uninstall.ps1 | iex
```

Uninstall and remove `settings.json`:

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/uninstall.ps1))) -RemoveSettings
```

Uninstall and remove `settings.json` plus backup files:

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/uninstall.ps1))) -RemoveSettings -RemoveBackups
```

## Troubleshooting

PowerShell install error:

```text
PropertyNotFoundStrict
```

This is usually caused by unsafe property checks under
`Set-StrictMode -Version Latest`. The installer should use `Test-JsonProperty`
with `$obj.PSObject.Properties.Match($name).Count` instead of reading
`.PSObject.Properties.Name` directly.

R2 object exists but client download fails:

- Check object headers through `curl -I`.
- Check whether the object is being served from `download.beiapi.cn` or
  through the Worker route.
- For `claude.exe`, confirm `accept-ranges: bytes` and
  `content-type: application/octet-stream`.

Manual sync fails:

- Check whether the upstream release URL is reachable.
- Check whether npm metadata for the current version exists.
- Check whether R2 multipart upload failed on a large `claude.exe` range.
- Retry `/admin/sync` after the upstream issue is resolved.

Windows install succeeds but `claude` is not found:

- Open a new PowerShell session so the updated user `Path` is loaded.
- Check `C:\Users\<user>\.claude\local\claude.cmd`.

API keys and Cloudflare tokens must not be pasted into public logs or chat. If a
key is exposed, revoke it and generate a new one.
