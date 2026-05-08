# Agents Mirror

Agents Mirror 是一个基于 Cloudflare Worker + R2 的 AI 编程 Agent 工具镜像服务。

当前已实现的镜像目标是 Windows 版 Claude Code。仓库名称保持通用，后续可以继续加入 Codex 等其他工具镜像，共用同一个 Worker、下载域名和维护流程。

## 部署后提供什么

服务包含两个公开域名：

- Worker 入口域名：`https://claude.beiapi.cn`
- R2 下载域名：`https://download.beiapi.cn`

Worker 提供这些接口：

- `GET /install.ps1`
- `GET /uninstall.ps1`
- `GET /admin/status`
- `POST /admin/sync`
- `GET /claude-code-releases/*`

R2 里存放镜像文件：

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

## 前置条件

你需要准备：

- 一个 Cloudflare 账号。
- 一个已经接入 Cloudflare DNS 的域名。
- 部署机器上有 Node.js 和 npm。
- 本地安装 Wrangler，或者能通过 `npx` 调用 Wrangler。
- 一个 Cloudflare API Token，权限需要覆盖 Workers、R2、DNS 和 Worker Secrets。

安装 Wrangler：

```bash
npm install -g wrangler
```

交互式登录：

```bash
wrangler login
```

服务器上也可以使用 API Token：

```bash
export CLOUDFLARE_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN"
```

## 1. 创建 R2 Bucket

创建 Worker 使用的 R2 bucket：

```bash
wrangler r2 bucket create claude-code-releases
```

bucket 名称必须和 `wrangler.toml` 里的 `bucket_name` 一致：

```toml
[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "claude-code-releases"
```

`CLAUDE_RELEASES` 是 Worker 代码里使用的绑定名。如果要改这个名字，也要同步修改 `src/index.js`。

## 2. 配置 R2 下载域名

在 Cloudflare 控制台给 R2 bucket 绑定自定义域名：

```text
R2 -> claude-code-releases -> Settings -> Custom Domains -> Connect Domain
```

例如使用：

```text
download.example.com
```

Cloudflare 会创建或管理一条类似这样的 DNS：

```text
CNAME download.example.com -> public.r2.dev
```

这条记录保持开启代理。

当前线上使用的是：

```text
download.beiapi.cn
```

## 3. 配置 Worker 路由

选择一个 Worker 入口域名，用来提供安装脚本和管理接口，例如：

```text
claude.example.com
```

在 `wrangler.toml` 里配置 route：

```toml
routes = [
  { pattern = "claude.example.com/*", zone_name = "example.com" }
]
```

当前线上使用的是：

```toml
routes = [
  { pattern = "claude.beiapi.cn/*", zone_name = "beiapi.cn" }
]
```

## 4. 配置 Worker 变量

编辑 `wrangler.toml`，把下面这些值改成你自己的域名和账号：

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

变量说明：

- `PUBLIC_BASE_URL`：Worker 公开访问域名。
- `DOWNLOAD_BASE_URL`：R2 中 Claude Code release 前缀，用来读取 `latest`。
- `R2_BASE_URL`：R2 自定义域名根地址，用来下载 npm 包和 Node.js zip。
- `UPSTREAM_BASE_URL`：Claude Code 官方 release 源。
- `NPM_REGISTRY_BASE_URL`：npm 包元数据和 tarball 来源。
- `NODE_DIST_BASE_URL`：Node.js 官方下载源。
- `NODE_VERSION`：需要镜像的便携版 Node.js 版本。
- `PLATFORMS`：需要镜像的 Windows 平台。
- `PART_SIZE`：上传大 `.exe` 文件到 R2 时的分片大小。

## 5. 配置管理密钥

部署公开服务前必须设置 `ADMIN_TOKEN`：

```bash
wrangler secret put ADMIN_TOKEN
```

手动触发同步时需要带这个 token：

```bash
curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://claude.example.com/admin/sync
```

如果没有配置 `ADMIN_TOKEN`，`/admin/sync` 会变成公开接口。公开部署时不要让它处于未配置状态。

## 6. 部署 Worker

执行部署：

```bash
wrangler deploy
```

正常输出里应该能看到：

- Worker 名称：`agents-mirror`
- R2 绑定：`CLAUDE_RELEASES: claude-code-releases`
- Route：你的 Worker 域名路由
- Cron：`20 4 * * *`

## 7. 首次手动同步

第一次部署后，建议手动触发一次同步：

```bash
curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://claude.example.com/admin/sync
```

检查状态：

```bash
curl -s https://claude.example.com/admin/status
```

返回格式类似：

```json
{
  "ok": true,
  "latest": "2.1.133",
  "publicBaseUrl": "https://claude.example.com",
  "downloadBaseUrl": "https://download.example.com/claude-code-releases",
  "platforms": ["win32-x64", "win32-arm64"]
}
```

## 8. 验证 R2 下载

检查 `latest`：

```bash
curl -s https://download.example.com/claude-code-releases/latest
```

检查 HTTP 头：

```bash
curl -I https://download.example.com/claude-code-releases/latest
curl -I https://download.example.com/claude-code-releases/2.1.133/manifest.json
```

其中 `2.1.133` 要替换成 `latest` 返回的当前版本号。

## 9. 验证安装脚本

检查脚本里生成的下载地址和环境变量：

```bash
curl -s https://claude.example.com/install.ps1 |
  grep -E 'DOWNLOAD_BASE_URL|R2_BASE_URL|ANTHROPIC_BASE_URL|DISABLE_AUTOUPDATER'
```

Windows 直接安装：

```powershell
irm https://claude.example.com/install.ps1 | iex
```

Windows 安装并写入 API Key：

```powershell
& ([scriptblock]::Create((irm https://claude.example.com/install.ps1))) -ApiKey "YOUR_API_KEY"
```

Windows 卸载：

```powershell
irm https://claude.example.com/uninstall.ps1 | iex
```

## 当前 beiapi.cn 线上配置

当前线上部署使用的是：

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

## 常用维护命令

使用本地 API token 文件部署：

```bash
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler deploy
```

轮换 `ADMIN_TOKEN`：

```bash
CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)" npx wrangler secret put ADMIN_TOKEN
```

用 Cloudflare API 列出 R2 对象：

```bash
curl -sS -H "Authorization: Bearer $(cat /root/.cloudflare-api-token)" \
  "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/r2/buckets/claude-code-releases/objects?per_page=100" |
  jq -r '.result[] | [.key, .size, .last_modified] | @tsv'
```

## 清理逻辑

同步成功后，Worker 会删除旧版本 release 目录：

```text
claude-code-releases/{old_version}/
```

当前 Worker 会保留历史 npm 和 Node.js 对象：

```text
npm/
node/
```

如果你希望 npm 或 Node.js 历史版本也自动清理，需要在 Worker 中额外加入清理逻辑。

## 安全注意事项

- 不要提交 Cloudflare API Token。
- 不要提交 `.dev.vars`、`.env` 或本地 admin token 文件。
- 公开暴露 `/admin/sync` 前必须配置 `ADMIN_TOKEN`。
- 如果 API Key 出现在日志、聊天、截图或公开 issue 中，应立即吊销并重新生成。
