# 贡献指南 / Contributing to U-Claw

感谢有兴趣参与 U-Claw 开发！这份文档会告诉你怎么开始、怎么提 issue、怎么提 PR。

## TL;DR

- **报 bug** → 用 [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.md)，**贴完整报错**，不要只发截图
- **提需求** → 用 [Feature 模板](.github/ISSUE_TEMPLATE/feature_request.md)，先说清楚使用场景
- **写代码** → fork → 改 → 自己跑过 → 提 PR，PR 说明照模板填，不要空白 PR
- **改文档** → 直接 PR 即可

## 项目结构（记住这个心智模型）

> **本仓库 = U 盘骨架**：脚本 + HTML + 小文件
> **`bash setup.sh` 之后 = U 盘内容**：骨架 + Node.js + OpenClaw

两种发布形态，互相独立，改其中一个不影响其它：

| 目录 | 形态 | 入口 |
|------|------|------|
| `portable/` | 便携 USB | `setup.sh` → `Mac-Start.command` / `Windows-Start.bat` |
| `install/` | 一键在线安装 | `install.sh` (Mac/Linux) / `install.ps1` (Windows) |

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
feat(skills-cn): 增加 douyin-script 技能
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

### `skills-cn/`

- 技能格式是 `<skill-name>/SKILL.md`，frontmatter 里有 `name`、`description`、`metadata`
- 技能内容用中文写，给中国用户看
- 提交新技能前先看现有技能（小红书/微博/B 站等）的写法

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
