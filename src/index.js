const DEFAULT_UPSTREAM = "https://downloads.claude.ai/claude-code-releases";
const DEFAULT_PUBLIC_BASE = "https://claude.beiapi.cn";
const DEFAULT_DOWNLOAD_BASE = "https://download.beiapi.cn/claude-code-releases";
const DEFAULT_R2_BASE = "https://download.beiapi.cn";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_NODE_DIST = "https://nodejs.org/dist";
const DEFAULT_NODE_VERSION = "v24.15.0";
const DEFAULT_PLATFORMS = ["win32-x64", "win32-arm64"];
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/claude" || url.pathname === "/claude/") {
      return new Response("Claude Code mirror is online.\n", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }

    if (url.pathname === "/install.ps1" || url.pathname === "/claude/install.ps1") {
      return new Response(renderInstallScript(env), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/uninstall.ps1" || url.pathname === "/claude/uninstall.ps1") {
      return new Response(renderUninstallScript(), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/admin/status") {
      return json(await status(env));
    }

    if (url.pathname === "/admin/sync") {
      const auth = request.headers.get("authorization") || "";
      if (env.ADMIN_TOKEN && auth !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      const result = await syncLatest(env);
      return json(result);
    }

    if (url.pathname.startsWith("/claude-code-releases/")) {
      return serveR2Object(env, url.pathname.slice(1), request);
    }

    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncLatest(env));
  },
};

async function serveR2Object(env, key, request) {
  const rangeHeader = request.headers.get("range");
  const getOptions = { onlyIf: request.headers };
  if (rangeHeader) {
    getOptions.range = request.headers;
  }

  const object = await env.CLAUDE_RELEASES.get(key, getOptions);

  if (!object) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-length", object.size.toString());

  if (key === "claude-code-releases/latest") {
    headers.set("cache-control", "public, max-age=60");
    headers.set("content-type", "text/plain; charset=utf-8");
  } else if (key.endsWith("/manifest.json")) {
    headers.set("cache-control", "public, max-age=300");
    headers.set("content-type", "application/json; charset=utf-8");
  } else if (key.endsWith("/claude.exe")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", "attachment; filename=\"claude.exe\"");
  }

  if (rangeHeader && object.range) {
    const start = object.range.offset || 0;
    const end = typeof object.range.end === "number" ? object.range.end : object.size;
    headers.set("content-range", `bytes ${start}-${end - 1}/${object.size}`);
    headers.set("content-length", (end - start).toString());
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}

async function syncLatest(env) {
  const upstreamBase = env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM;
  const platforms = parsePlatforms(env.PLATFORMS);
  const latest = (await fetchText(`${upstreamBase}/latest`)).trim();

  if (!/^\d+\.\d+\.\d+(-[^\s]+)?$/.test(latest)) {
    throw new Error(`Unexpected latest version: ${latest}`);
  }

  const manifestText = await fetchText(`${upstreamBase}/${latest}/manifest.json`);
  const manifest = JSON.parse(manifestText);
  const uploaded = [];
  const skipped = [];
  const npm = await syncNpmPackages(env, latest, platforms);
  const node = await syncNodeZips(env, platforms);

  for (const platform of platforms) {
    const info = manifest.platforms?.[platform];
    if (!info?.checksum || !info?.size) {
      throw new Error(`Missing manifest entry for ${platform}`);
    }

    const key = `claude-code-releases/${latest}/${platform}/claude.exe`;
    const existing = await env.CLAUDE_RELEASES.head(key);
    if (
      existing &&
      existing.size === info.size &&
      existing.customMetadata?.sha256 === info.checksum &&
      existing.customMetadata?.version === latest
    ) {
      skipped.push(platform);
      continue;
    }

    await multipartCopyToR2(env, {
      key,
      url: `${upstreamBase}/${latest}/${platform}/claude.exe`,
      size: info.size,
      checksum: info.checksum,
      version: latest,
      partSize: parseInt(env.PART_SIZE || `${DEFAULT_PART_SIZE}`, 10),
    });
    uploaded.push(platform);
  }

  await env.CLAUDE_RELEASES.put(`claude-code-releases/${latest}/manifest.json`, manifestText, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=300",
    },
    customMetadata: {
      version: latest,
      upstream: `${upstreamBase}/${latest}/manifest.json`,
    },
  });

  await env.CLAUDE_RELEASES.put("claude-code-releases/latest", `${latest}\n`, {
    httpMetadata: {
      contentType: "text/plain; charset=utf-8",
      cacheControl: "public, max-age=60",
    },
    customMetadata: {
      version: latest,
      upstream: `${upstreamBase}/latest`,
    },
  });

  const deleted = await deleteOldVersions(env, latest);
  return { ok: true, latest, uploaded, skipped, npm, node, deleted, syncedAt: new Date().toISOString() };
}

