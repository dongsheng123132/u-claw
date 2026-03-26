# M-Claw — 便携式 AI 助手

从 U 盘直接运行，无需安装。

## 快速开始

### Mac
双击 `启动 M-Claw.command` 即可。

### Windows
双击 `Windows-Start.bat` 即可。

## 首次使用

1. 双击启动脚本
2. 浏览器自动打开配置页面
3. 选择模型、填写 API Key
4. 点击「保存并启动」

## 目录说明

```
├── 启动 M-Claw.command   ← Mac 启动
├── 重新配置.command       ← Mac 重新配置
├── Windows-Start.bat     ← Windows 启动
├── Windows-Menu.bat      ← Windows 功能菜单
├── Config.html           ← 配置页面
├── core/                 ← OpenClaw + 依赖
├── runtime/              ← Node.js 运行时
├── data/                 ← 用户数据（自动生成）
├── skills/               ← 中国优化技能
└── toolkit/              ← 快速装机包
```

## 开发者

```bash
# 搭建开发环境（下载 Node.js + OpenClaw）
bash setup.sh

# 制作跨平台 U 盘
bash setup.sh --all-platforms

# 下载 Node.js 安装包到 toolkit/
bash setup.sh --with-toolkit
```
