# Agents Mirror

Cloudflare Worker + R2 mirror service for AI coding agent tools.

The current implementation mirrors Claude Code for Windows. The repository name
is intentionally generic so future mirrors, such as Codex, can share the same
Worker, download domain, and maintenance workflow.

## What This Deploys

The service has two public domains:

- Worker domain: `https://claude.beiapi.cn`
- R2 download domain: `https://download.beiapi.cn`

The Worker serves:

- `GET /install.ps1`
- `GET /uninstall.ps1`
- `GET /admin/status`
- `POST /admin/sync`
- `GET /claude-code-releases/*`

R2 stores mirrored files:

```text
claude-code-releases/latest
claude-code-releases/{version}/manifest.json
claude-code-releases/{version}/win32-x64/claude.exe
claude-code-releases/{version}/win32-arm64/claude.exe
npm/{version}/*.tgz
npm/{version}/manifest.json
node/{node_version}/*.zip
node/latest
```

## Prerequisites

- A Cloudflare account.
- A domain managed by Cloudflare DNS.
- Node.js and npm on the deployment machine.
- Wrangler installed locally or available through `npx`.
- A Cloudflare API token with permission to manage Workers, R2, DNS, and Worker
  secrets.

Install Wrangler if needed:

```bash
npm install -g wrangler
```

Login with Wrangler:

```bash
wrangler login
```

For non-interactive servers, use an API token:

```bash
export CLOUDFLARE_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN"
```

## 1. Create the R2 Bucket

Create the bucket used by the Worker binding:

```bash
wrangler r2 bucket create claude-code-releases
```

The bucket name must match `bucket_name` in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "claude-code-releases"
```

The binding name `CLAUDE_RELEASES` is used by the Worker code. If you rename it,
update `src/index.js` as well.

## 2. Configure the R2 Download Domain

Create a custom domain for the R2 bucket in Cloudflare:

```text
R2 -> claude-code-releases -> Settings -> Custom Domains -> Connect Domain
```

Use a domain such as:

```text
download.example.com
```

Cloudflare will create or manage a DNS record similar to:

```text
CNAME download.example.com -> public.r2.dev
```

Keep the record proxied.

For this deployment, the domain is:

```text
download.beiapi.cn
```

## 3. Configure the Worker Route

Choose a Worker-facing domain for installer and admin endpoints, for example:

```text
claude.example.com
```

Set the route in `wrangler.toml`:

```toml
routes = [
  { pattern = "claude.example.com/*", zone_name = "example.com" }
]
```

For this deployment:

```toml
routes = [
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" }
]
```

## 4. Configure Worker Variables

Edit `wrangler.toml` and replace these values for your deployment:

```toml
name = "agents-mirror"
main = "src/index.js"
compatibility_date = "2026-05-08"
account_id = "YOUR_CLOUDFLARE_ACCOUNT_ID"

workers_dev = false

triggers = { crons = ["20 4 * * *"] }

