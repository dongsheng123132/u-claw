# Handoff Document — M-Claw Linux Remote Access

## Current Status

- U盘已就绪：Ventoy + Ubuntu 24.04 ISO + persistence + u-claw-linux scripts
- 所有源码已推送到 GitHub main 分支
- website/guide.html 已添加快速命令参考卡片
- enable-ssh.sh 已添加到 bootable/linux-setup/

## Linux 启动后需要做的事

1. 从 U 盘启动 → Ventoy 菜单选 Ubuntu
2. 如果首次使用，格式化持久化：
   ```
   sudo bash /media/*/Ventoy/u-claw-linux/format-persistence.sh
   ```
   然后重启
3. 连接 WiFi
4. 安装 OpenClaw：
   ```
   sudo bash /media/*/Ventoy/u-claw-linux/setup-openclaw.sh
   ```
5. 启用 SSH（让 Mac mini 远程控制）：
   ```
   sudo bash /media/*/Ventoy/u-claw-linux/enable-ssh.sh
   ```

## SSH 连接信息

- **用户名**: ubuntu (Live USB 默认用户)
- **密码**: 运行 enable-ssh.sh 时设置
- **IP 地址**: 运行 enable-ssh.sh 后会显示，格式类似 192.168.x.x
- **前提**: 两台机器在同一个 WiFi/局域网下

## Mac mini Claude Code 接手方法

1. 用户在 Linux 上运行 `enable-ssh.sh`，获取 IP 和设置密码
2. 用户告诉 Mac mini 上的 Claude Code：IP 地址和密码
3. Mac mini Claude Code 通过 Bash 工具执行：
   ```
   ssh ubuntu@<IP> 'command'
   ```
   或建立持久连接进行调试

## 文件位置（Linux 上）

| 路径 | 说明 |
|------|------|
| `/media/*/Ventoy/u-claw-linux/` | U 盘上的脚本 |
| `/opt/u-claw/` | 安装后的 OpenClaw |
| `/opt/u-claw/start-openclaw.sh` | 启动脚本 |
| `/opt/u-claw/data/.openclaw/openclaw.json` | 配置文件 |

## 注意事项

- Live USB 每次重启后，除了持久化分区内的数据，其他都会重置
- SSH server 需要每次重启后重新安装（除非持久化生效）
- 持久化生效后，apt 安装的包会保留

## 2026-03-17 修复：persistence.dat 未格式化导致启动失败

### 问题
- U 盘上的 `persistence.dat`（20GB）是空文件，没有 ext4 文件系统
- `3-create-persistence.ps1` 因无可用标准 WSL，走了 Method B，只创建了稀疏空文件
- Ventoy 启动 Ubuntu → 读 ventoy.json → 尝试挂载空的 persistence.dat → mount 失败 → 卡在 initramfs

### 修复过程
1. 用 docker-desktop WSL 的 `/sbin/mkfs.ext4` 格式化：
   - 在 WSL 内创建稀疏文件：`dd if=/dev/zero of=/tmp/persistence.dat bs=1M count=0 seek=20480`
   - 格式化：`/sbin/mkfs.ext4 -F -L casper-rw /tmp/persistence.dat`
   - 复制到 C: → 移动到 E:（因为 docker-desktop WSL 无法直接访问 E: 盘）
2. 验证：offset 1080 处读到 `53 EF`（little-endian `0xEF53`），确认 ext4 有效

### 代码改进
- `3-create-persistence.ps1` Method B 现在会尝试 docker-desktop WSL 格式化
- 添加了 ext4 magic number 验证步骤
- 只有在完全没有任何 WSL 时才降级为未格式化的空文件
