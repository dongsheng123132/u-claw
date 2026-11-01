# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview — CRITICAL MENTAL MODEL

**This repo IS the USB drive content**, minus large dependencies. The relationship:

```
代码库（git）= U 盘骨架（脚本 + HTML + 小文件）
     ↓ bash setup.sh
完整文件夹 = U 盘内容（骨架 + Node.js + OpenClaw）
     ↓ 拷贝到 U 盘
U 盘 = 插上就能用
```

The repo is NOT a "build tool" or "generator" — it IS the USB structure. `setup.sh` only fills in large deps that can't go in git. After `setup.sh`, the `portable/` folder is directly copyable to a USB drive.

Four distribution forms:
1. **Portable USB** (`portable/`): Run from USB on existing Mac/Windows, zero install.
2. **Electron desktop app** (`u-claw-app/`): Install-to-computer version, packaged as DMG/EXE.
3. **Bootable Linux USB** (`bootable/`): Ventoy + Ubuntu 24.04 — boots any x86_64 PC from USB, no OS needed.
4. **One-line install** (`install/`): `curl | bash` or `irm | iex` — download and install from network, no USB needed.

## Development Commands

```bash
# Portable version — build dev copy
cd portable && bash setup.sh    # Downloads Node.js v22 + OpenClaw + WeChat/QQ plugin to app/
bash Mac-Start.command          # Launch (Mac ARM64). Windows: Windows-Start.bat

# Copy to USB drive
cp -R portable/ /Volumes/YOUR_USB/U-Claw/

# Electron desktop app
cd u-claw-app && bash setup.sh  # One-click: Node.js + Electron + deps (China mirrors)
npm run dev                     # Dev mode
npm run build:mac-arm64         # Build Mac ARM64 DMG
npm run build:win               # Build Windows NSIS + portable

# Bootable Linux USB (run on Windows PowerShell as Admin)
cd bootable
.\1-prepare-usb.ps1             # Write Ventoy to USB (formats drive!)
.\2-download-iso.ps1            # Download Ubuntu ISO (~5.8GB, China mirrors)
.\3-create-persistence.ps1      # Create 20GB ext4 persistence image
.\4-copy-to-usb.ps1             # Copy ISO + persistence + scripts to USB
```

### Tests

```bash
node --test tests/              # Run all tests (node:test, no test framework dep)
node --test tests/windows-launchers.test.mjs   # Run one test file
```

Tests assert on the **text/behavior of the launcher scripts** (`.bat`/`.command`) — e.g. that
`Windows-Start.bat` escapes `^(...^)` parens inside IF blocks and disables OpenClaw bonjour
discovery. They read repo files as strings; they do **not** spawn OpenClaw. There is no root
`package.json` — tests are not run by the release CI (`.github/workflows/release.yml` only
builds and publishes). Run them locally before pushing launcher changes.

Testing of the actual runtime should be done in a separate folder or directly on USB. This repo
stays clean (no node_modules, no app/ runtime).

## Architecture

```
portable/           THE USB content (= repo + setup.sh downloads)
                    setup.sh / setup.bat / setup.ps1 — fill in app/ (Node + OpenClaw + plugins)
                    {Mac,Windows}-Start    — launch gateway + config-server, open dashboard/Config
                    {Mac,Windows}-Menu     — interactive CLI launcher (pick start/config/CLI/diagnose)
                    {Mac,Windows}-Install  — copy USB → computer (~/.uclaw/ or %USERPROFILE%)
                    {Mac,Windows}-Diagnose — health check / collect logs for bug reports
                    {Mac-OpenClaw-CLI,OpenClaw-CLI.bat} — drop into raw `openclaw` CLI
                    *.html (Welcome, Config, U-Claw, SkillHub) — local UI pages
                    config-server/server.js — local HTTP server (port 18788-18798) backing
                        Config.html: writes openclaw.json, WeChat QR login, update-status API
                    lib/                   — Node helpers (see "lib/ helpers" below)
                    default-config.json    — seed config copied to data/.openclaw/ on first run
                    app/core/ (OpenClaw) + app/runtime/ (Node.js) — downloaded by setup.sh
                    data/.openclaw/openclaw.json — user config (on USB, portable)
                    skills-cn/             — 13 个中国本地化技能（小红书/微博/B站/抖音/知乎/
                                             微信公众号/Word/Excel/PPT/天气/搜索/翻译/DeepSeek）

u-claw-app/         Electron desktop app (main.js ~400 lines)
                    setup.sh / setup.bat for one-click dev environment
                    Bundles Node.js in resources/runtime/node-{platform}-{arch}
                    Config stored in app.getPath('userData')/.openclaw/

bootable/           Linux 可启动 U 盘模块（完全独立，不依赖其他模块）
                    4 步 PowerShell 脚本 (Windows 上制作)
                    Ventoy 1.0.99 + Ubuntu 24.04 LTS + casper-rw 持久化
                    linux-setup/ — setup-openclaw.sh 安装到 /opt/u-claw/
                    独立仓库镜像: github.com/dongsheng123132/u-claw-linux

install/            一键在线安装模块（curl | bash / irm | iex）
                    install.sh (Mac/Linux) + install.ps1 (Windows)
                    7 步流程: 系统检测 → Node.js → OpenClaw → QQ插件 → 技能 → 模型配置 → 启动脚本
                    安装到 ~/.uclaw/，与 Mac-Install.command 结果相同

```

