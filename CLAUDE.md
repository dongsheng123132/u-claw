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

Two distribution forms:
1. **Portable USB** (`portable/`): Run from USB, zero install. The repo structure maps 1:1 to USB content.
2. **Electron desktop app** (`u-claw-app/`): Install-to-computer version, packaged as DMG/EXE.

## Development Setup

```bash
# Portable version — after this, portable/ IS the USB content
cd portable && bash setup.sh    # Downloads Node.js v22 + OpenClaw + QQ plugin to app/
bash Mac-Start.command          # Launch (Mac ARM64 only currently)

# Copy to USB drive
cp -R portable/ /Volumes/YOUR_USB/U-Claw/

# Electron desktop app
cd u-claw-app && bash setup.sh  # One-click: Node.js + Electron + deps (China mirrors)
npm run dev                     # Dev mode
npm run build:mac-arm64         # Build Mac ARM64 DMG
npm run build:win               # Build Windows NSIS + portable
```

Testing should be done in a separate clone at `~/uclaw-dev/u-claw/`, or directly on USB. This dev repo stays clean (no node_modules, no app/ runtime).

## Architecture

```
portable/           THE USB content (= repo + setup.sh downloads)
                    Scripts, HTML pages, setup.sh
                    app/core/ (OpenClaw) + app/runtime/ (Node.js) — downloaded by setup.sh
                    data/.openclaw/openclaw.json — user config (on USB, portable)
                    Mac-Install.command / Windows-Install.bat — install to computer from USB

u-claw-app/         Electron desktop app (main.js ~400 lines)
                    setup.sh / setup.bat for one-click dev environment
                    Bundles Node.js in resources/runtime/node-{platform}-{arch}
                    Config stored in app.getPath('userData')/.openclaw/

website/            Static HTML deployed to u-claw.org via Vercel
                    vercel.json sets outputDirectory: "website"
```

Both portable and desktop versions auto-find a free port in range 18789–18799 and start the OpenClaw gateway. On first run, they detect whether a model is configured — if not, they open Config.html; otherwise, they open the dashboard.

## Key Technical Details

- **Node.js discovery**: Portable looks at `app/runtime/node-mac-arm64/bin/node`; Electron looks at `resources/runtime/node-{platform}-{arch}` then falls back to system `node`
- **China mirrors**: All downloads use `npmmirror.com` — Node.js binaries from `npmmirror.com/mirrors/node`, npm packages from `registry.npmmirror.com`
- **Environment variables**: `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` control where OpenClaw reads config
- **macOS quarantine**: Mac scripts run `xattr -rd com.apple.quarantine` to remove Gatekeeper blocks
- **Config format**: `{"gateway":{"mode":"local","auth":{"token":"uclaw"}},"agent":{"model":"...","apiKey":"..."}}`
- **Config hot-reload**: OpenClaw watches `openclaw.json` and applies changes without restart

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
- Windows x64: 🚧 In development
- Mac Intel (x64): ✅ Working（portable 需先运行 setup.sh 下载 node-mac-x64）
- Linux: ❌ Not yet
