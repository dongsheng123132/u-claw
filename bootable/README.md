# M-Claw Bootable USB (Linux)

> **把任意电脑变成 AI 工作站 — 插上 U 盘，开机即用**
>
> **Turn any computer into an AI workstation — just boot from USB**

## 独立性说明

本目录 (`bootable/`) 在 u-claw 主仓库中保持**目录级别的独立**：

- 不依赖仓库内 `portable/`、`u-claw-app/`、`website/` 中的任何文件
- 所有脚本内部硬编码了 URL 和路径，完全自包含
- 出问题只影响 `bootable/` 自身，不会波及其他模块
- 同时维护了一份**独立仓库**：[u-claw-linux](https://github.com/dongsheng123132/u-claw-linux)，内容一致

## 这是什么

制作一个**可启动的 Linux AI U 盘**：

- 插上任意电脑，从 U 盘启动，直接进入 Ubuntu 桌面
- 一键安装 OpenClaw AI 助手，桌面图标双击即用
- 内置持久化存储，安装的软件和数据重启后保留
- **不需要目标电脑有任何操作系统**

> 与便携版（`portable/`）的区别：便携版需要电脑已有 Windows/Mac 系统，可启动版连系统都不需要。

## 技术方案

```
┌────────────────────────────────────────────┐
│                U 盘结构                      │
│                                            │
│  Ventoy 引导区（隐藏分区）                   │
│    - BIOS + UEFI 双模式启动                  │
│    - 开源引导管理器 v1.0.99                  │
│                                            │
│  Ventoy 数据分区（可见）                     │
│    ubuntu-24.04.4-desktop-amd64.iso  5.8GB │
│    persistence.dat                   20GB  │
│    ventoy/ventoy.json                配置   │
│    u-claw-linux/                     脚本   │
│      ├── setup-openclaw.sh                 │
│      └── start-openclaw.sh                 │
└────────────────────────────────────────────┘
```

**三个核心技术选型：**

| 技术 | 为什么选它 |
|------|-----------|
| **Ventoy 1.0.99** | ISO 文件直接丢进去就能启动，不用烧录，可放多个系统 |
| **Ubuntu 24.04 LTS** | 长期支持版，驱动兼容性最好，社区最大 |
| **casper-rw 持久化** | 让 Live USB 也能保存数据，重启不丢失 |

## 硬件要求

| 项目 | 要求 |
|------|------|
| U 盘 | **32GB+**，强烈推荐 USB 3.0（蓝色接口） |
| 制作环境 | Windows 10/11，PowerShell 5.1+ |
| 目标电脑 | x86_64（Intel / AMD），任意品牌 |
| 网络 | 首次安装 OpenClaw 时需要联网 |

## 快速制作（4 步）

在 Windows 上以**管理员身份**打开 PowerShell：

```powershell
cd path\to\u-claw\bootable

# Step 1: 下载 Ventoy 并写入 U 盘（会格式化！）
.\1-prepare-usb.ps1

# Step 2: 下载 Ubuntu 24.04 ISO（~5.8GB，国内镜像）
.\2-download-iso.ps1

# Step 3: 创建持久化镜像（默认 20GB）
.\3-create-persistence.ps1

# Step 4: 拷贝所有文件到 U 盘
.\4-copy-to-usb.ps1
```

## 每一步做了什么

### Step 1: 写入 Ventoy 引导 (`1-prepare-usb.ps1`)

- 列出所有 USB 设备，让你确认
- 从 GitHub 下载 Ventoy 1.0.99
- 启动 Ventoy2Disk.exe GUI
- 你在 GUI 中选择 U 盘 → 点 Install
- **注意：会格式化 U 盘，数据全丢！提前备份！**

### Step 2: 下载 Ubuntu ISO (`2-download-iso.ps1`)

- 从国内镜像下载 Ubuntu 24.04.4 桌面版（~5.8GB）
- 镜像优先级：清华 → 阿里 → 中科大 → 官方
- SHA256 校验确保文件完整
- 有缓存，不会重复下载

### Step 3: 创建持久化镜像 (`3-create-persistence.ps1`)

这是整个方案**最关键**的一步：

- 检测是否安装了 WSL（Windows 子系统 Linux）
- **有 WSL** → 用 `mkfs.ext4` 直接创建格式化好的 ext4 镜像
- **没 WSL** → 创建稀疏文件，首次进 Linux 后需手动格式化
- 卷标必须是 `casper-rw`（Ubuntu 持久化的约定）
- 默认 20GB，可选 1-28GB

### Step 4: 拷贝到 U 盘 (`4-copy-to-usb.ps1`)

- 自动识别 Ventoy U 盘（通过卷标）
- 检查剩余空间
- 拷贝 4 样东西：ISO、persistence.dat、ventoy.json、安装脚本

## 使用方法

### 首次使用

1. 将 U 盘插入目标电脑
2. 开机按启动键：

| 品牌 | 启动键 |
|------|--------|
| Dell 戴尔 | F12 |
| Lenovo 联想 | F12 |
| HP 惠普 | F9 |
| ASUS 华硕 | F2 或 DEL |
| Acer 宏碁 | F12 |
| MSI 微星 | F11 |
| Huawei 华为 | F12 |
| Xiaomi 小米 | F12 |

3. 启动菜单选择 USB 设备
4. Ventoy 菜单 → 选择 Ubuntu
5. 等待 Ubuntu 桌面加载
6. 连接 Wi-Fi
7. 打开终端（`Ctrl+Alt+T` 或右键桌面 → Open Terminal）
8. 运行安装命令：

```bash
sudo bash /media/*/Ventoy/u-claw-linux/setup-openclaw.sh
```

9. 桌面出现 **"M-Claw AI Assistant"** 图标
10. 双击图标 → 浏览器打开 → 配置 AI 模型

### 日常使用

1. 插入 U 盘 → 开机选 USB → Ubuntu 桌面
2. 双击桌面图标
3. 所有数据自动保留

## 安装脚本详解 (`setup-openclaw.sh`)

9 个步骤，完全自包含：

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | 检查 root 权限 | 必须 `sudo` 运行 |
| 2 | 安装系统依赖 | `curl`, `xdg-utils` |
| 3 | 创建目录 | `/opt/u-claw/{runtime,core,data}` |
| 4 | 下载 Node.js v22 | 国内镜像优先，官方回退 |
| 5 | 创建 package.json | — |
| 6 | 安装 OpenClaw + QQ 插件 | npm 国内镜像 |
| 7 | 写默认配置 | gateway + token |
| 8 | 安装启动脚本 | → `/opt/u-claw/` |
| 9 | 创建桌面快捷方式 | 可选开机自启 |

## 核心配置文件

### `ventoy/ventoy.json`

```json
{
  "persistence": [
    {
      "image": "/ubuntu-24.04.4-desktop-amd64.iso",
      "backend": "/persistence.dat",
      "autosel": 1
    }
  ]
}
```

告诉 Ventoy：启动 Ubuntu ISO 时自动加载 `persistence.dat`。`autosel: 1` = 不弹确认框。

### Linux 端环境变量

| 变量 | 值 |
|------|-----|
| `OPENCLAW_HOME` | `/opt/u-claw/data/.openclaw` |
| `OPENCLAW_STATE_DIR` | `/opt/u-claw/data/.openclaw` |
| `OPENCLAW_CONFIG_PATH` | `/opt/u-claw/data/.openclaw/openclaw.json` |

## 文件结构

```
bootable/
├── README.md                      本文件
├── 1-prepare-usb.ps1              Step 1: Ventoy 写入
├── 2-download-iso.ps1             Step 2: Ubuntu ISO 下载
├── 3-create-persistence.ps1       Step 3: 持久化镜像
├── 4-copy-to-usb.ps1              Step 4: 拷贝到 U 盘
├── linux-setup/
│   ├── format-persistence.sh      格式化持久化镜像
│   ├── setup-openclaw.sh          一键安装 OpenClaw
│   ├── start-openclaw.sh          启动脚本
│   └── openclaw.desktop           桌面快捷方式
└── ventoy/
    └── ventoy.json                Ventoy 持久化配置
```

## 实践经验与注意事项

### 制作阶段

1. **U 盘选择很重要**
   - 必须 32GB+（ISO 5.8GB + 持久化 20GB + 系统开销）
   - 强烈建议 USB 3.0，否则启动和运行都会很慢
   - 推荐品牌：闪迪、金士顿、三星（杂牌盘容易出问题）
   - 避免使用 USB Hub，直接插主板接口

2. **Step 1 会清空 U 盘**
   - Ventoy 安装会格式化整个 U 盘，**务必提前备份**
   - 脚本会列出所有 USB 设备让你确认，看清楚再操作

3. **Step 3 持久化镜像（重要教训）**
   - 有标准 WSL（Ubuntu 等）→ 自动创建 ext4 镜像（最省事）
   - 只有 docker-desktop WSL → 脚本会尝试用 `/sbin/mkfs.ext4` 格式化（2026-03-17 修复）
   - 完全没有 WSL → 创建空文件，**必须**首次进 Linux 后手动格式化：
     ```bash
     sudo mkfs.ext4 -F -L casper-rw /media/*/Ventoy/persistence.dat
     ```
     格式化后**必须重启**才能生效
   - **踩坑记录**：空的 persistence.dat（无 ext4 文件系统）会导致 Ventoy 挂载失败，
     Ubuntu 启动直接掉进 initramfs。验证方法：读取文件 offset 1080 处的 2 字节，
     应为 `0x53 0xEF`（ext4 magic number `0xEF53` 的 little-endian 表示）
   - 大小建议：32GB U 盘选 20GB，64GB U 盘可选 40GB+

4. **ISO 下载失败**
   - 脚本默认走清华/阿里/中科大国内镜像，无需翻墙
   - 如果全部失败，手动下载 Ubuntu ISO 放到 `.download-cache/` 目录即可

### 启动阶段

5. **Secure Boot 问题**
   - 部分电脑需要关闭 Secure Boot 才能从 U 盘启动
   - 进 BIOS → Security → Secure Boot → Disabled
   - 不同品牌进 BIOS 的方式不同（通常 DEL 或 F2）

6. **找不到 USB 启动项**
   - 换个 USB 口试试
   - 有些电脑默认禁用了 USB 启动，需要在 BIOS 中开启
   - Legacy/CSM 模式和 UEFI 模式都试试

7. **Ubuntu 桌面加载慢**
   - 正常现象，Live USB 从 U 盘读取比硬盘慢
   - USB 3.0 U 盘 + USB 3.0 接口会快很多
   - 首次加载约 1-3 分钟

### 使用阶段

8. **Wi-Fi 连接**
   - Ubuntu 24.04 支持大多数 Wi-Fi 芯片
   - 不行的话用手机 USB 共享网络，或 USB 无线网卡

9. **OpenClaw 安装需要网络**
   - 国内镜像优先，无需翻墙
   - 安装过程约 1-2 分钟

10. **端口冲突**
    - OpenClaw 使用端口 18789-18799
    - 提示端口占用 → 关闭终端窗口再重新打开

11. **数据位置**
    - 安装目录：`/opt/u-claw/`
    - 配置文件：`/opt/u-claw/data/.openclaw/openclaw.json`
    - 所有数据保存在持久化镜像中，重启不丢

12. **性能预期**
    - U 盘运行比硬盘慢，这是物理限制
    - AI 推理在云端，本地只跑网关，对话速度不受影响

## 常见故障排查

| 问题 | 解决方案 |
|------|---------|
| 无法从 U 盘启动 | BIOS 关闭 Secure Boot，开启 USB Boot |
| Ventoy 菜单无 Ubuntu | ISO 文件是否在 Ventoy 数据分区根目录 |
| 启动卡在 initramfs | persistence.dat 未格式化为 ext4，用 `mkfs.ext4 -F -L casper-rw` 格式化后重启 |
| 持久化不生效（重启丢数据） | persistence.dat 是否已格式化为 ext4，卷标是否为 `casper-rw` |
| OpenClaw 安装失败 | 检查网络，确认能访问 npmmirror.com |
| 浏览器打不开 | 手动打开浏览器访问 `http://localhost:18789` |
| 屏幕分辨率不对 | Settings → Displays → Resolution |

## 技术说明

- **Ventoy**: 开源引导管理器，ISO/WIM/VHD 直接启动，更新 ISO 不用重新格式化
- **Persistence**: Ventoy persistence 插件 + `casper-rw` 标签 ext4 镜像
- **Node.js**: v22.14.0 LTS，npmmirror.com（国内）或 nodejs.org
- **OpenClaw**: npm latest，安装到 `/opt/u-claw/`
- **完全独立**: 不引用仓库内 `portable/`、`u-claw-app/`、`website/` 的任何文件

## 详细故障排除

遇到问题请参考详细故障排除指南：
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - 完整的问题排查步骤和解决方案