> **Note**: 官网 (u-claw.org) 已拆分到独立私有仓库 [u-claw.org](https://github.com/dongsheng123132/u-claw.org)，本仓库不再包含 website/ 和 vercel.json。
> **虾航**: AI人导航站 (nav.u-claw.org) 在独立私有仓库 [xiahang](https://github.com/dongsheng123132/xiahang)。

Both portable and desktop versions auto-find a free port in range 18789–18799 and start the OpenClaw gateway. On first run, they detect whether a model is configured — if not, they open Config.html; otherwise, they open the dashboard.

## Key Technical Details

- **Node.js discovery**: Portable looks at `app/runtime/node-mac-arm64/bin/node`; Electron looks at `resources/runtime/node-{platform}-{arch}` then falls back to system `node`
- **China mirrors**: All downloads use `npmmirror.com` — Node.js binaries from `npmmirror.com/mirrors/node`, npm packages from `registry.npmmirror.com`
- **`OPENCLAW_VERSION` file**: single source of truth for the bundled OpenClaw runtime version (e.g. `2026.6.6`). CI reads it to pin the npm install; it's copied into `portable/` so USB users / `check-update.mjs` can compare installed vs latest. Bump this file to upgrade.
- **Environment variables**: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` control where OpenClaw reads config
- **macOS quarantine**: Mac scripts run `xattr -rd com.apple.quarantine` to remove Gatekeeper blocks
- **Config format**: `{"gateway":{"mode":"local","auth":{"token":"uclaw"}},"models":{"mode":"merge","providers":{"xxx":{...}}},"agents":{"defaults":{"model":{"primary":"provider/model"}}}}`
- **Config hot-reload**: OpenClaw watches `openclaw.json` and applies changes without restart
- **Two local servers on startup**: launchers start the OpenClaw **gateway** (18789–18799) AND
  the **config-server** (`config-server/server.js`, 18788–18798). The config-server backs
  `Config.html` — it writes `openclaw.json`, drives WeChat QR login, and exposes update-status.

## lib/ Helpers (portable)

Pure-Node, zero-dependency `.mjs` modules (use `fetch` + `node:zlib` only). All are designed to
**fail silently** and **run detached** so they never block or break OpenClaw startup.

| File | Purpose |
|------|---------|
| `check-update.mjs` / `publish-latest.mjs` | Portable self-update: check installed vs latest `OPENCLAW_VERSION`; publish helper. |
| `portable-cache.mjs` | **启动加速核心**：把"重 IO、可重建"的缓存从 U 盘搬到本机硬盘。算出本机缓存根（win `%LOCALAPPDATA%\U-Claw\<slot>` / mac `~/Library/Caches/U-Claw` / linux `$XDG_CACHE_HOME`，UUID 隔离让换盘符仍复用），输出 `NODE_COMPILE_CACHE` 路径，并把 `data/.openclaw/browser` 做成 junction(win)/symlink(mac) 指向本机盘——浏览器 user-data 的海量随机小写不再砸 U 盘。CLI 打印 `KEY=VALUE` 供启动脚本 source。静默失败：取不到就缓存留 U 盘照常启动。 |
| `prewarm.mjs` | gateway 首轮预热：端口就绪后后台静默 GET `/ready`→`/status`→`/models`（带 `x-openclaw-token`），把 config/model 子系统在 runtime 内存里热起来，用户首次点发送不再等。零依赖、短超时、后台 detach。 |
| `loading.html` | 启动首屏（splash）：双击启动后立刻打开，给即时反馈消除"黑窗假死"。本页每秒 fetch `/ready`，gateway 真就绪后自动 `location.replace` 跳 Dashboard——天然规避"gateway 没起就开 Dashboard 拒连"(issue #46/#48)。端口经 `?port=` 传入。 |
| `wait-gateway.bat` | Windows 兜底：现由 `loading.html` 首屏轮询并自动跳转；本脚本退居兜底——万一首屏 `file://` fetch 被浏览器拦，仍轮询端口、就绪后开 Dashboard。 |
| `maintain.sh` | Maintenance/diagnostics script. |

### 启动加速（吸收自 v2 u-clawx 4.0 的工程经验，2026-06-17）

便携版从 U 盘启动慢，瓶颈在 **U 盘随机小写 IO** + **首屏无反馈** + **首轮冷启动**。移植 4.0 的 4 个可在纯脚本层复刻的手段：

1. **缓存搬本机**（`portable-cache.mjs`）：浏览器 user-data（OpenClaw 硬编码在 `CONFIG_DIR/browser/`，无单独环境变量，故用 junction/symlink 重定向）+ V8 编译缓存（`NODE_COMPILE_CACHE`）落本机 SSD。业务数据（`openclaw.json`、`memory`、账号）仍留 U 盘，便携性不变。UUID 隔离让 D:→E: 换盘符仍命中同一份本机缓存。
2. **Node 编译缓存**：`openclaw.mjs` 本就调 `module.enableCompileCache()`，但默认落系统 temp（可能被清）。启动脚本显式把 `NODE_COMPILE_CACHE` 指向本机固定目录，二次启动稳定命中。
3. **启动首屏**（`loading.html`）：双击即弹，自轮询自跳转。
4. **首轮预热**（`prewarm.mjs`）：后台唤醒 config/model。
5. **动态探测**：Windows 把写死的 `timeout /t 2`（等 config-server）改成轮询 18788，省掉白等。

> 注：OpenClaw 自身的临时/lock/chrome-mcp 文件已走 `os.tmpdir()`（系统 temp，**不在 U 盘**），无需处理；真正落 U 盘的只有 `OPENCLAW_HOME=data/` 下的内容。

> **纯开源,无追踪**: 这个开源版**不含**设备指纹 (`fingerprint.mjs`)、自动开户 (`bootstrap-xiapan.mjs`/`xiapan-client.mjs`)、崩溃上报 (`report-bug.mjs`) 等商业版逻辑——这些已在 2026-06-17 移除。U-Claw 不绑定设备、不打指纹、不向 `api.u-claw.org` 上传任何数据。

### 模型配置 ("选模型填 Key")

Config.html 列出国内外大模型供用户挑选。首选卡片是 **虾盘云** (Xiapan Cloud 中转站,`api.u-claw.org/v1`)
——一个 Key 调用 DeepSeek / Claude / GPT / 通义 等全部模型,但和其它 provider 一样**需要用户自己去
`https://u-claw.org/cloud.html` 注册拿 Key**,不再自动开户。其余 provider (DeepSeek/通义/Kimi/智谱/
豆包/MiniMax/OpenAI/Claude/Groq/硅基流动/自定义) 填各家官方 Key 即可。配置只写本地
`data/.openclaw/openclaw.json`。

## What NOT to Commit

Never commit runtime dependencies or build artifacts. These are all in .gitignore:
- `portable/app/` and `portable/data/` (runtime + user data)
- `u-claw-app/node_modules/`, `u-claw-app/release/`, `u-claw-app/resources/runtime/`
- `*.dmg`, `*.exe`, `*.blockmap`

Release artifacts go to GitHub Releases, not the repo.

## Branding Rules

- Use only official `openclaw` (not `openclaw-cn` or any community fork)
- All npm installs reference `openclaw@latest` (official package)
- External links point to `u-claw.org` (our site) or `github.com/openclaw/openclaw` (upstream)
- No references to competitor products (Qclaw, AutoClaw) in any tracked files
- Skill marketplace links point to `skillhub.tencent.com` or `github.com/openclaw/clawhub`

## Platform Support Status

- Mac Apple Silicon (ARM64): ✅ Working
- Mac Intel (x64): ✅ Working（portable 需先运行 setup.sh 下载 node-mac-x64）
- Windows x64: 🚧 In development
- Linux x64 (Bootable USB): ✅ `bootable/` 目录 + 独立仓库 [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux)

## Bootable Linux Key Details

- **制作环境**: Windows 10/11 + PowerShell (Admin)，4 步脚本
- **U 盘要求**: 32GB+ USB 3.0
- **技术栈**: Ventoy 1.0.99 引导 → Ubuntu 24.04 ISO → casper-rw 持久化 → OpenClaw 安装到 /opt/u-claw/
- **国内镜像**: ISO 下载走清华/阿里/中科大，Node.js 和 npm 走 npmmirror.com
- **Linux 环境变量**: `OPENCLAW_HOME=/opt/u-claw/data/.openclaw`
- **bootable/ 完全独立**: 不引用 portable/、u-claw-app/ 的任何文件，修改互不影响
- **同步**: bootable/ 内容与 u-claw-linux 仓库保持一致，改一边要记得同步另一边
