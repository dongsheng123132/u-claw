# ============================================================
# U-Claw Installer (Windows PowerShell)
# Usage: irm https://u-claw.org/install.ps1 | iex
#    or: powershell -ExecutionPolicy Bypass -File install.ps1
# ============================================================

# --- Encoding: must run BEFORE any output ---
Set-ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue
try {
    $null = cmd /c chcp 65001
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
} catch {}

$ErrorActionPreference = "Stop"

# ---- Constants ----
$UCLAW_DIR = "$env:USERPROFILE\.uclaw"
$RUNTIME_DIR = "$UCLAW_DIR\runtime"
$CORE_DIR = "$UCLAW_DIR\core"
$DATA_DIR = "$UCLAW_DIR\data"
$CONFIG_PATH = "$DATA_DIR\.openclaw\openclaw.json"
$NODE_VERSION = "v22.16.0"
$MIRROR = "https://registry.npmmirror.com"
$NODE_MIRROR = "https://npmmirror.com/mirrors/node"

# ---- Color helpers ----
function Write-Green($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Cyan($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Yellow($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Red($msg) { Write-Host $msg -ForegroundColor Red }

# ============================================================
# Step 1: Banner + System detection
# ============================================================
Clear-Host
Write-Host ""
Write-Cyan "  ==========================================="
Write-Cyan "    U-Claw - AI Assistant Installer (Windows)"
Write-Cyan "  ==========================================="
Write-Host ""

$ARCH = $env:PROCESSOR_ARCHITECTURE
if ($ARCH -eq "AMD64" -or $ARCH -eq "x86_64") {
    $PLATFORM = "win-x64"
    Write-Green "  System: Windows x64"
} elseif ($ARCH -eq "ARM64") {
    $PLATFORM = "win-arm64"
    Write-Green "  System: Windows ARM64"
} else {
    Write-Red "  Unsupported architecture: $ARCH"
    exit 1
}

Write-Host "  Install path: $UCLAW_DIR" -ForegroundColor Cyan
Write-Host ""

# Check existing install
if (Test-Path "$CORE_DIR\node_modules\openclaw") {
    Write-Yellow "  Found existing install: $UCLAW_DIR"
    $overwrite = Read-Host "  Overwrite? (y/n) [y]"
    if ($overwrite -eq "n" -or $overwrite -eq "N") {
        Write-Host "  Cancelled." -ForegroundColor DarkGray
        exit 0
    }
    Write-Host ""
}

# Create directories
New-Item -ItemType Directory -Force -Path $RUNTIME_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $CORE_DIR | Out-Null
New-Item -ItemType Directory -Force -Path "$DATA_DIR\.openclaw" | Out-Null
New-Item -ItemType Directory -Force -Path "$DATA_DIR\memory" | Out-Null
New-Item -ItemType Directory -Force -Path "$DATA_DIR\backups" | Out-Null

# ============================================================
# Step 2: Node.js
# ============================================================
Write-Host "  [1/6] Install Node.js $NODE_VERSION ..." -ForegroundColor White

$NODE_INSTALL_DIR = "$RUNTIME_DIR\node-$PLATFORM"
$INSTALL_NODE = ""
$NPM_CLI = ""
$USE_SYSTEM_NODE = $false

# Check system Node.js
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
    $sysVer = & node --version 2>$null
    $major = [int]($sysVer -replace 'v','').Split('.')[0]
    if ($major -ge 20) {
        Write-Green "  [OK] System Node.js $sysVer found, reusing"
        $INSTALL_NODE = "node"
        $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source
        $npmRoot = Split-Path (Split-Path $npmCmd)
        $NPM_CLI = "$npmRoot\node_modules\npm\bin\npm-cli.js"
        if (-not (Test-Path $NPM_CLI)) {
            $npmPrefix = & node -e "console.log(process.execPath.replace(/[\\\/]node\.exe$/i,''))" 2>$null
            $NPM_CLI = "$npmPrefix\node_modules\npm\bin\npm-cli.js"
        }
        $USE_SYSTEM_NODE = $true
    }
}

if (-not $USE_SYSTEM_NODE) {
    if (Test-Path "$NODE_INSTALL_DIR\node.exe") {
        Write-Green "  [OK] Node.js already exists, skip download"
        $INSTALL_NODE = "$NODE_INSTALL_DIR\node.exe"
        $NPM_CLI = "$NODE_INSTALL_DIR\node_modules\npm\bin\npm-cli.js"
    } else {
        Write-Cyan "  Downloading Node.js $NODE_VERSION ($PLATFORM)..."
        $zipName = "node-$NODE_VERSION-$PLATFORM.zip"
        $url = "$NODE_MIRROR/$NODE_VERSION/$zipName"
        $tempZip = "$env:TEMP\$zipName"
        $tempExtract = "$env:TEMP\node-extract-uclaw"

        Write-Host "    $url"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
        } catch {
            try {
                & curl.exe -# -L $url -o $tempZip
            } catch {
                Write-Red "  [FAIL] Download failed! Check your network."
                exit 1
            }
        }

        Write-Host "  Extracting..."
        if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
        Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
        $extractedDir = Get-ChildItem $tempExtract | Select-Object -First 1
        New-Item -ItemType Directory -Force -Path $NODE_INSTALL_DIR | Out-Null
        Copy-Item -Recurse -Force "$($extractedDir.FullName)\*" $NODE_INSTALL_DIR

        Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue

        if (Test-Path "$NODE_INSTALL_DIR\node.exe") {
            Write-Green "  [OK] Node.js installed"
            $INSTALL_NODE = "$NODE_INSTALL_DIR\node.exe"
            $NPM_CLI = "$NODE_INSTALL_DIR\node_modules\npm\bin\npm-cli.js"
        } else {
            Write-Red "  [FAIL] Node.js install failed"
            exit 1
        }
    }

    $env:PATH = "$NODE_INSTALL_DIR;$env:PATH"
}

Write-Host ""

# ============================================================
# Step 3: OpenClaw + QQ plugin (pre-bundled download)
# ============================================================
Write-Host "  [2/6] Install OpenClaw + QQ plugin ..." -ForegroundColor White

if (Test-Path "$CORE_DIR\node_modules\openclaw") {
    Write-Green "  [OK] OpenClaw already installed, skip"
} else {
    Write-Cyan "  Downloading pre-bundled package (no npm install needed)..."
    $BUNDLE_GITHUB_URL = "https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip"
    $BUNDLE_MIRRORS = @(
        "https://ghfast.top/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip",
        "https://ghproxy.net/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip",
        "https://gh.idayer.com/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip",
        $BUNDLE_GITHUB_URL
    )
    $bundleZip = "$env:TEMP\openclaw-bundle.zip"
    $downloaded = $false

    foreach ($mirrorUrl in $BUNDLE_MIRRORS) {
        Write-Host "    Trying: $mirrorUrl" -ForegroundColor DarkGray
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $mirrorUrl -OutFile $bundleZip -UseBasicParsing -TimeoutSec 120
            if (Test-Path $bundleZip) {
                $fileSize = (Get-Item $bundleZip).Length
                if ($fileSize -gt 1MB) {
                    Write-Host "    Downloaded ($([math]::Round($fileSize/1MB,1)) MB)" -ForegroundColor DarkGray
                    $downloaded = $true
                    break
                } else {
                    Write-Host "    File too small ($fileSize bytes), trying next..." -ForegroundColor DarkGray
                    Remove-Item -Force $bundleZip -ErrorAction SilentlyContinue
                }
            }
        } catch {
            Write-Host "    Failed: $($_.Exception.Message.Split([char]10)[0])" -ForegroundColor DarkGray
        }
    }

    if (-not $downloaded) {
        Write-Host "    Trying curl fallback..." -ForegroundColor DarkGray
        $curlMirrors = @(
            "https://ghfast.top/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip",
            "https://ghproxy.net/https://github.com/dongsheng123132/u-claw/releases/download/v1.0.0-bundle/openclaw-bundle.zip",
            $BUNDLE_GITHUB_URL
        )
        foreach ($curlUrl in $curlMirrors) {
            try {
                & curl.exe -L --max-time 120 --retry 2 $curlUrl -o $bundleZip 2>$null
                if (Test-Path $bundleZip) {
                    if ((Get-Item $bundleZip).Length -gt 1MB) { $downloaded = $true; break }
                }
            } catch {}
        }
    }

    if (-not $downloaded) {
        Write-Red "  [FAIL] Download failed! Check your network."
        Write-Yellow "  Manual download: $BUNDLE_GITHUB_URL"
        Write-Yellow "  Place file at: $bundleZip then re-run installer"
        exit 1
    }

    Write-Host "  Extracting..." -ForegroundColor Cyan
    $tempExtract = "$env:TEMP\openclaw-bundle-extract"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    Expand-Archive -Path $bundleZip -DestinationPath $tempExtract -Force
    New-Item -ItemType Directory -Force -Path $CORE_DIR | Out-Null
    Copy-Item -Recurse -Force "$tempExtract\*" $CORE_DIR

    Remove-Item -Force $bundleZip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue

    if (Test-Path "$CORE_DIR\node_modules\openclaw\openclaw.mjs") {
        Write-Green "  [OK] OpenClaw installed"
    } else {
        Write-Red "  [FAIL] OpenClaw install failed"
        exit 1
    }
}

