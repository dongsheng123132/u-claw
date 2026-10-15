# 后备配置中心 JSON API

当前主入口是 OpenClaw WebUI 的原生设备钱包。`config-server/server.js` 保留本地后备配置页，钱包业务统一调用 `portable/lib/wallet-client.mjs`。

## 服务

服务绑定 `127.0.0.1`，优先端口 `18788`，占用时向下寻找至 `18778`；启动脚本通过 `<stateDir>/runtime.json` 获取实际端口。`UCLAW_CONFIG_PORT` 可用于隔离测试。配置路径由 `OPENCLAW_CONFIG_PATH` 指定，钱包存储为同一 `OPENCLAW_STATE_DIR` 内的 `uclaw-device.json`。

根路径 `/` 提供后备配置页面。HTTP API依赖本机服务与浏览器同源策略，无独立登录。CORS行为以 `server.js` 为准；调用方不应把钱包响应暴露到外部网页或日志。

## 有效端点

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/runtime` | 获取实际配置服务和 Gateway 端口 |
| GET | `/api/gateway-check?port=<port>` | 本机探测指定端口是否为 OpenClaw |
| GET | `/api/config` | 读取配置；已保存 provider Key 用引用占位值返回，敏感环境字段不回显 |
| POST | `/api/config` | 保存唯一虾盘云模型；新 Key 经 secrets CLI stdin 写入本机 store，配置写 SecretRef |
| GET | `/api/update-status` | 读取本地更新状态 |
| POST | `/api/update-check` | 用户显式检查更新 |
| GET | `/api/wallet/status` | 本地钱包状态；必要时沿用旧模型 Key/SecretRef恢复钱包，不开户 |
| POST | `/api/wallet/claim` | 用户领取钱包；已有钱包沿用同一密钥并恢复模型配置 |
| GET | `/api/wallet/balance` | 查询余额与用量；返回 `remainingUsd`、`usedUsd`、对应 quota |
| POST | `/api/wallet/rotate` | 用户确认后轮换密钥，保留钱包余额 |
| POST | `/api/wallet/adopt` | body `{"key":"已有密钥"}`；只读验证后启用同一钱包 |
| POST | `/api/wallet/reset-local` | 用户确认已备份后移除本机记录及模型 Key，不清除服务端余额 |

`/api/local-models`、`/api/provider-models` 和全部 `/api/wechat/*` 路由已删除，返回 404。没有飞书、Telegram 或 QQ 接入路由。

## 配置保存

保存复用 `merge-config.mjs`：移除渠道配置，保留非模型字段；模型和默认模型列表收敛为 `uclaw-cloud/deepseek-v4-flash`。旧文件先备份为 `.bak`，再使用同目录临时文件原子替换。已保存 Key 的占位值用于保留原值，禁止把掩码作为新密钥保存。

成功响应含 `ok: true`。Gateway 尚未运行时可能包含 `pendingRestart: true`；热重载失败可能包含 `reloadError`。这些字段表示配置已落盘，但需要重启后生效。失败响应带 `error`，调用方应检查 HTTP 状态与 `ok`。

## 钱包与权限

后备 HTTP 钱包状态响应为兼容既有复制和充值操作，包含完整 `apiKey` 与 `rechargeUrl`。只用于本机后备页，不得记录响应或转发。原生 WebUI 的 `status`/`balance` query 只要求 `operator.read`，状态仅返回掩码；复制 Key和获取充值链接是显式 action，要求 `operator.write`。领取、启用、轮换、移除也要求写权限。

钱包核心不会在导入、启动或定时器内领取额度。旧盘 SecretRef 在服务进程内通过官方 SDK解析，密钥不进入argv或日志；恢复仅允许本地 store/file/env来源，失败时要求输入已有密钥，绝不自动创建另一钱包。充值 action 只返回既有充值页链接，由用户点击打开并操作。

测试使用临时目录、假密钥与mock网络；真实manifest布局额外通过官方OpenClaw解析器验证。钱包资源放在 `extensions/uclaw-wallet/dist/control-ui/`，属于便携版发行内容。
