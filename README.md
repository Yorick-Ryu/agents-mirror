# 国内环境下 Windows 一键安装 Claude Code 脚本及部署教程

Agents Mirror 是一个基于 Cloudflare Worker + R2 的 AI 编程 Agent 工具镜像服务。

目前支持状态：仅支持 Windows 版 Claude Code。

## 一、使用我们部署好的脚本

以下命令在 Windows PowerShell 中运行。

### 安装

直接安装：

```powershell
irm https://claude.beiapi.cn/install.ps1 | iex
```

安装并写入 API Key：

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/install.ps1))) -ApiKey "YOUR_API_KEY"
```

安装并同时指定自定义 Claude API Base URL 和 API Key：

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/install.ps1))) -BaseUrl "https://api.example.com" -ApiKey "YOUR_API_KEY"
```

`-BaseUrl` 可以省略。省略时默认写入：

```text
https://api.beiapi.cn
```

安装脚本会检测本机是否存在 Git for Windows。存在时直接复用；不存在时，从 R2 下载镜像的 Git for Windows 安装包并静默安装。Claude Code 官方推荐 Windows 原生安装使用 Git for Windows，但当前没有明确 Git 版本下限，所以这里只检测是否存在。

安装脚本还会检测本机是否存在 `node >=18` 和 npm。满足要求时直接复用本机 Node.js/npm；不满足要求或找不到 npm 时，才从 R2 下载便携 Node.js。

如果检测到本机已有 Claude Code 配置，安装脚本会先备份原 `settings.json`，再写入新的配置。

### 升级

```powershell
irm https://claude.beiapi.cn/upgrade.ps1 | iex
```

升级脚本只会执行 npm 包升级，不会写入或修改 `settings.json`。如果当前 PowerShell 环境里找不到 `claude`、`node` 或 `npm`，或者 Node.js 版本低于 18，会直接报错退出。首次安装请使用 `install.ps1`。

### 卸载

卸载，保留配置：

```powershell
irm https://claude.beiapi.cn/uninstall.ps1 | iex
```

卸载并删除 `settings.json`：

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/uninstall.ps1))) -RemoveSettings
```

卸载并删除 `settings.json` 以及备份文件：

```powershell
& ([scriptblock]::Create((irm https://claude.beiapi.cn/uninstall.ps1))) -RemoveSettings -RemoveBackups
```

## 二、如何自己部署？

这一部分说明如何用 Cloudflare Worker + R2 自己搭建同样的镜像服务。

### 1. 前置条件

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

### 2. 创建 R2 Bucket

创建 Worker 使用的 R2 bucket：

```bash
wrangler r2 bucket create agents-mirror
```

bucket 名称必须和 `wrangler.toml` 里的 `bucket_name` 一致：

```toml
[[r2_buckets]]
binding = "CLAUDE_RELEASES"
bucket_name = "agents-mirror"
```

`CLAUDE_RELEASES` 是 Worker 代码里使用的绑定名。如果要改这个名字，也要同步修改 `src/index.js`。

### 3. 配置 R2 下载域名

在 Cloudflare 控制台给 R2 bucket 绑定自定义域名：

```text
R2 -> agents-mirror -> Settings -> Custom Domains -> Connect Domain
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

### 4. 配置 Worker 路由

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

### 5. 配置 Worker 变量

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
GIT_INSTALL_PAGE_URL = "https://git-scm.com/install/windows"
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

### 6. 配置管理密钥

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

### 7. 部署 Worker

执行部署：

```bash
wrangler deploy
```

正常输出里应该能看到：

- Worker 名称：`agents-mirror`
- R2 绑定：`CLAUDE_RELEASES: agents-mirror`
- Route：你的 Worker 域名路由
- Cron：`20 4 * * *`

### 8. 首次手动同步

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

### 9. 验证 R2 下载

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

### 10. 验证脚本

检查安装脚本：

```bash
curl -s https://claude.example.com/install.ps1 |
  grep -E 'DOWNLOAD_BASE_URL|R2_BASE_URL|ANTHROPIC_BASE_URL|DISABLE_AUTOUPDATER|MIN_NODE_MAJOR'
```

检查升级脚本：

```bash
curl -s https://claude.example.com/upgrade.ps1 |
  grep -E 'Get-RequiredCommand|MIN_NODE_MAJOR|Upgrading Claude Code npm packages'
```

检查卸载脚本：

```bash
curl -s https://claude.example.com/uninstall.ps1 |
  grep -E 'RemoveSettings|RemoveBackups|Uninstall'
```

### 11. R2 文件结构

R2 里存放的镜像文件结构：

```text
claude-code-releases/latest
claude-code-releases/{version}/manifest.json
claude-code-releases/{version}/win32-x64/claude.exe
claude-code-releases/{version}/win32-arm64/claude.exe
npm/{version}/*.tgz
npm/{version}/manifest.json
node/{node_version}/*.zip
node/latest
git/{git_version}/Git-*.exe
git/latest
```

### 12. 清理逻辑

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

### 13. 安全注意事项

- 不要提交 Cloudflare API Token。
- 不要提交 `.dev.vars`、`.env` 或本地 admin token 文件。
- 公开暴露 `/admin/sync` 前必须配置 `ADMIN_TOKEN`。
- 如果 API Key 出现在日志、聊天、截图或公开 issue 中，应立即吊销并重新生成。
