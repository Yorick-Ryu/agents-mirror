# Agents Mirror

Cloudflare Worker and R2 mirror service for AI coding agent tools.

The current mirror target is Claude Code for Windows. Future mirrors, such as
Codex, can share the same Worker and download domain with separate R2 prefixes
or buckets.

## Current Public Endpoints

- `https://claude.beiapi.cn/install.ps1`
- `https://claude.beiapi.cn/uninstall.ps1`
- `https://download.beiapi.cn/claude-code-releases/latest`
- `https://download.beiapi.cn/claude-code-releases/{version}/manifest.json`
- `https://download.beiapi.cn/claude-code-releases/{version}/win32-x64/claude.exe`
- `https://download.beiapi.cn/claude-code-releases/{version}/win32-arm64/claude.exe`

## Admin Endpoint

- `POST https://claude.beiapi.cn/admin/sync`

If `ADMIN_TOKEN` is set, call it with:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://claude.beiapi.cn/admin/sync
```

## Deploy

```bash
wrangler r2 bucket create claude-code-releases
wrangler secret put ADMIN_TOKEN
wrangler deploy
```

## Notes

- The Worker currently syncs Claude Code release metadata, Windows binaries,
  npm tarballs, and portable Node.js zip files into R2.
- Large `.exe` files are uploaded with R2 multipart upload.
- The official SHA256 checksum is preserved in `manifest.json` and R2 custom
  metadata.
- Only the current latest Claude Code release directory is retained under
  `claude-code-releases/`; npm and Node.js prefixes are currently retained.