async function syncNpmPackages(env, version, platforms) {
  const registry = env.NPM_REGISTRY_BASE_URL || DEFAULT_NPM_REGISTRY;
  const packages = ["@anthropic-ai/claude-code"];
  for (const platform of platforms) {
    packages.push(`@anthropic-ai/claude-code-${platform}`);
  }

  const results = [];
  for (const name of packages) {
    const encoded = encodeURIComponent(name).replace("%40", "@");
    const meta = await fetchJson(`${registry}/${encoded}/${version}`);
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity || "";
    const shasum = meta.dist?.shasum || "";
    if (!tarball) throw new Error(`Missing npm tarball for ${name}@${version}`);

    const fileName = tarball.split("/").pop();
    const key = `npm/${version}/${fileName}`;
    const existing = await env.CLAUDE_RELEASES.head(key);
    if (existing?.customMetadata?.integrity === integrity && existing?.customMetadata?.package === name) {
      results.push({ package: name, key, status: "skipped" });
      continue;
    }

    await copyUrlToR2(env, {
      key,
      url: tarball,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { package: name, version, integrity, shasum, upstream: tarball },
    });
    results.push({ package: name, key, status: "uploaded" });
  }

  await env.CLAUDE_RELEASES.put(`npm/${version}/manifest.json`, JSON.stringify(results, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "public, max-age=300" },
    customMetadata: { version },
  });

  return results;
}

async function syncNodeZips(env, platforms) {
  const nodeVersion = env.NODE_VERSION || DEFAULT_NODE_VERSION;
  const nodeDist = env.NODE_DIST_BASE_URL || DEFAULT_NODE_DIST;
  const archMap = { "win32-x64": "win-x64", "win32-arm64": "win-arm64" };
  const results = [];

  for (const platform of platforms) {
    const nodeArch = archMap[platform];
    if (!nodeArch) continue;
    const fileName = `node-${nodeVersion}-${nodeArch}.zip`;
    const url = `${nodeDist}/${nodeVersion}/${fileName}`;
    const key = `node/${nodeVersion}/${fileName}`;
    const existing = await env.CLAUDE_RELEASES.head(key);
    if (existing?.customMetadata?.nodeVersion === nodeVersion) {
      results.push({ platform, key, status: "skipped" });
      continue;
    }
    await copyUrlToR2(env, {
      key,
      url,
      contentType: "application/zip",
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { platform, nodeVersion, upstream: url },
    });
    results.push({ platform, key, status: "uploaded" });
  }

  await env.CLAUDE_RELEASES.put("node/latest", `${nodeVersion}\n`, {
    httpMetadata: { contentType: "text/plain; charset=utf-8", cacheControl: "public, max-age=3600" },
    customMetadata: { nodeVersion },
  });

  return results;
}