# QQ plugin (included in bundle)
if (Test-Path "$CORE_DIR\node_modules\@sliverp\qqbot") {
    Write-Green "  [OK] QQ plugin included"
} else {
    Write-Yellow "  [WARN] QQ plugin not included (does not affect main features)"
}

Write-Host ""

# ============================================================
# Step 4: China-optimized skills (10 skills)
# ============================================================
Write-Host "  [3/6] Install China skills (10) ..." -ForegroundColor White

$SKILLS_TARGET = "$CORE_DIR\node_modules\openclaw\skills"
if (-not (Test-Path $SKILLS_TARGET)) { New-Item -ItemType Directory -Force -Path $SKILLS_TARGET | Out-Null }

$skillCount = 0

$skills = @{
    "bilibili-helper" = @'
---
name: bilibili-helper
description: "Bilibili content helper - video title, tags, cover design, category selection"
metadata: { "openclaw": { "emoji": "TV" } }
---

# Bilibili Content Helper

Optimize video titles, descriptions, tags and covers for better recommendations on Bilibili.

## Title formulas

1. Question: "Why XX? You'll understand after watching"
2. Tutorial: "XX Tutorial | Step by step from scratch"
3. Review: "Spent XX yuan on XX, is it worth it?"
4. Challenge: "Challenge XX days using only XX"
5. Ranking: "Top 10 XX of the year"
'@

    "china-search" = @'
---
name: china-search
description: "China search engines - Baidu, Sogou, Bing China search"
metadata: { "openclaw": { "emoji": "search" } }
---

# China Search Engine Helper

Search via Baidu, Sogou, Bing China using curl.

## Commands

```bash
curl -s -L "https://www.baidu.com/s?wd=keyword" -H "User-Agent: Mozilla/5.0"
curl -s -L "https://weixin.sogou.com/weixin?query=keyword" -H "User-Agent: Mozilla/5.0"
curl -s -L "https://cn.bing.com/search?q=keyword" -H "User-Agent: Mozilla/5.0"
```
'@

    "china-translate" = @'
---
name: china-translate
description: "CN-EN translation - tech docs, UI localization, cultural adaptation"
metadata: { "openclaw": { "emoji": "globe" } }
---

# CN-EN Translation Helper

Professional Chinese-English bidirectional translation for tech docs and product localization.

## Common terms

| English | Chinese |
|---------|---------|
| Deploy | Bu Shu |
| Repository | Cang Ku |
| Container | Rong Qi |
| Middleware | Zhong Jian Jian |
| Token | Token / Ling Pai |
| Prompt | Ti Shi Ci |
'@

    "china-weather" = @'
---
name: china-weather
description: "China city weather query - supports Chinese city names, wttr.in API"
metadata: { "openclaw": { "emoji": "sun" } }
---

# China Weather Query

```bash
curl -s "wttr.in/Shenzhen?lang=zh"
curl -s "wttr.in/Beijing?format=j1"
```
'@

    "deepseek-helper" = @'
---
name: deepseek-helper
description: "DeepSeek API helper - model selection, API guide, pricing info"
metadata: { "openclaw": { "emoji": "robot" } }
---

# DeepSeek API Helper

## Models

| Model | Use case | Context |
|-------|----------|---------|
| deepseek-chat | Daily chat | 32K |
| deepseek-coder | Code generation | 16K |
| deepseek-reasoner | Complex reasoning | 64K |

- OpenAI-compatible API, base_url: https://api.deepseek.com
- Direct access in China, API Key: https://platform.deepseek.com
'@

    "douyin-script" = @'
---
name: douyin-script
description: "Douyin/Kuaishou short video script - hook, structure, hashtag strategy"
metadata: { "openclaw": { "emoji": "video" } }
---

# Douyin/Kuaishou Script Helper

## First 3-second Hook formulas

1. Counter-intuitive: "What you've been doing is actually wrong"
2. Number shock: "Only 100 yuan but better than 1000 yuan"
3. Suspense: "Guess what this is for?"
4. Emotional: "Workers fell silent after watching..."
5. Result first: "The final result is amazing!"

## Hashtags: large + medium + small topics, 5-8 total
## Best time: 7-9am, 12-2pm, 6-10pm
'@

    "wechat-article" = @'
---
name: wechat-article
description: "WeChat article writing - structure, formatting, conversion optimization"
metadata: { "openclaw": { "emoji": "green" } }
---

# WeChat Article Writing Helper

## Formatting rules

- Body font 15-16px, line height 1.75-2x
- Body color #3f3f3f, accent #007AFF
- 3-5 lines per paragraph, 1 image per 300 chars
- Title under 30 chars, first 15 chars must catch attention
'@

    "weibo-poster" = @'
---
name: weibo-poster
description: "Weibo content creation - 140-char optimization, trending topics, images"
metadata: { "openclaw": { "emoji": "red" } }
---

# Weibo Content Helper

## 140-char tips: Write then trim, one point per post, end with golden quote
## Images: 1 for highlight / 3 for comparison / 6 for narrative / 9 for grid
## Timing: Weekday lunch + after work, Weekend morning + evening
'@

    "xiaohongshu-writer" = @'
---
name: xiaohongshu-writer
description: "Xiaohongshu note writer - title optimization, emoji strategy, hashtags"
metadata: { "openclaw": { "emoji": "book" } }
---

# Xiaohongshu Note Writer

## Title formulas

1. Numbers: "5 ways / 10 types / under 100 yuan"
2. Contrast: "3K salary vs 30K salary"
3. Review: "Personally tested, really works!"
4. Collection: "XX Collection | All in one post"

## Tips: Max 3 lines per paragraph, 1-2 emoji per paragraph, 3-8 hashtags
'@

    "zhihu-writer" = @'
---
name: zhihu-writer
description: "Zhihu answer/article writing - structure, professional tone, citations"
metadata: { "openclaw": { "emoji": "pen" } }
---

# Zhihu Writing Helper

## Answer structure: Conclusion first -> Point-by-point -> Summary
## Style: Confident not arrogant, professional but accessible
## Quality: 500-3000 chars, original, reply to comments, focus on 2-3 topics
'@
}

