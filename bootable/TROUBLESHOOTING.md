# M-Claw Bootable USB 故障排除指南

## 常见问题与解决方案

### 1. Ventoy安装失败

**问题**: Ventoy安装时提示"Access Denied"或无法写入U盘
**解决方案**:
1. 以管理员身份运行PowerShell
2. 关闭所有可能占用U盘的程序（文件资源管理器、杀毒软件等）
3. 尝试使用Ventoy的"只读模式"安装
4. 如果U盘有写保护开关，请关闭它

### 2. Ubuntu ISO下载缓慢或失败

**问题**: 下载Ubuntu ISO时速度慢或中断
**解决方案**:
1. 脚本会自动尝试多个国内镜像（清华、阿里、中科大）
2. 如果全部失败，可以手动下载：
   - 访问 https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/
   - 下载 `ubuntu-24.04.4-desktop-amd64.iso`
   - 放到 `bootable/.download-cache/` 目录
3. 重新运行 `2-download-iso.ps1`

### 3. 持久化存储创建失败

**问题**: `3-create-persistence.ps1` 提示磁盘空间不足
**解决方案**:
1. 确保U盘至少有32GB空间
2. 默认持久化大小为20GB，可以修改脚本中的 `$PersistenceSizeGB` 变量
3. 最小建议值：8GB

### 4. Linux启动后无法进入桌面

**问题**: 从U盘启动后黑屏或卡住
**解决方案**:
1. 启动时按 `F6` 或 `Esc` 进入引导选项
2. 添加内核参数：
   - `nomodeset` - 禁用显卡驱动
   - `quiet splash` - 禁用启动画面
3. 如果使用NVIDIA显卡，尝试 `nouveau.modeset=0`

### 5. OpenClaw安装失败

**问题**: `setup-openclaw.sh` 执行失败
**解决方案**:
1. **网络问题**:
   ```bash
   # 测试网络连接
   ping -c 3 npmmirror.com
   
   # 如果网络有问题，使用代理
   export http_proxy=http://your-proxy:port
   export https_proxy=http://your-proxy:port
   ```

2. **权限问题**:
   ```bash
   # 确保以root运行
   sudo bash setup-openclaw.sh
   ```

3. **依赖问题**:
   ```bash
   # 手动安装依赖
   sudo apt-get update
   sudo apt-get install curl xdg-utils
   ```

### 6. OpenClaw无法启动

**问题**: `start-openclaw.sh` 启动失败
**解决方案**:
1. **检查Node.js**:
   ```bash
   /opt/u-claw/runtime/node-linux-x64/bin/node --version
   # 应该显示 v22.14.0
   ```

2. **检查OpenClaw安装**:
   ```bash
   ls -la /opt/u-claw/core/node_modules/openclaw/
   ```

3. **端口冲突**:
   ```bash
   # 检查端口占用
   ss -tlnp | grep :18789
   
   # 如果端口被占用，手动指定端口
   cd /opt/u-claw/core
   node node_modules/openclaw/openclaw.mjs gateway run --port 18800
   ```

### 7. 浏览器无法打开

**问题**: 启动后浏览器没有自动打开
**解决方案**:
1. **手动打开浏览器**:
   - 访问 http://localhost:18789
   - 或 http://127.0.0.1:18789

2. **检查防火墙**:
   ```bash
   # Ubuntu Live通常没有防火墙，但可以检查
   sudo ufw status
   ```

### 8. 持久化数据丢失

**问题**: 重启后安装的软件或数据丢失
**解决方案**:
1. 确保启动时选择了"Ubuntu (persistence)"选项
2. 检查持久化文件大小:
   ```bash
   ls -lh /media/ubuntu/persistence.dat
   # 应该显示约20GB
   ```

3. 如果持久化损坏，重新创建:
   ```bash
   # 在Windows上重新运行 3-create-persistence.ps1
   ```

### 9. 性能问题

**问题**: 系统运行缓慢
**解决方案**:
1. **使用USB 3.0接口**（蓝色接口）
2. **关闭不必要的特效**:
   ```bash
   # 安装gnome-tweaks调整性能
   sudo apt-get install gnome-tweaks
   ```
3. **增加swap空间**（仅限持久化模式）:
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

### 10. 硬件兼容性问题

**问题**: 某些硬件不工作（WiFi、蓝牙、声卡等）
**解决方案**:
1. **更新内核**（仅限持久化模式）:
   ```bash
   sudo apt-get update
   sudo apt-get install linux-generic-hwe-24.04
   ```

2. **安装额外驱动**:
   ```bash
   # 检查可用驱动
   ubuntu-drivers devices
   
   # 安装推荐驱动
   sudo ubuntu-drivers autoinstall
   ```

## 调试技巧

### 查看日志
```bash
# OpenClaw日志
tail -f /opt/u-claw/data/logs/openclaw.log

# 系统日志
dmesg | tail -20
journalctl -xe
```

### 测试网络
```bash
# 测试国内镜像
curl -I https://registry.npmmirror.com
curl -I https://npmmirror.com/mirrors/node

# 测试AI API
curl https://api.deepseek.com/health
```

### 检查磁盘使用
```bash
# 查看U盘使用情况
df -h /media/ubuntu

# 查看大文件
du -sh /opt/u-claw/*
```

## 紧急恢复

如果系统完全无法启动：

1. **从其他电脑访问U盘**:
   - 在Windows/Mac上插入U盘
   - 备份 `u-claw-linux/` 目录下的重要数据

2. **重新制作U盘**:
   - 格式化U盘
   - 重新运行所有4个PowerShell脚本

3. **寻求帮助**:
   - GitHub Issues: https://github.com/dongsheng123132/u-claw/issues
   - 微信: hecare888

## 性能优化建议

1. **制作时**:
   - 使用高质量的USB 3.0 U盘
   - 分配足够的持久化空间（建议20GB+）
   - 关闭杀毒软件实时扫描

2. **使用时**:
   - 首次启动后运行系统更新
   - 安装推荐驱动
   - 定期清理缓存

3. **长期使用**:
   - 考虑安装到硬盘（双系统）
   - 定期备份重要数据
   - 关注Ubuntu安全更新