async function copyUrlToR2(env, options) {
  const response = await fetch(options.url, {
    headers: { "user-agent": "beiapi-claude-code-r2-mirror/1.0" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${options.url}: ${response.status}`);
  }

  await env.CLAUDE_RELEASES.put(options.key, response.body, {
    httpMetadata: {
      contentType: options.contentType,
      cacheControl: options.cacheControl,
    },
    customMetadata: options.metadata,
  });
}

async function multipartCopyToR2(env, options) {
  const upload = await env.CLAUDE_RELEASES.createMultipartUpload(options.key, {
    httpMetadata: {
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
      contentDisposition: 'attachment; filename="claude.exe"',
    },
    customMetadata: {
      sha256: options.checksum,
      version: options.version,
      upstream: options.url,
    },
  });

  const uploadedParts = [];
  let partNumber = 1;
  let total = 0;

  try {
    for (let start = 0; start < options.size; start += options.partSize) {
      const end = Math.min(start + options.partSize, options.size) - 1;
      const response = await fetch(options.url, {
        headers: {
          "user-agent": "beiapi-claude-code-r2-mirror/1.0",
          range: `bytes=${start}-${end}`,
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      if (response.status !== 206 && !(start === 0 && end + 1 === options.size && response.status === 200)) {
        throw new Error(`Failed to fetch range ${start}-${end} for ${options.key}: ${response.status}`);
      }

      const expectedPartSize = end - start + 1;
      const part = await response.arrayBuffer();
      if (part.byteLength !== expectedPartSize) {
        throw new Error(`Unexpected part size for ${options.key} part ${partNumber}: expected ${expectedPartSize}, got ${part.byteLength}`);
      }

      uploadedParts.push(await upload.uploadPart(partNumber++, part));
      total += part.byteLength;
    }

    if (total !== options.size) {
      throw new Error(`Unexpected downloaded size for ${options.key}: expected ${options.size}, got ${total}`);
    }

    await upload.complete(uploadedParts);
  } catch (error) {
    await upload.abort();
    throw error;
  }
}

async function deleteOldVersions(env, keepVersion) {
  const prefix = "claude-code-releases/";
  const keys = [];
  let cursor;

  do {
    const listed = await env.CLAUDE_RELEASES.list({ prefix, cursor });
    for (const object of listed.objects) {
      const relative = object.key.slice(prefix.length);
      const version = relative.split("/", 1)[0];
      if (version && version !== "latest" && version !== keepVersion) {
        keys.push(object.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  for (let i = 0; i < keys.length; i += 1000) {
    await env.CLAUDE_RELEASES.delete(keys.slice(i, i + 1000));
  }

  return keys.length;
}

async function status(env) {
  const latestObj = await env.CLAUDE_RELEASES.get("claude-code-releases/latest");
  const latest = latestObj ? (await latestObj.text()).trim() : null;
  return {
    ok: true,
    latest,
    publicBaseUrl: env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE,
    downloadBaseUrl: env.DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE,
    platforms: parsePlatforms(env.PLATFORMS),
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "beiapi-claude-code-r2-mirror/1.0" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function parsePlatforms(value) {
  if (!value) return DEFAULT_PLATFORMS;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function renderInstallScript(env) {
  const downloadBase = env.DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE;
  const r2Base = env.R2_BASE_URL || DEFAULT_R2_BASE;
  const nodeVersion = env.NODE_VERSION || DEFAULT_NODE_VERSION;
  return String.raw`param(
    [Parameter()]
    [string]$BaseUrl = "https://api.beiapi.cn",

    [Parameter()]
    [string]$ApiKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = 'Continue'

if (-not [Environment]::Is64BitProcess) {
    Write-Error "Claude Code does not support 32-bit Windows. Please use a 64-bit version of Windows."
    exit 1
}

$DOWNLOAD_BASE_URL = "${downloadBase}"
$R2_BASE_URL = "${r2Base}"
$NODE_VERSION = "${nodeVersion}"
$DOWNLOAD_DIR = "$env:USERPROFILE\.claude\downloads"
$NODE_ROOT = "$env:USERPROFILE\.claude\node"
$NPM_PREFIX = "$env:USERPROFILE\.claude\local"
$CLAUDE_BASE_URL = $BaseUrl.TrimEnd('/')

if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    $platform = "win32-arm64"
} else {
    $platform = "win32-x64"
}

New-Item -ItemType Directory -Force -Path $DOWNLOAD_DIR | Out-Null

Write-Output "Checking latest Claude Code version from mirror..."
$version = (Invoke-RestMethod -Uri "$DOWNLOAD_BASE_URL/latest" -ErrorAction Stop).ToString().Trim()

Write-Output "Latest version: $version"

Write-Output "Preparing Node.js portable runtime..."
if ($platform -eq "win32-arm64") {
    $nodeArch = "win-arm64"
} else {
    $nodeArch = "win-x64"
}
$nodeDir = "$NODE_ROOT\node-$NODE_VERSION-$nodeArch"
$nodeZip = "$DOWNLOAD_DIR\node-$NODE_VERSION-$nodeArch.zip"
$nodeUri = "$R2_BASE_URL/node/$NODE_VERSION/node-$NODE_VERSION-$nodeArch.zip"

if (-not (Test-Path "$nodeDir\node.exe")) {
    New-Item -ItemType Directory -Force -Path $NODE_ROOT | Out-Null
    if (Test-Path $nodeZip) {
        Remove-Item -Force $nodeZip
    }
    Write-Output "Downloading Node.js from $nodeUri"
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -4 -L --fail --progress-bar $nodeUri -o $nodeZip
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "curl.exe failed with exit code $LASTEXITCODE; falling back to Invoke-WebRequest."
            Invoke-WebRequest -Uri $nodeUri -OutFile $nodeZip -ErrorAction Stop
        }
    } else {
        Invoke-WebRequest -Uri $nodeUri -OutFile $nodeZip -ErrorAction Stop
    }
    Write-Output "Extracting Node.js..."
    Expand-Archive -Path $nodeZip -DestinationPath $NODE_ROOT -Force
}

$env:Path = "$nodeDir;$nodeDir\node_modules\npm\bin;$env:Path"
$nodeExe = "$nodeDir\node.exe"
$npmCmd = "$nodeDir\npm.cmd"

if (-not (Test-Path $nodeExe) -or -not (Test-Path $npmCmd)) {
    Write-Error "Node.js portable runtime was not installed correctly."
    exit 1
}

Write-Output "Installing Claude Code npm packages..."
New-Item -ItemType Directory -Force -Path $NPM_PREFIX | Out-Null
$wrapperTgz = "$R2_BASE_URL/npm/$version/claude-code-$version.tgz"
if ($platform -eq "win32-arm64") {
    $nativeTgz = "$R2_BASE_URL/npm/$version/claude-code-win32-arm64-$version.tgz"
} else {
    $nativeTgz = "$R2_BASE_URL/npm/$version/claude-code-win32-x64-$version.tgz"
}

& $npmCmd install -g --prefix $NPM_PREFIX --omit=optional $nativeTgz $wrapperTgz
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$binDir = "$NPM_PREFIX\bin"
$cmdDir = "$NPM_PREFIX"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) {
    $userPath = ""
}
if ($userPath -notlike "*$cmdDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$cmdDir;$userPath", "User")
    Write-Output "Added Claude Code npm prefix to user PATH: $cmdDir"
}
$env:Path = "$cmdDir;$env:Path"