foreach ($skillName in $skills.Keys) {
    $skillDir = "$SKILLS_TARGET\$skillName"
    if (-not (Test-Path $skillDir)) {
        New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
        [IO.File]::WriteAllText("$skillDir\SKILL.md", $skills[$skillName], (New-Object System.Text.UTF8Encoding $false))
        $skillCount++
    }
}

Write-Green "  [OK] China skills installed (+$skillCount)"
Write-Host ""

# ============================================================
# Step 5: Model configuration
# ============================================================
Write-Host "  [4/6] Configure AI model ..." -ForegroundColor White
Write-Host ""

$hasConfig = (Test-Path $CONFIG_PATH) -and (Select-String -Path $CONFIG_PATH -Pattern "apiKey" -Quiet -ErrorAction SilentlyContinue)

if ($hasConfig) {
    Write-Green "  [OK] Model already configured, skip"
} else {
    Write-Host "  Select AI model:" -ForegroundColor White
    Write-Host ""
    Write-Host "  -- China (direct access, no VPN) --" -ForegroundColor White
    Write-Host "  1) DeepSeek      ** Recommended **" -ForegroundColor Green
    Write-Host "  2) Kimi (Moonshot)"
    Write-Host "  3) Qwen (Alibaba)"
    Write-Host "  4) GLM (Zhipu)"
    Write-Host "  5) MiniMax"
    Write-Host "  6) Doubao (Volcengine)"
    Write-Host "  7) SiliconFlow"
    Write-Host ""
    Write-Host "  -- International --" -ForegroundColor White
    Write-Host "  8) Claude    9) GPT"
    Write-Host ""
    Write-Host "  -- Local --" -ForegroundColor White
    Write-Host "  10) Ollama (local model)"
    Write-Host ""

    $choice = Read-Host "  Enter number [1]"
    if ([string]::IsNullOrEmpty($choice)) { $choice = "1" }

    $modelConfigs = @{
        "1"  = @{ model="deepseek-chat"; baseUrl="https://api.deepseek.com/v1"; provider="custom"; label="DeepSeek API Key"; hint="Get key: https://platform.deepseek.com/api_keys"; needKey=$true }
        "2"  = @{ model="moonshot-v1-auto"; baseUrl="https://api.moonshot.cn/v1"; provider="custom"; label="Moonshot API Key"; hint="Get key: https://platform.moonshot.cn/console/api-keys"; needKey=$true }
        "3"  = @{ model="qwen-plus"; baseUrl="https://dashscope.aliyuncs.com/compatible-mode/v1"; provider="custom"; label="Qwen API Key"; hint="Get key: https://dashscope.console.aliyun.com/apiKey (free quota available)"; needKey=$true }
        "4"  = @{ model="glm-4-plus"; baseUrl="https://open.bigmodel.cn/api/paas/v4"; provider="custom"; label="Zhipu API Key"; hint="Get key: https://open.bigmodel.cn/usercenter/apikeys"; needKey=$true }
        "5"  = @{ model="abab6.5s-chat"; baseUrl="https://api.minimax.chat/v1"; provider="custom"; label="MiniMax API Key"; hint="Get key: https://platform.minimaxi.com/"; needKey=$true }
        "6"  = @{ model="doubao-pro-256k"; baseUrl="https://ark.cn-beijing.volces.com/api/v3"; provider="custom"; label="Volcengine API Key"; hint="Get key: https://console.volcengine.com/ark"; needKey=$true }
        "7"  = @{ model="deepseek-ai/DeepSeek-V3"; baseUrl="https://api.siliconflow.cn/v1"; provider="custom"; label="SiliconFlow API Key"; hint="Get key: https://cloud.siliconflow.cn/account/ak"; needKey=$true }
        "8"  = @{ model="claude-sonnet-4-20250514"; baseUrl=""; provider="anthropic"; label="Anthropic API Key"; hint="Get key: https://console.anthropic.com/settings/keys (VPN required)"; needKey=$true }
        "9"  = @{ model="gpt-4o"; baseUrl=""; provider="openai"; label="OpenAI API Key"; hint="Get key: https://platform.openai.com/api-keys (VPN required)"; needKey=$true }
        "10" = @{ model="llama3.2"; baseUrl="http://127.0.0.1:11434/v1"; provider="custom"; label=""; hint="Install Ollama first (https://ollama.com), then: ollama run llama3.2"; needKey=$false }
    }

    $cfg = $modelConfigs[$choice]
    if (-not $cfg) {
        Write-Yellow "  Unknown option, using DeepSeek"
        $cfg = $modelConfigs["1"]
    }

    Write-Host ""
    Write-Cyan "  $($cfg.hint)"
    Write-Host ""

    $apiKey = ""
    if ($cfg.needKey) {
        $apiKey = Read-Host "  Enter $($cfg.label)"
        if ([string]::IsNullOrEmpty($apiKey)) {
            Write-Yellow "  [WARN] No API Key entered. You can configure later via Config.html"
        }
    }

    # Write config
    if ($cfg.provider -eq "custom" -and $cfg.baseUrl) {
        $configJson = @"
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$($cfg.model)",
    "apiKey": "$apiKey",
    "baseUrl": "$($cfg.baseUrl)"
  }
}
"@
    } else {
        $configJson = @"
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "agent": {
    "model": "$($cfg.model)",
    "apiKey": "$apiKey",
    "provider": "$($cfg.provider)"
  }
}
"@
    }

    [IO.File]::WriteAllText($CONFIG_PATH, $configJson, (New-Object System.Text.UTF8Encoding $false))
    Write-Green "  [OK] Model configured: $($cfg.model)"
}

