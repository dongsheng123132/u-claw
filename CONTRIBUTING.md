# 贡献指南 / Contributing to U-Claw

感谢有兴趣参与 U-Claw 开发！这份文档会告诉你怎么开始、怎么提 issue、怎么提 PR。

## TL;DR

- **报 bug** → 用 [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.md)，**贴完整报错**，不要只发截图
- **提需求** → 用 [Feature 模板](.github/ISSUE_TEMPLATE/feature_request.md)，先说清楚使用场景
- **写代码** → fork → 改 → 自己跑过 → 提 PR，PR 说明照模板填，不要空白 PR
- **改文档** → 直接 PR 即可
- **加功能之前** → 先读下面的[范围](#范围)，过一遍“新功能三问”

## 项目结构（记住这个心智模型）

> **本仓库 = U 盘骨架**：脚本 + HTML + 小文件
> **`bash setup.sh` 之后 = U 盘内容**：骨架 + Node.js + OpenClaw

两种发布形态，互相独立，改其中一个不影响其它：

| 目录 | 形态 | 入口 |
|------|------|------|
| `portable/` | 便携 USB | `setup.sh` → `Mac-Start.command` / `Windows-Start.bat` |
| `install/` | 一键在线安装 | `install.sh` (Mac/Linux) / `install.ps1` (Windows) |

## 范围

> 2026-10-06 按“范围剃刀”定下（PR #79）。改范围先改这一节，再改代码；功能和 PR 都拿下面的边界规则判断。

- **定位**：让听说过龙虾的小白，插上 U 盘双击就用上 OpenClaw——模型和额度一键到位，换台电脑插上接着用。
- **验收路径**：没碰过命令行的人，在干净的 Windows 电脑上插 U 盘双击，5 分钟内领到虾盘云额度、在 Dashboard 里和龙虾说上话；拔下来插到另一台电脑，1 分钟内用同一个钱包接着用。
- **边界规则**：配置中心只管“让龙虾开口”——模型、密钥、钱。OpenClaw 自己能做的（聊天渠道、技能、插件、Agent 设置），U-Claw 不再包一层。
- **永远不做**：代人托管 / 代运行聊天机器人；自建技能或插件市场；多人或团队账号。
- **现在不做**（有真实用户持续在要再说）：配置中心里同时管理多个模型服务（#61、#23）；cc switch（#63）。
- **新功能三问**（三个都答得上才提）：现在有真实用户在要吗？能不能用现有核心表达，而不是新开一块？坏了怎么发现、谁来修？

### 便携版减法与磁盘边界（2026-10-19）

- 双击 Start 是主路径：首次配置模型，保存后等待网关真正就绪再在同一页进入 WebUI；已配置直接进入 WebUI。设置入口必须始终可找回；维护入口只负责诊断、日志、备份恢复和原生 CLI，不再提供第二套网关启动、渠道向导、工厂重置、泛化清理或按端口杀进程。
- 保留虾盘云设备钱包和自填 Key / 更换模型。钱包不是激活门禁；切换模型不能删除钱包 provider，也不能在启动时重写用户的模型、渠道、Agent 和插件配置。钱包凭证及余额归属继续沿用现有服务端协议，不由硬件指纹派生密钥。
- 删除随盘 `skills-cn/` 附加内容和重复页面，保留 OpenClaw 原生技能、文件/工具调用、浏览器、定时任务、多 Agent 与多模态接入机制；高级能力按上游原生方式使用，不新增 U-Claw 管理台，也不以修改上游打包 JS 的方式隐藏菜单。安全鉴权与设备配对不得因减法移除。
- Node 编译缓存、npm 缓存、受管浏览器 profile、临时文件和运行日志放宿主机本地硬盘，按便携实例隔离；本机首选目录失败时尝试其他本机目录，不静默回落到 U 盘频繁写。浏览器 profile 含本机登录态，不承诺随盘迁移。配置、钱包/密钥存储、会话、记忆与用户文件仍随盘，不把整个 STATE_DIR 搬到本机。
- 不自动追随上游、不在启动时请求失效的更新清单；升级以经过验证的稳定整包为单位，保留手动查看发行页入口。
- 本机缓存候选目录全都不可写时，进入本地 WebUI 的启动、CLI 和体检工具明确告警并退出，不静默把浏览器/临时高频数据写回 U 盘；诊断仍可给出该错误。浏览器 profile 含本机登录态，不承诺随盘迁移。
- 验收除首启对话外，须覆盖换模型后钱包和高级配置保留、日志/缓存实际落本机、重复启动、故障恢复和旧漏洞回归；发布前分别在干净 Windows + exFAT U 盘、macOS 上验对应路径。开发机测试不等于这些真机验收。

已移出的功能（聊天渠道入口、微信扫码、Config.html 等旧页面、SkillHub、Electron 桌面版、本地模型发现、Linux 可启动盘）可从 tag `archive/pre-scope-razor-2026-10-05` 找回；Linux 可启动盘在独立仓库 [u-claw-linux](https://github.com/dongsheng123132/u-claw-linux) 继续维护。

## 开发环境

```bash
# 1. Clone
git clone https://github.com/dongsheng123132/u-claw.git
cd u-claw

# 2. 选一个形态调试。最快的是 portable/
cd portable
bash setup.sh                    # 下载 Node.js + OpenClaw 到 app/
bash Mac-Start.command           # macOS 启动
# 或 Windows: 双击 Windows-Start.bat
```

平台支持现状：

- macOS Apple Silicon (ARM64)：✅ 主开发平台
- macOS Intel：✅ 工作（需先跑 setup.sh 下 node-mac-x64）
- Windows x64：🚧 持续完善

## 提 Issue 的好习惯

### 报 bug

**至少包含这四样**：

1. 操作系统 + 版本（如 macOS 14.5 / Windows 11 23H2）
2. 使用的形态（portable / install）
3. **完整的错误日志**（贴文字，不要只截图）
4. 你试过哪些步骤

不写复现步骤的 issue，维护者通常没办法处理。

### 提需求

- 先说**使用场景**，再说功能。
- "我希望能 X" → 不够。"我在做 Y，需要 X，因为 Z" → 才能讨论。

## 提 PR 的好习惯

### 提交前先想清楚

1. **改动是不是真的有人需要？** 大改动建议先开 issue 讨论。
2. **改动会不会破坏其它形态？** 比如改 `portable/` 不要影响 `install/`。
3. **你跑过吗？** PR 模板里要求列出测试方式，不是装饰。

### 不要做的事

- ❌ 提交 `node_modules/`、`app/`、`data/`、`*.dmg`、`*.exe`（已在 `.gitignore`）
- ❌ 把 API Key、Token、密码写进任何文件
- ❌ 改 README 加自己的推广链接
- ❌ 提空白 PR（只有标题没说明）—— 会直接关闭
- ❌ 大规模格式化无关代码（"顺手 prettier 全仓"这种）

### Commit message

短、说人话、能让维护者一眼看懂改了什么：

```
fix(portable): node-extract path missing intermediate dir
fix(install.sh): npm wrapper不能用 node 直接执行
docs: 补充 Windows 11 ARM64 支持说明
feat(portable): 维护菜单增加备份入口
```

不接受："update"、"fix"、"修改若干文件" 这种。

### 分支与 PR 流程

```bash
# 1. fork → clone 你的 fork
git clone https://github.com/<你的用户名>/u-claw.git

# 2. 创建分支（不要在 main 上直接改）
git checkout -b fix/install-sh-npm-path

# 3. 改 → 自己跑过 → 提交
git add <具体文件>          # 不要 git add .
git commit -m "fix(install): ..."

# 4. 推到你的 fork
git push origin fix/install-sh-npm-path

# 5. 在 GitHub 上发起 PR，填好模板
```

## 修改各形态时的注意事项

### `portable/`

- **不要在仓库里提交 `app/` 或 `data/`**，那是 `setup.sh` 下载/生成的
- Mac 启动脚本要 `chmod +x`，并清理 quarantine 属性
- Windows 启动脚本要正确处理 `cd /d "%DIR%core"`
- 配置文件放 `data/.openclaw/openclaw.json`，便携属性靠这个

### `install/`

- Mac/Linux 走 `install.sh`，Windows 走 `install.ps1`
- 全部走 npmmirror.com 镜像，不能假设用户能访问 GitHub/npm 官方
- 安装目录固定为 `~/.uclaw/`（Mac/Linux）或 `%USERPROFILE%\.uclaw\`（Windows）
- 启动脚本要找空闲端口（18789-18799），不要写死

## 行为准则

简单说：

- 对人有礼貌，对事可以严格
- 不要在 issue 里互相攻击
- 维护者可能回复慢（这是开源副业），请耐心
- 不接受任何形式的歧视、骚扰、钓鱼

## 联系

- Issue 区：日常问题、bug、需求
- 官网：[u-claw.org](https://u-claw.org)
- 邮件（仅紧急安全问题）：见 README

---

再次感谢！🦞