function Set-JsonProperty($obj, $name, $value) {
    if (Test-JsonProperty $obj $name) {
        $obj.$name = $value
    } else {
        $obj | Add-Member -MemberType NoteProperty -Name $name -Value $value
    }
}

function Test-JsonProperty($obj, $name) {
    return $null -ne $obj -and $obj.PSObject.Properties.Match($name).Count -gt 0
}

$settingsDir = "$env:USERPROFILE\.claude"
$settingsPath = "$settingsDir\settings.json"
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null

if (Test-Path $settingsPath) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$settingsPath.bak-$timestamp"
    Copy-Item -Path $settingsPath -Destination $backupPath -Force
    Write-Output "Backed up existing settings to $backupPath"

    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    }
    catch {
        Write-Error "Existing settings.json is not valid JSON. Backup was created at $backupPath. Claude Code was installed, but settings were not changed."
        exit 1
    }
} else {
    $settings = [PSCustomObject]@{}
}

if (-not (Test-JsonProperty $settings "env") -or $null -eq $settings.env) {
    Set-JsonProperty $settings "env" ([PSCustomObject]@{})
}

Set-JsonProperty $settings.env "ANTHROPIC_BASE_URL" $CLAUDE_BASE_URL
Set-JsonProperty $settings.env "DISABLE_AUTOUPDATER" "1"

if ($ApiKey) {
    Set-JsonProperty $settings.env "ANTHROPIC_API_KEY" $ApiKey
}

$settings | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsPath -Encoding UTF8

if (Test-Path $DOWNLOAD_DIR) {
    Remove-Item -Recurse -Force $DOWNLOAD_DIR
    Write-Output "Cleaned installer downloads: $DOWNLOAD_DIR"
}

Write-Output ""
Write-Output "Claude Code installation complete."
Write-Output "Base URL configured: $CLAUDE_BASE_URL"
if ($ApiKey) {
    Write-Output "API key configured."
} else {
    Write-Output "API key was not provided; existing key, if any, was left unchanged."
}
Write-Output ""
`;
}

function renderUninstallScript() {
  return String.raw`param(
    [Parameter()]
    [switch]$RemoveSettings,

    [Parameter()]
    [switch]$RemoveBackups
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CLAUDE_DIR = "$env:USERPROFILE\.claude"
$DOWNLOAD_DIR = "$CLAUDE_DIR\downloads"
$NODE_ROOT = "$CLAUDE_DIR\node"
$NPM_PREFIX = "$CLAUDE_DIR\local"
$settingsPath = "$CLAUDE_DIR\settings.json"

Write-Output "Uninstalling Claude Code local installation..."

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
    $parts = $userPath -split ';' | Where-Object {
        $_ -and
        ($_.TrimEnd('\') -ne $NPM_PREFIX.TrimEnd('\')) -and
        ($_.TrimEnd('\') -ne "$NPM_PREFIX\bin".TrimEnd('\'))
    }
    $newPath = ($parts -join ';')
    if ($newPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Output "Removed Claude Code paths from user PATH."
    }
}

foreach ($path in @($NPM_PREFIX, $NODE_ROOT, $DOWNLOAD_DIR)) {
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
        Write-Output "Removed $path"
    }
}

if ($RemoveSettings) {
    if (Test-Path $settingsPath) {
        Remove-Item -Force $settingsPath
        Write-Output "Removed $settingsPath"
    }
} else {
    Write-Output "Kept settings: $settingsPath"
}

if ($RemoveBackups) {
    Get-ChildItem -Path $CLAUDE_DIR -Filter "settings.json.bak-*" -ErrorAction SilentlyContinue | Remove-Item -Force
    Write-Output "Removed settings backups."
} else {
    Write-Output "Kept settings backups."
}

Write-Output ""
Write-Output "Uninstall complete. Open a new terminal for PATH changes to take effect."
`;
}
