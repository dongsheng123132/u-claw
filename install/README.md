# U-Claw 一键在线安装

在线安装复用 `portable/` 的运行时、安装动作和启动脚本。安装完成后直接打开 OpenClaw WebUI，在「设备钱包」内领取额度、恢复已有密钥和充值。唯一默认模型是虾盘云 `deepseek-v4-flash`。

## 安装

Mac / Linux：

```bash
curl -fsSL https://u-claw.org/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://u-claw.org/install.ps1 | iex
```

本地运行脚本也可：

```bash
bash install/install.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File install/install.ps1
```

## 安装与启动

安装器下载并校验仓库源码路径，再复制完整便携版目录到 `~/.uclaw/` 或 `%USERPROFILE%/.uclaw/`。Windows 调用 `portable/lib/install-portable.ps1`；Mac 调用 `portable/Mac-Install.command`；Linux复用便携版 setup 和配置助手。已有程序先备份，已有 `data/` 保留。运行时版本以 `OPENCLAW_VERSION` 和 `portable/lib/runtime-requirements.mjs` 为准，下载动作由便携版 setup 脚本统一实现。

Windows 启动 `Windows-Start.bat`；Mac 启动 `Mac-Start.command`；Linux 启动安装目录的 `start.sh`。端口以启动窗口输出为准。

## 设备钱包

1. 在 WebUI 侧栏打开「设备钱包」，或点击对话顶部「设备钱包 · 充值」。
2. 点击「一键领取额度」，或输入已有虾盘云密钥并点击「启用这把密钥」。已有本地钱包会恢复模型配置，不会在启动时领取新钱包。
3. 点击「一键充值」打开充值页面，完成后点击「查询余额」，再回到对话。
4. 点击「复制密钥」备份。密钥就是钱包，换电脑后使用同一密钥可恢复余额。

启动前无需选择模型或填写其他提供商配置。微信、飞书、Telegram、QQ 等渠道接入和本地模型配置入口已移除。中文内容生成技能与技能市场仍保留。

## 目录

```text
.uclaw/
├── app/core/                 OpenClaw 和内置钱包插件
├── app/runtime/              对应平台的 Node.js
├── extensions/uclaw-wallet/  钱包插件源码及 dist/control-ui 资源
├── data/.openclaw/           模型配置与本地钱包
├── config-server/           后备配置中心
├── lib/                     共用安装、启动和配置动作
└── skills-cn/               中文内容生成技能
```

配置迁移采用备份与原子写入；无效 JSON 会中止启动并保留原文件。钱包状态查询和启动配置恢复不调用开户或扣费接口。
