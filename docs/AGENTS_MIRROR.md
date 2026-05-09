# Agents Mirror Maintenance Notes

This is the operator runbook for the live `agents-mirror` deployment.

For the full Cloudflare setup guide, read the repository README:

- `/root/agents-mirror/README.md`
- `https://github.com/Yorick-Ryu/agents-mirror`

## Live Resources

- Worker: `agents-mirror`
- Worker route: `claude.beiapi.cn/*`
- R2 bucket: `claude-code-releases`
- R2 download domain: `download.beiapi.cn`
- Legacy R2 download domain: `claude-download.beiapi.cn`
- GitHub repository: `https://github.com/Yorick-Ryu/agents-mirror`

## Local Paths

- Project: `/root/agents-mirror`
- Worker code: `/root/agents-mirror/src/index.js`
- Worker config: `/root/agents-mirror/wrangler.toml`
- Main setup guide: `/root/agents-mirror/README.md`
- Local Cloudflare token: `/root/.cloudflare-api-token`
- Local admin token file: `/root/agents-mirror/.admin-token`

Do not publish `/root/.cloudflare-api-token` or `.admin-token`.

## Current Configuration

Important `wrangler.toml` values:

```toml
name = "agents-mirror"

routes = [
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" }
]

triggers = { crons = ["20 4 * * *"] }

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
GIT_INSTALL_PAGE_URL = "https://git-scm.com/install/windows"
NODE_VERSION = "v24.15.0"
PLATFORMS = "win32-x64,win32-arm64"
PART_SIZE = "16777216"
```

## Sync Behavior

The current Claude Code sync entrypoint is `syncLatest(env)` in
`/root/agents-mirror/src/index.js`.

The sync flow:

1. Read latest version from the upstream release service.
2. Read the official manifest for that version.
3. Mirror Claude Code npm tarballs.
4. Mirror configured portable Windows Node.js zip files.
5. Mirror Git for Windows x64 and ARM64 installers from the official install page.
6. Mirror platform `claude.exe` files with R2 multipart upload.
7. Write `claude-code-releases/{version}/manifest.json`.
8. Write `claude-code-releases/latest`.
9. Delete old version directories under `claude-code-releases/`.

The Worker currently keeps historical objects under `npm/`, `node/`, and `git/`.

Installer runtime selection:

- Claude Code recommends Git for Windows for native Windows installs. No specific Git version floor is documented.
- The installer uses local Git for Windows when `git.exe` exists; otherwise it downloads and silently installs Git for Windows from R2.
- Claude Code npm metadata currently requires `node >=18.0.0`.
- Codex CLI npm metadata currently requires `node >=16`.
- The installer uses local Node.js/npm when local `node >=18` and npm exists.
- Otherwise it downloads portable Node.js from R2.

## Common Operations

Deploy:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler deploy
```

Rotate `ADMIN_TOKEN`:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler secret put ADMIN_TOKEN
```

Check status:

```bash
curl -s https://claude.beiapi.cn/admin/status
```

Trigger manual sync:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://claude.beiapi.cn/admin/sync
```

Check latest version from R2:

```bash
curl -s https://download.beiapi.cn/claude-code-releases/latest
```

List R2 objects:

```bash
curl -sS -H "Authorization: Bearer $(cat /root/.cloudflare-api-token)" \
  "https://api.cloudflare.com/client/v4/accounts/4e528d4c6e70aee6dd9fec89af0e0522/r2/buckets/claude-code-releases/objects?per_page=100" |
  jq -r '.result[] | [.key, .size, .last_modified] | @tsv'
```

Read the small `latest` object:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler r2 object get claude-code-releases/claude-code-releases/latest --file -
```

## Smoke Tests

Check installer markers:

```bash
curl -s https://claude.beiapi.cn/install.ps1 |
  rg -n "DOWNLOAD_BASE_URL|R2_BASE_URL|ANTHROPIC_BASE_URL|DISABLE_AUTOUPDATER|MIN_NODE_MAJOR|Install-GitForWindows|CLAUDE_CODE_GIT_BASH_PATH"
```

Check upgrade script markers:

```bash
curl -s https://claude.beiapi.cn/upgrade.ps1 |
  rg -n "Get-RequiredCommand|MIN_NODE_MAJOR|Upgrading Claude Code npm packages"
```

Check uninstaller markers:

```bash
curl -s https://claude.beiapi.cn/uninstall.ps1 |
  rg -n "RemoveSettings|RemoveBackups|Uninstall"
```

Windows install:

```powershell
irm https://claude.beiapi.cn/install.ps1 | iex
```

Windows install with custom base URL and API key:

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/install.ps1))) -BaseUrl "https://api.example.com" -ApiKey "YOUR_API_KEY"
```

Windows upgrade only:

```powershell
irm https://claude.beiapi.cn/upgrade.ps1 | iex
```

## Troubleshooting

If `/admin/sync` returns `unauthorized`, verify `ADMIN_TOKEN` and the bearer
header. This is expected when no token is provided.

If install fails with `PropertyNotFoundStrict`, inspect the generated
PowerShell property checks. The installer should use `Test-JsonProperty` instead
of reading `.PSObject.Properties.Name` directly.

If download fails, check whether the object works through the R2 domain:

```bash
curl -I https://download.beiapi.cn/claude-code-releases/latest
```

For `claude.exe`, confirm these headers:

- `accept-ranges: bytes`
- `content-type: application/octet-stream`

If Windows reports `claude` not found after install, open a new PowerShell
session and check:

```powershell
Test-Path "$env:USERPROFILE\.claude\local\claude.cmd"
```

## Security

- Do not publish Cloudflare API tokens.
- Do not publish admin tokens.
- Do not paste API keys into logs, chat, screenshots, or issues.
- If a key is exposed, revoke it and generate a new one.
