<!--
感谢贡献 U-Claw！请按以下模板填写，方便维护者审阅。
空白或仅有标题的 PR 通常会被关闭，请勿提交无说明的改动。
-->

## 改动类型 / Type

<!-- 勾选适用的（[x]） -->

- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] 📝 文档/README
- [ ] 🔧 脚本/构建（portable, install）
- [ ] 🎨 技能 (skills-cn)
- [ ] ♻️ 重构（不改变行为）
- [ ] 🧪 测试

## 改动了什么 / What

<!-- 一两句话说清楚这个 PR 做了什么。不要复制 git diff。 -->

## 为什么 / Why

<!-- 哪个 issue / 哪个使用场景驱动了这次改动？关联 issue: #xxx -->

## 测试方式 / How to verify

<!--
告诉维护者怎么验证。比如：
- 在 macOS Apple Silicon 上跑 `bash install/install.sh`，安装成功
- 双击 `portable/Mac-Start.command`，能正常打开 dashboard
- Windows 11 PowerShell 跑 `irm https://u-claw.org/install.ps1 | iex`，安装成功
-->

## 影响范围 / Scope

<!-- 勾选受影响的模块 -->

- [ ] portable/ (便携 USB)
- [ ] install/ (一键安装脚本)
- [ ] skills-cn/ (中国本地化技能)
- [ ] 仅文档

## 自检 / Checklist

- [ ] 我已经在本地实际跑过相关脚本/功能
- [ ] 没有提交 `node_modules/`、`app/`、`data/` 等运行时产物
- [ ] 没有把任何 API Key、Token 写进文件
- [ ] commit message 能说清楚改了什么
