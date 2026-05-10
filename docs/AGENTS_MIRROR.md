# Agents Mirror Maintenance Notes

This is the operator runbook for the live `agents-mirror` deployment.

For the full Cloudflare setup guide, read the repository README:

- `/root/agents-mirror/README.md`
- `https://github.com/Yorick-Ryu/agents-mirror`

## Live Resources

- Worker: `agents-mirror`
- Worker routes: `claude.beiapi.cn/*`, `codex.beiapi.cn/*`
- R2 bucket: `agents-mirror`
- R2 download domain: `download.beiapi.cn`
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
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" },
  { pattern = "codex.beiapi.cn/*", zone_name = "beiapi.cn" }
]

triggers = { crons = ["20 4 * * MON-SAT", "20 4 * * SUN"] }

[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "agents-mirror"

[vars]
PUBLIC_BASE_URL = "https://claude.beiapi.cn"
CODEX_PUBLIC_BASE_URL = "https://codex.beiapi.cn"
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

The Codex CLI sync entrypoint is `syncCodexLatest(env)`. `/admin/sync` and the
scheduled handler call `syncAll(env)`, which mirrors both Claude Code and Codex
CLI. The response preserves Claude's historical top-level fields and adds a
`codex` object.

Install script endpoints:

- `/install.ps1`: standard installer. Writes `ANTHROPIC_BASE_URL`,
  `DISABLE_AUTOUPDATER`, optional `ANTHROPIC_AUTH_TOKEN`, and Git Bash path to
  `%USERPROFILE%\.claude\settings.json`.
- `/install-deepseek.ps1`: DeepSeek-specific installer. Reuses the same mirrored
  Claude Code, Node.js, and Git for Windows artifacts, but writes DeepSeek's
  Anthropic-compatible settings to `%USERPROFILE%\.claude\settings.json`.
  It accepts only `-ApiKey`.
- `https://codex.beiapi.cn/install.ps1`: Codex CLI installer. Reuses mirrored
  Node.js and Git for Windows artifacts, installs `@openai/codex` plus the
  mirrored Windows platform tarball from `codex/npm/{version}`.
- `https://codex.beiapi.cn/upgrade.ps1`: Codex CLI npm package upgrade only.
- `https://codex.beiapi.cn/uninstall.ps1`: removes the local Codex install
  prefix and portable runtime. It keeps
  `%USERPROFILE%\.codex\config.toml` and `auth.json` unless `-RemoveConfig` or
  `-RemoveAuth` are supplied.

The scheduled sync flow runs in two modes:

- Monday through Saturday at `04:20 UTC`: mirror latest metadata, Claude npm
  tarballs, Codex npm tarballs, and platform `claude.exe` files.
- Sunday at `04:20 UTC`: run the full sync, including portable Node.js zips
  and Git for Windows installers.

Manual `/admin/sync` requests still run the full sync.

The full sync flow:

1. Read latest version from the upstream release service.
2. Read the official manifest for that version.
3. Mirror Claude Code npm tarballs.
4. Mirror configured portable Windows Node.js zip files.
5. Mirror Git for Windows x64 and ARM64 installers from the official install page.
6. Mirror platform `claude.exe` files with R2 multipart upload.
7. Write `claude-code-releases/{version}/manifest.json`.
8. Write `claude-code-releases/latest`.
9. Delete old version directories under `claude-code-releases/`.

The Codex sync flow:

1. Read latest `@openai/codex` metadata from npm.
2. Mirror `@openai/codex` plus the Windows platform tarballs resolved from
   `@openai/codex@{version}-win32-x64` and `@openai/codex@{version}-win32-arm64`
   under `codex/npm/{version}`.
3. Write `codex/npm/{version}/manifest.json`.
4. Write `codex/latest`.
5. In full sync mode, reuse the shared Node.js and Git for Windows sync steps.

The Worker currently keeps historical objects under `npm/`, `codex/npm/`,
`node/`, and `git/`.

Installer runtime selection:

- Claude Code recommends Git for Windows for native Windows installs. No specific Git version floor is documented.
- The installer uses local Git for Windows when `git.exe` exists; otherwise it downloads and silently installs Git for Windows from R2.
- Claude Code npm metadata currently requires `node >=18.0.0`.
- Codex CLI npm metadata currently requires `node >=16`.
- The installer uses local Node.js/npm when local `node >=18` and npm exists.
- Otherwise it downloads portable Node.js from R2.
- The Codex installer uses local Node.js/npm when local `node >=16` and npm
  exists. It does not automate `codex login` or API key/auth configuration.

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

Check latest Codex CLI version from R2:

```bash
curl -s https://download.beiapi.cn/codex/latest
```

List R2 objects:

```bash
curl -sS -H "Authorization: Bearer $(cat /root/.cloudflare-api-token)" \
  "https://api.cloudflare.com/client/v4/accounts/4e528d4c6e70aee6dd9fec89af0e0522/r2/buckets/agents-mirror/objects?per_page=100" |
  jq -r '.result[] | [.key, .size, .last_modified] | @tsv'
```

Read the small `latest` object:

```bash
cd /root/agents-mirror
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler r2 object get agents-mirror/claude-code-releases/latest --file -
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

Check Codex installer markers:

```bash
curl -s https://codex.beiapi.cn/install.ps1 |
  rg -n "codex/latest|MIN_NODE_MAJOR|Installing Codex CLI npm packages|codex login"
```

Check Codex upgrade script markers:

```bash
curl -s https://codex.beiapi.cn/upgrade.ps1 |
  rg -n "Get-RequiredCommand|MIN_NODE_MAJOR|Upgrading Codex CLI npm packages"
```

Check Codex uninstaller markers:

```bash
curl -s https://codex.beiapi.cn/uninstall.ps1 |
  rg -n "RemoveConfig|RemoveAuth|Uninstall"
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

Codex Windows install:

```powershell
irm https://codex.beiapi.cn/install.ps1 | iex
codex login
```

Codex Windows upgrade only:

```powershell
irm https://codex.beiapi.cn/upgrade.ps1 | iex
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

For Codex CLI, also check:

```bash
curl -I https://download.beiapi.cn/codex/latest
```

For `claude.exe`, confirm these headers:

- `accept-ranges: bytes`
- `content-type: application/octet-stream`

If Windows reports `claude` not found after install, open a new PowerShell
session and check:

```powershell
Test-Path "$env:USERPROFILE\.claude\local\claude.cmd"
```

If Windows reports `codex` not found after install, open a new PowerShell
session and check:

```powershell
Test-Path "$env:USERPROFILE\.codex\local\codex.cmd"
```

## Security

- Do not publish Cloudflare API tokens.
- Do not publish admin tokens.
- Do not paste API keys into logs, chat, screenshots, or issues.
- If a key is exposed, revoke it and generate a new one.
