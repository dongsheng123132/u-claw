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
cd portable && bash setup.sh    # Downloads Node.js v22 + OpenClaw + QQ plugin to app/
bash Mac-Start.command          # Launch (Mac ARM64 only currently)

# Copy to USB drive
cp -R portable/ /Volumes/YOUR_USB/M-Claw/

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

Testing should be done in a separate folder or directly on USB. This repo stays clean (no node_modules, no app/ runtime).

## Architecture

```
portable/           THE USB content (= repo + setup.sh downloads)
                    Scripts, HTML pages, setup.sh
                    app/core/ (OpenClaw) + app/runtime/ (Node.js) — downloaded by setup.sh
                    data/.openclaw/openclaw.json — user config (on USB, portable)
                    Mac-Install.command / Windows-Install.bat — install to computer from USB
                    skills-cn/ — 10 个中国本地化技能（小红书、微博、B站等）

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

website/            Static HTML deployed to u-claw.org via Vercel
                    vercel.json sets outputDirectory: "website"
                    install.sh / install.ps1 — 复制自 install/，供 curl 下载
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
- Mac Intel (x64): ✅ Working（portable 需先运行 setup.sh 下载 node-mac-x64）
- Windows x64: 🚧 In development
- Linux x64 (Bootable USB): ✅ `bootable/` 目录 + 独立仓库 [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux)

## Bootable Linux Key Details

- **制作环境**: Windows 10/11 + PowerShell (Admin)，4 步脚本
- **U 盘要求**: 32GB+ USB 3.0
- **技术栈**: Ventoy 1.0.99 引导 → Ubuntu 24.04 ISO → casper-rw 持久化 → OpenClaw 安装到 /opt/u-claw/
- **国内镜像**: ISO 下载走清华/阿里/中科大，Node.js 和 npm 走 npmmirror.com
- **Linux 环境变量**: `OPENCLAW_HOME=/opt/u-claw/data/.openclaw`
- **bootable/ 完全独立**: 不引用 portable/、u-claw-app/、website/ 的任何文件，修改互不影响
- **同步**: bootable/ 内容与 u-claw-linux 仓库保持一致，改一边要记得同步另一边
