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

> **Scope**: before adding a feature or accepting a PR, read the「范围」section of `CONTRIBUTING.md` (positioning, boundary rule, never / not-now lists). Change that section first, code second.

Distribution forms:
1. **Portable USB** (`portable/`): Run from USB on existing Mac/Windows, zero install. **This is the only form CI publishes** (Windows full zip; Mac runs `setup.sh` on first launch).
2. **One-line install** (`install/`): `curl | bash` or `irm | iex` — download and install from network, no USB needed. User-run scripts (not in CI).

> **Removed: Electron desktop app** (`u-claw-app/`, DMG/EXE) — deprecated 2026-06-19 (it was a weaker duplicate of the commercial ClawX desktop and had cold-start gateway-timeout bugs), then deleted from the repo. The `desktop-windows`/`desktop-mac` CI jobs were removed from `release.yml`. Recoverable from git tag `archive/pre-scope-razor-2026-10-05`.
>
> **Removed: `bootable/`** (Linux bootable USB kit) — it lives on in the standalone repo [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux); also recoverable from the same archive tag.
>
> **Removed: `usb-release/`** — an abandoned older predecessor of `portable/` (last touched 2026-04, `core/`+`skills/` layout, referenced nowhere). Deleted 2026-06-19.

## Development Commands

```bash
# Portable version — build dev copy
cd portable && bash setup.sh    # Downloads Node.js v22 + OpenClaw + WeChat/QQ plugin to app/
bash Mac-Start.command          # Launch (Mac ARM64). Windows: Windows-Start.bat

# Copy to USB drive
cp -R portable/ /Volumes/YOUR_USB/U-Claw/
```

### Tests

```bash
node --test "tests/*.test.mjs"  # Run all tests (node:test, no test framework dep)
#                                 NOTE: `node --test tests/` fails on Node 22 (MODULE_NOT_FOUND) -- use the glob
node --test tests/windows-launchers.test.mjs   # Run one test file
```

Tests assert on the **text/behavior of the launcher scripts** (`.bat`/`.command`) — e.g. that
`Windows-Start.bat` escapes `^(...^)` parens inside IF blocks and disables OpenClaw bonjour
discovery. They read repo files as strings; they do **not** spawn OpenClaw. There is no root
`package.json` — tests are not run by the release CI (`.github/workflows/release.yml` only
builds and publishes). Run them locally before pushing launcher changes.

**CI workflows** (`.github/workflows/`): `release.yml` builds the Windows full portable bundle and
publishes a GitHub Release on tag push. `track-upstream.yml` runs daily (cron) — checks
`npm view openclaw version` against the pinned `OPENCLAW_VERSION`; if upstream is newer it bumps
both `OPENCLAW_VERSION` files + the shell/release version (root `VERSION` patch),
commits, and pushes a new `v<shell-version>` tag, which in turn triggers `release.yml`. Supports
`workflow_dispatch` with `force_version` / `dry_run` inputs. `OPENCLAW_VERSION` is the upstream
pin; root `VERSION` is the shell/release version (the two are separate).

Testing of the actual runtime should be done in a separate folder or directly on USB. This repo
stays clean (no node_modules, no app/ runtime).

## Architecture

```
portable/           THE USB content (= repo + setup.sh downloads)
                    setup.sh / setup.bat / setup.ps1 — fill in app/ (Node + OpenClaw + plugins)
                    {Mac,Windows}-Start    — launch gateway + config-server, open dashboard / 配置中心
                    {Mac,Windows}-Maintain — thin maintain menu (model/wallet settings, diagnose, local
                        logs, backup, restore to a fresh folder, native CLI, stable release page)
                    {Mac,Windows}-Install  — copy USB → computer (~/.uclaw/ or %USERPROFILE%)
                    {Mac,Windows}-Diagnose — health check / collect logs for bug reports
                    {Mac-OpenClaw-CLI,OpenClaw-CLI.bat} — drop into raw `openclaw` CLI (chat channels are managed
                        here: `openclaw channels add / login / status / remove`)
                    快速上手.html — offline quick-start page
                    config-server/server.js — local HTTP server (port 18788-18798) backing the
                        配置中心 page (public/index.html): writes openclaw.json, 虾盘云 wallet,
                        update-status API
                    lib/                   — Node helpers (see "lib/ helpers" below)
                    default-config.json    — seed config copied to data/.openclaw/ on first run
                    app/core/ (OpenClaw) + app/runtime/ (Node.js) — downloaded by setup.sh
                    data/.openclaw/openclaw.json — user config (on USB, portable)

install/            一键在线安装模块（curl | bash / irm | iex）
                    install.sh (Mac/Linux) + install.ps1 (Windows)
                    6 步流程: 系统检测 → Node.js → OpenClaw → QQ插件 → 模型配置 → 启动脚本
                    安装到 ~/.uclaw/，与 Mac-Install.command 结果相同

```

