# Claude Code R2 Mirror

This Worker serves `claude.beiapi.cn` and keeps the latest Windows Claude Code
release in Cloudflare R2.

Public endpoints:

- `https://claude.beiapi.cn/install.ps1`
- `https://claude.beiapi.cn/claude-code-releases/latest`
- `https://claude.beiapi.cn/claude-code-releases/{version}/manifest.json`
- `https://claude.beiapi.cn/claude-code-releases/{version}/win32-x64/claude.exe`
- `https://claude.beiapi.cn/claude-code-releases/{version}/win32-arm64/claude.exe`

Admin endpoint:

- `POST https://claude.beiapi.cn/admin/sync`

If `ADMIN_TOKEN` is set, call it with:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://claude.beiapi.cn/admin/sync
```

Deploy:

```bash
wrangler r2 bucket create claude-code-releases
wrangler secret put ADMIN_TOKEN
wrangler deploy
```

Notes:

- The Worker uses R2 multipart upload for the large `.exe` files.
- The official SHA256 checksum is preserved in `manifest.json` and R2 custom
  metadata; the install script verifies the downloaded binary against the
  official manifest.
- Only the current latest version is retained. Older version directories are
  deleted after a successful sync.
