# 安全策略 / Security Policy

感谢你关注 U-Claw 的安全性。本文档说明如何向我们报告安全漏洞，以及我们当前支持的版本。

## 报告漏洞 / Reporting a Vulnerability

**请不要在公开 issue 里发布安全漏洞细节。**

如果你发现了 U-Claw 的安全问题，请通过以下任一渠道私下联系：

- 邮件：`hefangsheng@u-claw.org`（建议附 PoC、影响范围、复现步骤）
- GitHub 私密漏洞报告：在 [u-claw 仓库](https://github.com/dongsheng123132/u-claw) 的 Security 标签页 → "Report a vulnerability"

我们会在 **3 个工作日内** 确认收到，并在 **14 天内** 给出初步评估。请允许我们在公开披露前修复问题。

### 报告内容建议

- 受影响的模块（portable / install）
- 受影响的版本或 commit hash
- 触发条件、攻击面（本地 / 局域网 / 互联网）
- 复现步骤或 PoC 代码
- 你建议的缓解或修复方向

## 支持的版本 / Supported Versions

| 模块 | 版本 | 状态 |
|------|------|------|
| `portable/` | 当前 main | ✅ 接受报告 |
| `install/` (`install.sh` / `install.ps1`) | 当前 main | ✅ 接受报告 |
| 历史 release tag | — | ⚠️ 仅做严重等级评估，不一定回滚补丁 |

我们暂未发布稳定版本号，所有修复直接在 main 分支推送。

## 范围 / In-Scope vs Out-of-Scope

### 在范围内（请报告）

- U-Claw 自身脚本中的命令注入、路径穿越、任意写入、代码执行
- `data/.openclaw/openclaw.json` 配置加载/写入逻辑中的注入
- 启动脚本（`Mac-Start.command` / `Windows-Start.bat` / `start.sh`）
  在恶意目录名/环境变量下被劫持的可能
- 一键安装 (`curl | bash` / `irm | iex`) 链路上的 MITM 风险

### 不在范围内

- 上游依赖（Node.js / OpenClaw）的漏洞 —
  请直接报给上游项目；我们只跟踪并升级版本。
- 用户主动把自己的 API Key 写到公开仓库 / 截图泄露，不属于本项目缺陷。
- 物理接触 USB 后的所有攻击（含偷换 USB、键盘记录等），属于硬件安全场景。
- 在用户已经获得 admin/root 权限的情况下能做的进一步动作。

## 致谢 / Acknowledgements

发现并负责任披露安全问题的研究者，将在修复发布的 commit message 和 release notes 中署名感谢（除非你要求匿名）。

---

> 本策略借鉴了 GitHub 推荐的开源安全披露格式，未来会随项目成熟度更新。
