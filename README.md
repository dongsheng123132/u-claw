# 🦞 U-Claw（虾盘）

> **虾盘 — 全球首个 U 盘里运行的 AI 助手 | The world's first AI assistant that runs from a USB drive**
> **制作「插上就能用」的 AI 助手 U 盘 — 教程与源代码**
> **Build a plug-and-play AI assistant USB drive — Tutorial & Source Code**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[中文](#中文) | [English](#english) | [📖 完整教程](https://u-claw.org/tutorial.html)

---

<a id="中文"></a>

## 中文

### 这是什么

U-Claw（虾盘）是一个**制作教程 + 全套源代码**，教你把 [OpenClaw](https://github.com/openclaw/openclaw)（开源 AI 助手框架）做成 U 盘——插上任意电脑，双击就能用 AI。为什么叫虾盘？U-Claw = USB + Claw（虾钳），U 盘 + AI = 虾盘。

代码库本身就是 U 盘的文件骨架，运行 `setup.sh` 补齐大依赖后，整个 `portable/` 目录直接拷贝到 U 盘即可。

> 📖 **[完整教程](https://u-claw.org/tutorial.html)** — 从零开始的手工安装指南、模型配置、聊天平台接入，小白也能看懂。

### 一键安装（推荐）

不需要 U 盘，一行命令直接装到电脑：

```bash
# Mac / Linux
curl -fsSL https://u-claw.org/install.sh | bash

# Windows (PowerShell 管理员)
irm https://u-claw.org/install.ps1 | iex
```

自动完成: Node.js 下载 → OpenClaw 安装 → 10 个中国技能 → 模型配置 → 启动脚本生成。全程国内镜像，无需翻墙。

详见 [`install/README.md`](install/README.md)。

### 快速开始：制作便携版 U 盘

```bash
# 1. 克隆代码
git clone https://github.com/dongsheng123132/u-claw.git

# 2. Mac 补齐大依赖（Node.js + OpenClaw，国内镜像，约 1 分钟）
cd u-claw/portable && bash setup.sh

# 2. Win 补齐大依赖（Node.js + OpenClaw，国内镜像，约 1 分钟）
切到 u-claw/portable 目录下双击 setup.bat 
或者 PowerShell​ 中切到 u-claw/portable 下输入 setup.bat 回车

# 3. 拷贝到 U 盘
cp -R portable/ /Volumes/你的U盘/U-Claw/   # Mac
# 或 Windows 资源管理器直接拖过去
```

**完成！** 插上 U 盘，双击启动脚本就能用。

### U 盘功能一览

| 功能 | Mac | Windows |
|------|-----|---------|
| **免安装运行** | `Mac-Start.command` | `Windows-Start.bat` |
| **功能菜单** | `Mac-Menu.command` | `Windows-Menu.bat` |
| **安装到电脑** | `Mac-Install.command` | `Windows-Install.bat` |
| **首次配置** | `Config.html` | `Config.html` |

### U 盘文件结构

```
U-Claw/                          ← 整个拷到 U 盘
├── Mac-Start.command             Mac 免安装运行
├── Mac-Menu.command              Mac 功能菜单
├── Mac-Install.command           安装到 Mac
├── Windows-Start.bat             Windows 免安装运行
├── Windows-Menu.bat              Windows 功能菜单
├── Windows-Install.bat           安装到 Windows
├── Config.html                   首次配置页面
├── setup.sh                      补齐依赖（开发者用）
├── app/                          ← 大依赖（setup.sh 下载，不进 git）
│   ├── core/                        OpenClaw + QQ 插件
│   └── runtime/
│       ├── node-mac-arm64/          Mac Apple Silicon
│       ├── node-mac-x64/           Mac Intel
│       └── node-win-x64/           Windows 64-bit
└── data/                         ← 用户数据（不进 git）
    ├── .openclaw/                   配置文件
    ├── memory/                      AI 记忆
    └── backups/                     备份
```

### Linux 可启动版

连操作系统都没有？没关系。可启动版可以让任意电脑从 U 盘直接启动 Ubuntu + AI：

- 本仓库内：[`bootable/`](bootable/) 目录（与其他模块完全独立，互不影响）
- 独立仓库：[u-claw-linux](https://github.com/dongsheng123132/u-claw-linux)（内容一致，方便单独克隆）

基于 Ventoy + Ubuntu 24.04 LTS + 持久化存储，在 Windows 上运行 4 步 PowerShell 脚本即可制作。详见 [`bootable/README.md`](bootable/README.md)。

### 桌面安装版（Electron App）

除了 U 盘便携版，还有桌面 App 版本：

```bash
cd u-claw-app
bash setup.sh            # 一键安装开发环境（国内镜像）
npm run dev              # 开发模式运行
npm run build:mac-arm64  # 打包 → release/*.dmg
npm run build:win        # 打包 → release/*.exe
```

### 支持的 AI 模型

**国产模型（无需翻墙）：**

| 模型 | 推荐场景 |
|------|----------|
| DeepSeek | 编程首选，极便宜 |
| Kimi K2.5 | 长文档，256K 上下文 |
| 通义千问 Qwen | 免费额度大 |
| 智谱 GLM | 学术场景 |
| MiniMax | 语音多模态 |
| 豆包 Doubao | 火山引擎 |

**国际模型：** Claude · GPT · Gemini（需翻墙或中转）

### 支持的聊天平台

| 平台 | 状态 | 说明 |
|------|------|------|
| QQ | ✅ 已预装 | 输入 AppID + Secret 即可 |
| 飞书 | ✅ 内置 | 企业首选 |
| Telegram | ✅ 内置 | 海外推荐 |
| WhatsApp | ✅ 内置 | Baileys 协议 |
| Discord | ✅ 内置 | — |
| 微信 | ✅ 社区插件 | iPad 协议 |

### 国内镜像

所有脚本默认走国内镜像，无需翻墙：

| 资源 | 镜像 |
|------|------|
| npm 包 | `registry.npmmirror.com` |
| Node.js | `npmmirror.com/mirrors/node` |
| Electron | `npmmirror.com/mirrors/electron` |

### 开发 & 贡献

```bash
git clone https://github.com/dongsheng123132/u-claw.git
cd u-claw/portable && bash setup.sh
bash Mac-Start.command   # Mac 测试
```

**平台支持：**

| 平台 | 状态 | 说明 |
|------|------|------|
| Mac Apple Silicon (M1-M4) | ✅ | 便携版 + 桌面版 |
| Mac Intel (x64) | ✅ | 便携版 + 桌面版 |
| Windows x64 | 🚧 开发中 | 便携版 + 桌面版 |
| Linux x64（可启动 U 盘） | ✅ | [`bootable/`](bootable/) 目录 |

欢迎 PR！特别需要：Windows 脚本完善、教程翻译。

### 🦞 寻找技术伙伴

U-Claw 是一个快速成长的开源项目，目前已有不少商业合作机会。

我们正在寻找：
- **技术伙伴** — 全栈 / Node.js / Electron / 脚本自动化
- **资源合作** — 渠道、内容、社区运营

如果你对 AI 工具的落地和商业化感兴趣，欢迎联系：

- 微信: hecare888
- GitHub: [@dongsheng123132](https://github.com/dongsheng123132)
- 官网: [u-claw.org](https://u-claw.org)

### FAQ

**Q: 需要翻墙吗？**
不需要。安装和运行全程使用国内镜像，国产模型 API 直连。

**Q: U 盘需要多大？**
4GB+（完整约 2.3GB）。

**Q: 能分发吗？**
MIT 协议，随便复制分发。

**Q: Mac 提示"未验证的开发者"？**
右键脚本 → 打开。

### 联系

- 微信: hecare888
- GitHub: [@dongsheng123132](https://github.com/dongsheng123132)
- 官网: [u-claw.org](https://u-claw.org)

---

<a id="english"></a>

## English

### What is this

U-Claw (aka "虾盘" / "Xia Pan" in Chinese, meaning "Claw Drive") is a **tutorial + complete source code** for building an [OpenClaw](https://github.com/openclaw/openclaw) (open-source AI assistant framework) USB drive — plug it into any computer, double-click, and start using AI.

The codebase itself is the USB file skeleton. Run `setup.sh` to download large dependencies, then copy the entire `portable/` directory to a USB drive.

> 📖 **[Full Tutorial](https://u-claw.org/tutorial.html)** — Step-by-step manual installation, model setup, chat platform integration.

### One-Line Install (Recommended)

No USB needed — install directly to your computer:

```bash
# Mac / Linux
curl -fsSL https://u-claw.org/install.sh | bash

# Windows (PowerShell as Admin)
irm https://u-claw.org/install.ps1 | iex
```

Automatically downloads Node.js, installs OpenClaw, configures 10 Chinese-optimized skills, and sets up your AI model. All downloads use China mirrors.

See [`install/README.md`](install/README.md) for details.

### Quick Start: Build a Portable USB

```bash
# 1. Clone
git clone https://github.com/dongsheng123132/u-claw.git

# 2. Download dependencies (Node.js + OpenClaw, ~1 min)
cd u-claw/portable && bash setup.sh

# 3. Copy to USB drive
cp -R portable/ /Volumes/YOUR_USB/U-Claw/   # Mac
# Or drag & drop on Windows
```

**Done!** Plug in the USB, double-click the start script, and you're running AI.

### USB Features

| Feature | Mac | Windows |
|---------|-----|---------|
| **Run (no install)** | `Mac-Start.command` | `Windows-Start.bat` |
| **Menu** | `Mac-Menu.command` | `Windows-Menu.bat` |
| **Install to PC** | `Mac-Install.command` | `Windows-Install.bat` |
| **First-time config** | `Config.html` | `Config.html` |

### File Structure

```
U-Claw/                          ← Copy entire folder to USB
├── Mac-Start.command             Mac launcher
├── Mac-Menu.command              Mac menu
├── Mac-Install.command           Install to Mac
├── Windows-Start.bat             Windows launcher
├── Windows-Menu.bat              Windows menu
├── Windows-Install.bat           Install to Windows
├── Config.html                   First-time config page
├── setup.sh                      Download dependencies (dev use)
├── app/                          ← Large deps (downloaded by setup.sh, not in git)
│   ├── core/                        OpenClaw + QQ plugin
│   └── runtime/
│       ├── node-mac-arm64/          Mac Apple Silicon
│       ├── node-mac-x64/           Mac Intel
│       └── node-win-x64/           Windows 64-bit
└── data/                         ← User data (not in git)
    ├── .openclaw/                   Config file
    ├── memory/                      AI memory
    └── backups/                     Backups
```

### Linux Bootable USB

No operating system? No problem. Boot any computer from USB into Ubuntu + AI:

- In this repo: [`bootable/`](bootable/) directory (fully independent from other modules)
- Standalone repo: [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux) (same content, easier to clone separately)

Based on Ventoy + Ubuntu 24.04 LTS + persistence. 4-step PowerShell scripts on Windows. See [`bootable/README.md`](bootable/README.md) for details.

### Desktop App (Electron)

```bash
cd u-claw-app
bash setup.sh            # One-click dev setup (China mirrors)
npm run dev              # Dev mode
npm run build:mac-arm64  # Build → release/*.dmg
npm run build:win        # Build → release/*.exe
```

### Supported AI Models

**Chinese models (no VPN needed):**

| Model | Best for |
|-------|----------|
| DeepSeek | Coding, extremely cheap |
| Kimi K2.5 | Long documents, 256K context |
| Qwen | Large free tier |
| GLM (Zhipu) | Academic use |
| MiniMax | Voice & multimodal |
| Doubao | Volcengine ecosystem |

**International models:** Claude · GPT · Gemini (VPN or relay required in China)

### Supported Chat Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| QQ | ✅ Pre-installed | Enter AppID + Secret |
| Feishu (Lark) | ✅ Built-in | Enterprise favorite |
| Telegram | ✅ Built-in | International |
| WhatsApp | ✅ Built-in | Baileys protocol |
| Discord | ✅ Built-in | — |
| WeChat | ✅ Community plugin | iPad protocol |

### China Mirrors

All scripts use China mirrors by default — no VPN needed:

| Resource | Mirror |
|----------|--------|
| npm packages | `registry.npmmirror.com` |
| Node.js | `npmmirror.com/mirrors/node` |
| Electron | `npmmirror.com/mirrors/electron` |

### Development & Contributing

```bash
git clone https://github.com/dongsheng123132/u-claw.git
cd u-claw/portable && bash setup.sh
bash Mac-Start.command   # Test on Mac
```

**Platform Support:**

| Platform | Status | Notes |
|----------|--------|-------|
| Mac Apple Silicon (M1-M4) | ✅ | Portable + Desktop |
| Mac Intel (x64) | ✅ | Portable + Desktop |
| Windows x64 | 🚧 In progress | Portable + Desktop |
| Linux x64 (Bootable USB) | ✅ | [`bootable/`](bootable/) directory |

PRs welcome! Especially: Windows scripts, documentation.

### 🔧 Professional Services / 专业服务

Need help? We offer remote support and custom development:

| Service | Description | Price |
|---------|-------------|-------|
| **Remote Installation** | We remotely install OpenClaw + skills + model config for you | Free |
| **Troubleshooting** | Startup failures, port conflicts, network issues | From ¥50 |
| **Model Tuning** | API key setup, model switching, prompt optimization | From ¥50 |
| **Custom Development** | Custom skills, enterprise private deployment, QQ/WeChat/Feishu bot integration | From ¥200 |
| **USB Green Edition** | Pre-built portable USB with your custom skills & models | From ¥100 |

**One-click remote support** — run one command, we connect and fix it:

```bash
# Mac / Linux
curl -fsSL https://u-claw.org/remote.sh | bash

# Windows (Admin PowerShell)
irm https://u-claw.org/remote.ps1 | iex
```

WeChat: **hecare888** (备注「U-Claw 远程」优先处理)

👉 [View full service details / 查看完整服务详情](https://u-claw.org/guide.html#remote-support)

### 🦞 Looking for Partners

U-Claw is a fast-growing open-source project with real commercial opportunities.

We're looking for:
- **Technical partners** — Full-stack / Node.js / Electron / scripting
- **Resource partners** — Distribution, content, community

If you're interested in AI tooling and commercialization, let's talk:

- WeChat: hecare888
- GitHub: [@dongsheng123132](https://github.com/dongsheng123132)
- Website: [u-claw.org](https://u-claw.org)

### FAQ

**Q: Do I need a VPN?**
No. All downloads use China mirrors. Chinese AI model APIs work directly.

**Q: How big should the USB drive be?**
4GB+ (~2.3GB full).

**Q: Can I redistribute?**
MIT license — copy and share freely.

**Q: Mac says "unverified developer"?**
Right-click the script → Open.

### Contact

- WeChat: hecare888
- GitHub: [@dongsheng123132](https://github.com/dongsheng123132)
- Website: [u-claw.org](https://u-claw.org)

---

**Made with 🦞 by [dongsheng](https://github.com/dongsheng123132)**