[vars]
PUBLIC_BASE_URL = "https://claude.example.com"
DOWNLOAD_BASE_URL = "https://download.example.com/claude-code-releases"
R2_BASE_URL = "https://download.example.com"
UPSTREAM_BASE_URL = "https://downloads.claude.ai/claude-code-releases"
NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org"
NODE_DIST_BASE_URL = "https://nodejs.org/dist"
NODE_VERSION = "v24.15.0"
PLATFORMS = "win32-x64,win32-arm64"
PART_SIZE = "16777216"
```

Variable notes:

- `PUBLIC_BASE_URL` is the Worker public domain.
- `DOWNLOAD_BASE_URL` points to the R2 release prefix and is used to read
  `latest`.
- `R2_BASE_URL` is the R2 custom domain root and is used for npm and Node.js
  downloads.
- `UPSTREAM_BASE_URL` is the official Claude Code release upstream.
- `NPM_REGISTRY_BASE_URL` is used to fetch npm tarballs.
- `NODE_DIST_BASE_URL` is used to fetch portable Node.js zip files.
- `NODE_VERSION` controls which Node.js portable runtime is mirrored.
- `PLATFORMS` controls which Claude Code Windows platforms are mirrored.
- `PART_SIZE` controls R2 multipart upload chunk size for large `.exe` files.

## 5. Configure the Admin Secret

Set `ADMIN_TOKEN` before exposing `/admin/sync`:

```bash
wrangler secret put ADMIN_TOKEN
```

Use this token when triggering manual sync:

```bash
curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://claude.example.com/admin/sync
```

If `ADMIN_TOKEN` is not set, `/admin/sync` is open. Do not leave it unset on a
public deployment.

## 6. Deploy the Worker

Deploy:

```bash
wrangler deploy
```

Expected output should include:

- Worker name: `agents-mirror`
- R2 binding: `CLAUDE_RELEASES: claude-code-releases`
- Route: your Worker domain route
- Schedule: `20 4 * * *`

## 7. Trigger the First Sync

Run a manual sync after the first deploy:

```bash
curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://claude.example.com/admin/sync
```

Check status:

```bash
curl -s https://claude.example.com/admin/status
```

Expected response shape:

```json
{
  "ok": true,
  "latest": "2.1.133",
  "publicBaseUrl": "https://claude.example.com",
  "downloadBaseUrl": "https://download.example.com/claude-code-releases",
  "platforms": ["win32-x64", "win32-arm64"]
}
```

## 8. Verify R2 Downloads

Check the latest marker:

```bash
curl -s https://download.example.com/claude-code-releases/latest
```

Check headers:

```bash
curl -I https://download.example.com/claude-code-releases/latest
curl -I https://download.example.com/claude-code-releases/2.1.133/manifest.json
```

Replace `2.1.133` with the current value from `latest`.

## 9. Verify the Installer

Download script markers:

```bash
curl -s https://claude.example.com/install.ps1 |
  grep -E 'DOWNLOAD_BASE_URL|R2_BASE_URL|ANTHROPIC_BASE_URL|DISABLE_AUTOUPDATER'
```

Windows install command:

```powershell
irm https://claude.example.com/install.ps1 | iex
```

Windows install with API key:

```powershell
& ([scriptblock]::Create((irm https://claude.example.com/install.ps1))) -ApiKey "YOUR_API_KEY"
```

Windows uninstall:

```powershell
irm https://claude.example.com/uninstall.ps1 | iex
```

## Current beiapi.cn Configuration

This repository is currently deployed with:

```toml
name = "agents-mirror"
account_id = "4e528d4c6e70aee6dd9fec89af0e0522"

routes = [
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" }
]

[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "claude-code-releases"

[vars]
PUBLIC_BASE_URL = "https://claude.beiapi.cn"
DOWNLOAD_BASE_URL = "https://download.beiapi.cn/claude-code-releases"
R2_BASE_URL = "https://download.beiapi.cn"
UPSTREAM_BASE_URL = "https://downloads.claude.ai/claude-code-releases"
NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org"
NODE_DIST_BASE_URL = "https://nodejs.org/dist"
NODE_VERSION = "v24.15.0"
PLATFORMS = "win32-x64,win32-arm64"
PART_SIZE = "16777216"
```

## Maintenance Commands

Deploy with a local API token file:

```bash
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler deploy
```

Rotate `ADMIN_TOKEN`:

```bash
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler secret put ADMIN_TOKEN
```

List R2 objects with Cloudflare API:

```bash
curl -sS -H "Authorization: Bearer $(cat /root/.cloudflare-api-token)" \
  "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/r2/buckets/claude-code-releases/objects?per_page=100" |
  jq -r '.result[] | [.key, .size, .last_modified] | @tsv'
```

## Cleanup Behavior

After a successful sync, the Worker deletes old release directories under:

```text
claude-code-releases/{old_version}/
```

The Worker currently keeps historical objects under:

```text
npm/
node/
```

If you want npm or Node.js history to be pruned, add explicit cleanup logic
before relying on this repository for long-term storage management.

## Security Notes

- Do not commit Cloudflare API tokens.
- Do not commit `.dev.vars`, `.env`, or local admin token files.
- Keep `ADMIN_TOKEN` configured before exposing `/admin/sync`.
- Revoke and rotate any API key that appears in logs, chat, screenshots, or
  public issue reports.
