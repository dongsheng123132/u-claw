# U-Claw 使用说明

U-Claw 是一款可以直接在 U 盘里运行的 AI 助手。把它拷贝到任何 Mac 或 Windows 电脑上，插上就能用，不需要安装任何东西。

---

## 第一次使用

### Windows 电脑（免安装）

**直接双击 `Windows-Start.bat` 就能用！**

如果提示缺少什么，再按以下步骤：

1. 把 U 盘插入电脑
2. 双击 `setup.bat`（下载必要文件）
3. 双击 `Windows-Start.bat`
4. 自动打开浏览器，出现控制面板

### Mac 电脑

1. 把 U 盘插入电脑
2. 双击 `setup.sh`（可能会提示输入密码，输入即可）
3. 双击 `Mac-Start.command`
4. 自动打开浏览器，出现控制面板

---

## 各功能说明

| 图标 | 文件名 | 做什么 |
|------|--------|--------|
| 🚀 | `Mac-Start.command` / `Windows-Start.bat` | **启动 U-Claw**（平时用这个） |
| 📋 | `Mac-Menu.command` / `Windows-Menu.bat` | 打开主菜单 |
| 🖥️ | `Mac-OpenClaw-CLI.command` / `OpenClaw-CLI.bat` | 命令行界面（一般不用） |
| 📦 | `Mac-Install-Skills.command` / `Install-Skills.bat` | 安装新技能 |
| 🔧 | `Install-Tools.bat` | 安装辅助工具（Windows 专用） |
| 🔍 | `Windows-Diagnose.bat` / `Mac-Diagnose.command` | 诊断问题 |

---

## 安装额外技能

如果有人给你技能文件（.zip 格式）：

1. 把技能文件复制到 U 盘的 `skill_zip` 文件夹里
2. 双击对应的安装脚本：
   - Mac：双击 `Mac-Install-Skills.command`
   - Windows：双击 `Install-Skills.bat`
3. 重启 U-Claw（新技能就出现了）

---

## 常见问题

**Q: 提示"无法打开"怎么办？**
> Mac 电脑首次运行会这样。右键点击文件 → 选择"打开" → 再点一次就能运行了。

**Q: 浏览器没自动打开？**
> 手动打开浏览器，输入地址：`http://127.0.0.1:18789`

**Q: 提示端口被占用？**
> U-Claw 会自动换端口，稍等几秒刷新浏览器。

**Q: 想停止 U-Claw？**
> 在终端窗口按 `Ctrl + C`

---

## 文件夹里都有什么

```
📁 U盘/
├── 📄 Mac-Start.command     ← 双击启动（Mac）
├── 📄 Windows-Start.bat     ← 双击启动（Windows）
├── 📁 app/                 ← 程序文件（不要动）
├── 📁 data/                ← 你的数据（不要动）
├── 📁 skills-cn/            ← 内置技能
├── 📁 skill_zip/           ← 放入要安装的技能
├── 📁 config-server/       ← 配置服务（不要动）
└── 📄 *.html               ← 网页界面
```

---

## 小贴士

- U 盘建议用 USB 3.0 以上，速度更快
- 第一次启动会自动下载必要文件，请保持网络连接
- 配置文件默认密码是 `uclaw`，可以在设置里修改
- 定期备份 `data` 文件夹里的内容，防止丢失重要数据