Write-Host ""

# ============================================================
# Step 6: Generate start scripts
# ============================================================
Write-Host "  [5/6] Generate start scripts ..." -ForegroundColor White

$startBat = @'
@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title U-Claw

set "DIR=%~dp0"
set "NODE_BIN=%DIR%runtime\node-win-x64\node.exe"
if not exist "%NODE_BIN%" set "NODE_BIN=node"

set "OPENCLAW_MJS=%DIR%core\node_modules\openclaw\openclaw.mjs"
set "OPENCLAW_HOME=%DIR%data"
set "OPENCLAW_STATE_DIR=%DIR%data\.openclaw"
set "OPENCLAW_CONFIG_PATH=%DIR%data\.openclaw\openclaw.json"

REM Find available port
set PORT=18789
:check_port
netstat -an | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    set /a PORT+=1
    if !PORT! gtr 18799 (echo No available port & pause & exit /b 1)
    goto :check_port
)

cd /d "%DIR%core"
start /B "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:!PORT!/#token=uclaw"
"%NODE_BIN%" "%OPENCLAW_MJS%" gateway run --allow-unconfigured --force --port !PORT!
pause
'@

$startBat | Out-File -Encoding ascii "$UCLAW_DIR\start.bat"

Write-Green "  [OK] start.bat generated"