> **Note**: 官网 (u-claw.org) 已拆分到独立私有仓库 [u-claw.org](https://github.com/dongsheng123132/u-claw.org)，本仓库不再包含 website/ 和 vercel.json。
> **虾航**: AI人导航站 (nav.u-claw.org) 在独立私有仓库 [xiahang](https://github.com/dongsheng123132/xiahang)。

The portable launchers auto-find a free port in range 18789–18799 and start the OpenClaw gateway. On first run, they detect whether a model is configured — if not, they open the 配置中心 (Config Center); otherwise, they open the dashboard.

## Key Technical Details

- **Node.js discovery**: Portable looks at `app/runtime/node-mac-arm64/bin/node` (Windows: `app/runtime/node-win-x64/node.exe`)
- **China mirrors**: All downloads use `npmmirror.com` — Node.js binaries from `npmmirror.com/mirrors/node`, npm packages from `registry.npmmirror.com`
- **`OPENCLAW_VERSION` file**: single source of truth for the bundled OpenClaw runtime version (e.g. `2026.6.8`). CI reads it to pin the npm install; it's copied into `portable/` for reference. Bump this file to upgrade.
- **Environment variables**: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` control where OpenClaw reads config
- **macOS quarantine**: Mac scripts run `xattr -rd com.apple.quarantine` to remove Gatekeeper blocks
- **Config format**: `{"gateway":{"mode":"local","auth":{"token":"uclaw"}},"models":{"mode":"merge","providers":{"xxx":{...}}},"agents":{"defaults":{"model":{"primary":"provider/model"}}}}`
- **Config hot-reload**: OpenClaw watches `openclaw.json` and applies changes without restart
- **Two local servers on startup**: launchers start the OpenClaw **gateway** (18789–18799) AND
  the **config-server** (`config-server/server.js`, 18788–18798). The config-server backs
  the 配置中心 page (`config-server/public/index.html`) — it writes `openclaw.json`, serves the 虾盘云 wallet API, and exposes update-status.

## lib/ Helpers (portable)

Pure-Node, zero-dependency `.mjs` modules (use `fetch` + `node:zlib` only). All are designed to
**fail silently** and **run detached** so they never block or break OpenClaw startup.

| File | Purpose |
|------|---------|
| `check-update.mjs` / `publish-latest.mjs` | 启动时更新检查已退役（范围约定：不自动追随上游，升级以稳定整包为单位）。`publish-latest.mjs` 仍是发行清单生成器；`check-update.mjs` 只作为它的 `latest.json` 格式参考保留，不再被启动脚本调用。 |
| `portable-cache.mjs` | **本地缓存唯一解析器**：候选链 systemCacheRoot → HOME cache → os.tmpdir，每个候选做真实可写探测（compile/npm/temp/log/受管浏览器子目录全部建好再写探针），且候选/落点不得在 U 盘或 STATE_DIR 子树内。UUID 写 `STATE_DIR/portable-cache-id`（损坏文件不覆盖），换盘符仍复用同一份本机缓存。CLI 打印 `KEY=VALUE` 供 `portable-cache-env.{bat,sh}` 解析（不 eval）。**绝不回落 U 盘**：全部候选不可用就清缓存变量 + `NODE_DISABLE_COMPILE_CACHE=1` + 可见 stderr 错误并退出（Diagnose 除外——它报告错误后继续）。 |
| `prewarm.mjs` | gateway 首轮预热：端口就绪后后台静默 GET `/ready`→`/status`→`/models`（带 `x-openclaw-token`），把 config/model 子系统在 runtime 内存里热起来，用户首次点发送不再等。零依赖、短超时、后台 detach。 |
| `loading.html` | 启动首屏（splash）：双击启动后立刻打开，给即时反馈消除"黑窗假死"。本页每秒 fetch `/ready`，gateway 真就绪后自动 `location.replace` 跳 Dashboard——天然规避"gateway 没起就开 Dashboard 拒连"(issue #46/#48)。端口经 `?port=` 传入。 |
| `wait-gateway.bat` | Windows 兜底：现由 `loading.html` 首屏轮询并自动跳转；本脚本退居兜底——万一首屏 `file://` fetch 被浏览器拦，仍轮询端口、就绪后开 Dashboard。 |
| `portable-maintenance.mjs` | 维护菜单背后的零依赖动作核心：`settings-url`（读 runtime.json 的 configServerPort，短超时 GET `/api/runtime` 核对 `instanceId=sha256(path.resolve(STATE_DIR))`，foreign/stale 不给 URL）、`logs-path`（走 portable-cache）、`backup`（原生 `backup create --verify --output`）、`restore`（原生 `backup restore <archive> --target <全新空目录>`，绝不覆盖既有 state）。原生备份不含 live `agents/**/sessions/*.jsonl`（官方 volatile/skipped），输出文案与测试都写明；恢复结果只落在新目录，不自动激活（先停 Gateway）。 |

### 启动加速（吸收自 v2 u-clawx 4.0 的工程经验，2026-06-17）

便携版从 U 盘启动慢，瓶颈在 **U 盘随机小写 IO** + **首屏无反馈** + **首轮冷启动**。移植 4.0 的 4 个可在纯脚本层复刻的手段：

1. **缓存搬本机**（`portable-cache.mjs` + `portable-cache-env.{bat,sh}`）：V8 编译缓存、npm 缓存、temp、日志与受管浏览器 profile 全部落本机 SSD（候选链 + 可写探测，不回落 U 盘）。业务数据（`openclaw.json`、`memory`、账号、钱包）仍留 U 盘，便携性不变。UUID 隔离让 D:→E: 换盘符仍命中同一份本机缓存。
2. **Node 编译缓存**：`openclaw.mjs` 本就调 `module.enableCompileCache()`，但默认落系统 temp（可能被清）。启动脚本显式把 `NODE_COMPILE_CACHE` 指向本机固定目录，二次启动稳定命中。
3. **启动首屏**（`loading.html`）：双击即弹，自轮询自跳转。
4. **首轮预热**（`prewarm.mjs`）：后台唤醒 config/model。
5. **动态探测**：Windows 把写死的 `timeout /t 2`（等 config-server）改成轮询 18788，省掉白等。

> 注：OpenClaw 自身的临时/lock/chrome-mcp 文件已走 `os.tmpdir()`（系统 temp，**不在 U 盘**），无需处理；真正落 U 盘的只有 `OPENCLAW_HOME=data/` 下的内容。

> **纯开源,无追踪**: 这个开源版**不含**设备指纹 (`fingerprint.mjs`)、自动开户 (`bootstrap-xiapan.mjs`/`xiapan-client.mjs`)、崩溃上报 (`report-bug.mjs`) 等商业版逻辑——这些已在 2026-06-17 移除。U-Claw 不绑定设备、不打指纹、不向 `api.u-claw.org` 上传任何数据。

### 模型配置 ("选模型填 Key")

配置中心（`config-server/public/index.html`）列出国内外大模型供用户挑选，模型目录来自 `portable/models.json`（单一真相源）→ `node lib/sync-models.mjs` 生成的 `config-server/public/models-catalog.json`。首选卡片是 **虾盘云** (Xiapan Cloud 中转站,`api.u-claw.org/v1`)
——一个 Key 调用 DeepSeek / Claude / GPT / 通义 等全部模型,但不会自动开户：用户可在页面里点按钮一键领取额度（设备钱包）/ 充值，或自己去
`https://u-claw.org/cloud.html` 注册拿 Key。其余 provider (DeepSeek/通义/Kimi/智谱/
豆包/MiniMax/OpenAI/Claude/Groq/硅基流动/自定义) 填各家官方 Key 即可。配置只写本地
`data/.openclaw/openclaw.json`。

## What NOT to Commit

Never commit runtime dependencies or build artifacts. These are all in .gitignore:
- `portable/app/` and `portable/data/` (runtime + user data)
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
- Linux x64 (Bootable USB): not in this repo — see the standalone repo [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux)
