# U-Claw Mac mini 实测报告 — 最新版本 + 真实 Key 对话验证

测试完成时间：2026-10-14 21:20（北京时间）

## 1. 测试环境

| 项 | 值 |
|---|---|
| 目标设备 | `dsenmac-mini-iyji`（主机名 dsenmac-mini，100.101.36.32），macOS 15.6.1 (24G90)，Apple Silicon arm64 |
| 被测版本 | Windows 工作树最新内容（HEAD `a34960a` + 全部未提交改动），OpenClaw **2026.10.2**，Node 24.16.0（便携运行时，复用上次安装，未重新下载） |
| 测试目录 | `/private/tmp/uclaw-macmini-20261014-655f/portable`（真实路径，规避 /tmp 软链接缺陷） |
| 真实 Key | DeepSeek 官方 API Key（用户提供，`sk-01…cd0f`），仅写入测试配置，测试后无残留 |
| 验证方式 | 骨架 tar 增量同步 → 启动器/手动 gateway 启动 → OpenClaw CLI `agent` 发真实消息 → 日志/RPC/端口核对 |

## 2. 结果总览

| 验证项 | 结果 |
|---|---|
| 最新骨架同步（含未提交改动） | ✅ 通过（2.3MB tar 覆盖，`app/` 运行时原样保留） |
| 真实路径启动 `Mac-Start.command` | ✅ 通过，约 8 秒就绪（config-server 18788 + gateway 18789 均在监听） |
| 重复启动复用实例 | ✅ 通过（第二次运行输出 "already running; reusing the existing instance."） |
| 停止后重启 | ✅ 通过（端口释放 → 再启动 8s 就绪，`/ready` HTTP 200） |
| 软链接路径缺陷（/tmp） | ❌ **仍存在**（见 §4） |
| **用户真实路径对话**（配 Key → 启动器 → 发消息） | ❌ **失败：启动器清空全部 provider，报 Unknown model**（见 §3） |
| **模型链路真实对话**（绕过启动器简化，DeepSeek 直配） | ✅ **通过："你好"，2488ms，deepseek/deepseek-v4-pro**（见 §3） |
| Key 泄露检查（日志/配置明文 grep） | ✅ 无残留 |

## 3. 真实 Key 对话验证（本次重点）

### 阶段 A — 产品真实用户路径（失败，暴露缺陷）

按用户正常使用方式：把 DeepSeek Key 写入配置 → 运行 `Mac-Start.command` 启动。

- 启动本身正常：8 秒就绪，`/ready`、`/health` 均通过，WebSocket/control-ui 连接正常，RPC 批量正常响应。
- **但启动完成后配置被强制改写**：`models.providers` 从 `{deepseek: {...key...}}` 变为 **空 `[]`**，默认模型被强制设为 `uclaw-cloud/deepseek-v4-flash`。
- `models status`：默认模型 `uclaw-cloud/deepseek-v4-flash`，`[indeterminate] Auth readiness could not be confirmed`，0 个已配置 provider。
- `openclaw agent --message "请只回复两个字：你好"` → **失败**：

```
"error": { "type": "cli_error",
  "message": "Unknown model: uclaw-cloud/deepseek-v4-flash.
  Found agents.defaults.models[\"uclaw-cloud/deepseek-v4-flash\"], but no matching
  models.providers[\"uclaw-cloud\"].models[] entry." }
```

**根因**：`prepare-wallet.mjs` 每次启动都调用 `merge-config.mjs` 的 `simplifyPortableConfig()`，该函数无条件执行：

```js
next.models = { mode: 'replace', providers: provider ? { 'uclaw-cloud': {...} } : {} };
next.agents.defaults.model = { primary: 'uclaw-cloud/deepseek-v4-flash' };
```

即：把 providers 清成只保留 `uclaw-cloud`（当前无该 provider 则**全部清空**），默认模型强制指向虾盘云中转（`api.u-claw.org`，无 Key 时不可用）。config-server 的配置保存流程（server.js）同样经过 `simplifyPortableConfig`，因此 **Config.html 里填的 DeepSeek/Kimi/GLM/Qwen Key 保存或重启后也会被清掉**，与 Config.html / models-catalog.json 提供多 provider 入口直接冲突。

### 阶段 B — 模型链路验证（通过）

绕过启动器的强制简化（手动写入 `deepseek` provider + Key + 默认模型 `deepseek/deepseek-v4-pro`，手动启动 gateway），发同一条真实消息：

```
"status": "ok", "summary": "completed"
result.payloads[0].text = "你好"
meta: durationMs = 2488
      provider = "deepseek", model = "deepseek-v4-pro"
      credentialSource = { kind: "direct", evidence: "provider-config", authorization: "declared" }
      usage: input 17970 / output 1 tokens
```

**结论**：Key 有效、OpenClaw 2026.10.2 模型链路正常。真实对话跑不通的瓶颈在启动器/保存链路的 `simplifyPortableConfig` 强制清空行为，而非 Key 或模型本身。

## 4. 软链接路径缺陷（上次遗留，确认未修复）

`lib/runtime-requirements.mjs` 等辅助脚本仍用未经 realpath 的 `process.argv[1]` 与 `import.meta.url` 做字符串比较（当前工作树未改）。本次精确复现：

| 调用路径 | 输出 | 退出码 |
|---|---|---|
| 真实绝对路径 `/private/tmp/…` | `UCLAW_SETUP_NEEDED=0` | 0 |
| 软链接绝对路径 `/tmp/…` | **stdout 为空** | 0 |

与上次报告一致。后果：经软链接路径（如 `/tmp`）运行启动器会静默跳过 CLI 入口 → 误判"需要 setup" → 重新执行 `setup.sh` → 报"更新后运行环境仍不符合要求"。

## 5. 建议

1. **`simplifyPortableConfig` 不得清空用户已配置的 provider**：`providers` 应采用合并策略（保留 `uclaw-cloud` 之外的用户 provider），或仅当 `uclaw-cloud` 存在时替换默认模型指向；修复后需回归：配官方 Key → 走启动器 → Key 保留且对话可用。
2. **修复软链接路径缺陷**：所有 Node 辅助脚本 CLI 入口统一用 `realpath` 解析 `process.argv[1]` / `import.meta.url` 后再比较，并增加软链接目录启动回归用例。
3. 默认模型强制指向无 Key 的虾盘云时，应在 `models status`/UI 给出明确引导（如"未配置虾盘云 Key"），而不是让用户面对 `Unknown model`。

## 6. 局限与未覆盖

- 未测：U 盘/exFAT 性能、Intel Mac、Windows 版、虾盘云真实 Key（本次使用 DeepSeek 官方 Key）、签名与干净机环境。
- UI 未人工点击验收（本报告以 HTTP 资源 + 真实 RPC/CLI 调用为准）。
- 按用户工作流本应调用本机 `claude` CLI（opus）复核 §3 缺陷定性，但本机 claude OAuth 会话已过期无法认证，故结论以代码阅读 + 实测证据为准，未取第三方复核意见。
- 测试目录 `/private/tmp/uclaw-macmini-20261014-655f` 保留供复查；未改动用户正式安装目录与 `~/.openclaw` 配置（仅只读检查）。