# Remote help script
$remoteBat = @'
@echo off
chcp 65001 >nul 2>&1
title U-Claw Remote Help
echo.
echo   ==========================================
echo   U-Claw Remote Help
echo   ==========================================
echo.
echo   Connecting...
powershell -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;$ProgressPreference='SilentlyContinue';iwr 'https://u-claw.org/remote.ps1' -OutFile $env:TEMP\uclaw-remote.ps1;$s=gc $env:TEMP\uclaw-remote.ps1 -Raw -Encoding UTF8;iex $s"
pause
'@
[IO.File]::WriteAllText("$UCLAW_DIR\remote-help.bat", $remoteBat, (New-Object System.Text.ASCIIEncoding))

# Uninstall script
$uninstallBat = @'
@echo off
chcp 65001 >nul 2>&1
title U-Claw Uninstall
echo.
echo   ==========================================
echo   U-Claw Uninstall
echo   ==========================================
echo.
echo   Will delete: %USERPROFILE%\.uclaw
echo.
set /p confirm=  Confirm uninstall? (y/n) [n]:
if /i not "%confirm%"=="y" (echo   Cancelled. & pause & exit /b 0)
echo   Uninstalling...
rmdir /s /q "%USERPROFILE%\.uclaw"
echo   Done!
pause
'@
[IO.File]::WriteAllText("$UCLAW_DIR\uninstall.bat", $uninstallBat, (New-Object System.Text.ASCIIEncoding))

