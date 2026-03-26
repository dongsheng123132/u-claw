# M-Claw 一键安装 / One-Line Install

> 一行命令安装 OpenClaw + 技能包 + 模型配置
> One command to install OpenClaw + skills + model config

## 安装 / Install

### Mac / Linux

```bash
curl -fsSL https://u-claw.org/install.sh | bash
```

### Windows (PowerShell 管理员)

```powershell
irm https://u-claw.org/install.ps1 | iex
```

### 本地运行

```bash
# Mac/Linux
bash install/install.sh

# Windows
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

## 安装流程 (7 步)

| 步骤 | 内容 | 说明 |
|------|------|------|
| 1 | Banner + 系统检测 | 自动识别 OS/Arch |
| 2 | Node.js v22 | 安装到 `~/.uclaw/runtime/`，系统有 v20+ 则复用 |
| 3 | OpenClaw | npm 安装到 `~/.uclaw/core/` |
| 4 | QQ 插件 | 非致命，失败不影响主功能 |
| 5 | 10 个中国技能 | 小红书、B站、微博等内容创作技能 |
| 6 | 模型配置 | 中文交互菜单，默认 DeepSeek |
| 7 | 启动脚本 + 验证 | 生成 start.command / start.bat |

## 支持的 AI 模型

### 国内（无需翻墙）

| 编号 | 模型 | 说明 |
|------|------|------|
| 1 | DeepSeek | ⭐ 推荐，性价比最高 |
| 2 | Kimi/月之暗面 | 长文档 |
| 3 | 通义千问 | 有免费额度 |
| 4 | 智谱GLM | 学术场景 |
| 5 | MiniMax | 多模态 |
| 6 | 豆包 | 火山引擎 |
| 7 | 硅基流动 | 聚合多模型 |

### 海外

| 编号 | 模型 |
|------|------|
| 8 | Claude |
| 9 | GPT |

### 本地

| 编号 | 模型 |
|------|------|
| 10 | Ollama |

## 安装目录结构

```
~/.uclaw/
├── runtime/node-{platform}/     # Node.js v22
├── core/                        # OpenClaw + QQ 插件
│   ├── package.json
│   └── node_modules/
│       └── openclaw/skills/     ← 技能在这里
├── data/
│   ├── .openclaw/openclaw.json  ← 模型配置
│   ├── memory/                  ← AI 记忆
│   └── backups/                 ← 备份
├── start.command (Mac)          ← 启动脚本
└── start.bat (Windows)          ← 启动脚本
```

## 技术细节

- **Node.js**: 只装到 `~/.uclaw/runtime/`，不动系统 Node；系统已有 v20+ 则复用
- **镜像**: 全走 `npmmirror.com`（Node 二进制 + npm 包），国内无需翻墙
- **Windows 编码**: `chcp 65001` + UTF8 输出确保中文显示
- **管道模式**: `curl | bash` 时自动跳过交互，使用默认配置
- **卸载**: `rm -rf ~/.uclaw` (Mac/Linux) 或删除 `%USERPROFILE%\.uclaw` (Windows)

## 包含技能

| 技能 | 用途 |
|------|------|
| xiaohongshu-writer | 小红书笔记写作 |
| bilibili-helper | B站视频优化 |
| weibo-poster | 微博内容创作 |
| wechat-article | 微信公众号文章 |
| zhihu-writer | 知乎回答/文章 |
| douyin-script | 抖音短视频脚本 |
| china-search | 国内搜索引擎 |
| china-translate | 中英互译 |
| china-weather | 天气查询 |
| deepseek-helper | DeepSeek API 助手 |

## 与其他分发形式的关系

```
install/     ← 一键在线安装（本模块）
portable/    ← U 盘便携版
u-claw-app/  ← Electron 桌面版
bootable/    ← Linux 可启动 U 盘
```

install/ 安装的结果与 portable/ 的 Mac-Install.command 相同，
区别是不需要 U 盘，直接从网络下载所有组件。
