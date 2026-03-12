# 🦞 U-Claw

**把 AI 助手简化到"双击运行" — Portable AI Agent, double-click to run**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

U-Claw 把 [OpenClaw](https://github.com/openclaw/openclaw) 打包成开箱即用的形态。Node.js + OpenClaw + 全部依赖 + QQ 插件，不需要翻墙，不需要命令行基础。

---

## 项目结构

```
U-Claw/
├── portable/              ← 🔥 U盘便携版（核心）
│   ├── Mac-Start.command       Mac 启动脚本
│   ├── Windows-Start.bat       Windows 启动脚本
│   ├── Mac-Menu.command        Mac 菜单（8 个功能）
│   ├── Windows-Menu.bat        Windows 菜单
│   ├── Config.html             首次配置页面
│   ├── U-Claw.html             导航首页
│   ├── SkillHub.html           技能市场
│   ├── default-config.json     默认配置模板
│   └── migrate.js              配置迁移工具
│
├── u-claw-app/            ← 🖥 桌面安装版（Electron）
│   ├── src/main.js             主进程（11K 行）
│   ├── package.json            依赖 & 构建配置
│   ├── assets/                 图标资源
│   ├── resources/              Config.html + Node.js 运行时
│   └── scripts/                构建脚本
│
├── usb-scripts/           ← 💾 U盘安装脚本
│   ├── Mac-Install.command     Mac: 解压 + 启动
│   └── Windows-Install.bat     Windows: 解压 + 启动
│
├── website/               ← 🌐 官网 + 教程（u-claw.org）
│   ├── index.html              官网首页
│   ├── guide.html              帮助指南
│   ├── skills.html             技能市场页
│   └── 教程-OpenClaw中国区完全指南.md
│
└── README.md
```

## 两个产品线

### 1. U盘便携版 (`portable/`)

**用户体验：** 插 U 盘 → 双击启动 → 浏览器打开配置页 → 开始用

```
portable/
├── app/                    ← 运行时（不进 git，~2.3GB）
│   ├── core/                  OpenClaw + 依赖 + QQ 插件
│   └── runtime/
│       ├── node-mac-arm64/    Mac Apple Silicon
│       └── node-win-x64/     Windows 64-bit
├── data/                   ← 用户数据（不进 git）
│   ├── .openclaw/             配置文件
│   ├── memory/                AI 记忆
│   └── backups/               备份
└── [脚本和HTML]             ← 这些进 git
```

**分发方式：** 把整个 `portable/` + `app/` 打包成 `U-Claw.tar.gz`（约 743MB），用 `usb-scripts/` 的脚本解压启动。

**状态：** ✅ Mac Apple Silicon 可用 · 🚧 Windows 开发中 · ❌ Mac Intel / Linux 暂不支持

### 2. 桌面安装版 (`u-claw-app/`)

**用户体验：** 下载 DMG/EXE → 安装 → 打开 App → 自动配置

```bash
# 开发
cd u-claw-app
npm install
npm start           # 本地运行

# 构建
npm run build:mac        # → release/U-Claw-x.x.x.dmg
npm run build:mac-arm64  # → ARM64 版
npm run build:win        # → release/U-Claw-x.x.x.exe
```

**状态：** 🚧 Mac ARM64 基本可用 · 🚧 Windows 开发中 · ❌ Linux 暂不支持

## 支持的 AI 模型

### 国产模型（无需翻墙）

| 模型 | 推荐场景 |
|------|----------|
| DeepSeek | 编程首选，极便宜 |
| Kimi K2.5 | 长文档，256K 上下文 |
| 通义千问 Qwen | 免费额度大 |
| 智谱 GLM | 学术场景 |
| MiniMax | 语音多模态 |
| 豆包 Doubao | 火山引擎 |

### 国际模型

Claude · GPT · Gemini（需翻墙或中转）

## 支持的聊天平台

| 平台 | 状态 | 说明 |
|------|------|------|
| QQ | ✅ 已预装 | 输入 AppID + Secret 即可 |
| 飞书 | ✅ 内置 | 企业首选 |
| Telegram | ✅ 内置 | 海外推荐 |
| WhatsApp | ✅ 内置 | Baileys 协议 |
| Discord | ✅ 内置 | — |
| 微信 | ✅ 社区插件 | iPad 协议 |

## 参与开发

### 环境要求

- Node.js 22+
- macOS 12+ 或 Windows 10+

### 开发 portable 版

```bash
git clone https://github.com/dongsheng123132/u-claw.git
cd u-claw/portable

# 一键搭建运行环境（自动下载 Node.js + OpenClaw + QQ 插件）
bash setup.sh

# 启动测试
bash Mac-Start.command   # Mac
# 或双击 Windows-Start.bat  # Windows
```

`setup.sh` 会自动：
1. 检测你的系统（Mac ARM/Intel/Linux）
2. 从国内镜像下载 Node.js v22
3. 安装 OpenClaw + QQ 插件到 `app/` 目录

### 开发桌面版

```bash
cd u-claw-app

# Mac / Linux 一键安装（自动下载 Node.js runtime + 依赖，全部国内镜像）
bash setup.sh

# Windows 一键安装
setup.bat
```

`setup.sh` / `setup.bat` 会自动：
1. 检查或下载 Node.js v22（国内镜像 npmmirror.com）
2. 安装 npm 依赖 + Electron（国内镜像）
3. 下载打包用 Node.js runtime
4. 询问是否立即启动

安装完成后：
```bash
npm run dev              # 开发模式运行
npm run build:mac-arm64  # 打包 Mac ARM64 DMG
npm run build:mac-x64    # 打包 Mac Intel DMG
npm run build:win        # 打包 Windows EXE（需在 Windows 上）
```

### 提交代码

```bash
git checkout -b feat/your-feature
# 改代码...
git add -A
git commit -m "feat: your change"
git push -u origin feat/your-feature
# 在 GitHub 上创建 PR
```

## 待开发 / 欢迎贡献

- [ ] Windows 便携版完善测试
- [ ] Mac Intel 支持
- [ ] Linux 支持（AppImage）
- [ ] 桌面版自动更新
- [ ] 一键安装到电脑（永久模式）
- [ ] 在线安装脚本（curl 一行安装）
- [ ] SkillHub 技能市场功能完善
- [ ] 多语言支持（English UI）

## FAQ

**Q: 需要翻墙吗？**
安装不需要。运行需要联网调 API，国产模型无需翻墙。

**Q: 能分发吗？**
MIT 协议，随便复制。

**Q: Mac 提示"未验证的开发者"？**
右键脚本 → 打开。

**Q: Windows 需要 WSL？**
不需要，自带 Windows 版 Node.js。

## License

[MIT](LICENSE)

## 联系

- 微信: hecare888
- GitHub: [@dongsheng123132](https://github.com/dongsheng123132)
- 官网: [u-claw.org](https://u-claw.org)

---

**Made with 🦞 by [dongsheng](https://github.com/dongsheng123132)**