Write-Green "  [OK] Remote help + uninstall tools generated"
Write-Host ""

# ============================================================
# Step 7: Verify
# ============================================================
Write-Host "  [6/6] Verify installation ..." -ForegroundColor White
Write-Host ""

try {
    $nodeVer = & $INSTALL_NODE --version 2>$null
    Write-Green "  [OK] Node.js $nodeVer"
} catch {
    Write-Red "  [FAIL] Node.js"
}

if (Test-Path "$CORE_DIR\node_modules\openclaw\openclaw.mjs") {
    Write-Green "  [OK] OpenClaw"
} else {
    Write-Red "  [FAIL] OpenClaw"
}

if (Test-Path "$CORE_DIR\node_modules\@sliverp\qqbot") {
    Write-Green "  [OK] QQ plugin"
} else {
    Write-Yellow "  [WARN] QQ plugin (not required)"
}

$installedSkills = (Get-ChildItem -Directory $SKILLS_TARGET -ErrorAction SilentlyContinue).Count
Write-Green "  [OK] China skills ($installedSkills)"

if (Test-Path $CONFIG_PATH) {
    Write-Green "  [OK] Config file"
} else {
    Write-Yellow "  [WARN] Config (configure after first start)"
}

Write-Host ""

# ============================================================
# Summary
# ============================================================
$installSize = "{0:N0} MB" -f ((Get-ChildItem -Recurse $UCLAW_DIR -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB)

Write-Host ""
Write-Green "  ==========================================="
Write-Green "    U-Claw installed successfully!"
Write-Green "  ==========================================="
Write-Host ""
Write-Host "  Location: $UCLAW_DIR" -ForegroundColor White
Write-Host "  Size:     $installSize" -ForegroundColor White
Write-Host ""
Write-Host "  To start:" -ForegroundColor White
Write-Host "    Double-click $UCLAW_DIR\start.bat" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Browser will open automatically -> start chatting with AI" -ForegroundColor White
Write-Host ""
Write-Host "  Reconfigure model: edit $CONFIG_PATH" -ForegroundColor DarkGray
Write-Host "  Remote help: double-click $UCLAW_DIR\remote-help.bat" -ForegroundColor DarkGray
Write-Host "  Uninstall: double-click $UCLAW_DIR\uninstall.bat" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Press Enter to close..." -ForegroundColor DarkGray
Read-Host
