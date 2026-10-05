# config-server JSON API 契约

> 适用对象：`portable/config-server/server.js`（Node.js `http`，零业务中间件）。
>
> 本文档是 **U-King 桌面壳**（第二个调用方，config-server 自带的配置中心页面 `public/index.html` 是第一个）与该服务的对外契约。
> 所有字段名、状态码、CORS 行为、路径参数均与 `server.js` 实际代码逐条核对。
> 代码优先；如发现本文与代码不一致，以 `server.js` 为准并提 issue。

## 0. 服务基本信息

| 项 | 值 | 出处 |
| --- | --- | --- |
| 协议 | HTTP/1.1，绑定 `127.0.0.1` | `server.listen(port, '127.0.0.1', ...)` |
| 起始端口 | `18788`（`PORT_RANGE_PREFERRED`） | 文件首部常量 |
| 端口顺延 | 占用则向下顺延至 `18778`（`PORT_RANGE_FLOOR`），失败 `process.exit(1)` | `listenWithFallback()` |
| 端口覆盖 | 环境变量 `UCLAW_CONFIG_PORT`（测试用） | 文件末尾 |
| 配置路径 | `process.env.OPENCLAW_CONFIG_PATH \|\| <stateDir>/openclaw.json`（默认 `<OPENCLAW_HOME>/.openclaw/openclaw.json`） | 文件首部 `CONFIG_PATH` |
| 运行时端口文件 | `<stateDir>/runtime.json`，写 `configServerPort` + `configServerUpdatedAt` | `listenWithFallback()` 内的 `setTimeout(..., 250)` |
| 静态文件 | `public/` 目录（`/` → `public/index.html`，其余按扩展名分发） | 文件底部 "Serve static files" 分支 |
| 鉴权 | 无（依赖同源 + 127.0.0.1 绑定） | CORS 段落 |
| 默认响应 | JSON `Content-Type: application/json` | 全部 API 路由 |

### 0.1 CORS 行为（重要）

server.js 在每个请求进来时无条件执行（`http.createServer` 回调顶部）：

```js
const origin = req.headers.origin || '';
if (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}
if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
```

要点：
- **仅放行** `http://127.0.0.1*` 与 `http://localhost*`（注释明确写"已收紧，旧版 `*` 让任意网页都能跨域读 `/api/config` 已修复"）。
- 不放 `Access-Control-Allow-Credentials`，不发 cookie 类凭据（不需要）。
- `OPTIONS` 预检统一 `200` + 空 body（不发 CORS 头给非白名单 origin，所以跨域预检会失败）。
- 不带 `Origin` 头的请求（curl、Node fetch、桌面壳走 127.0.0.1 直连）不受影响——CORS 是浏览器策略。
- 桌面壳走 `http://127.0.0.1:<port>` 即落在白名单内，无需额外配置。

## 1. 端点清单（14 个）

| # | Method | Path | 联网 | 备注 |
| - | ------ | ---- | --- | ---- |
| 1 | GET | `/api/runtime` | ✗ | 读 config-server + gateway 端口 |
| 2 | GET | `/api/config` | ✗ | **回显 apiKey 明文** |
| 3 | POST | `/api/config` | ✓(reload) | 合并 + 原子写 |
| 4 | GET | `/api/gateway-check` | ✓ | `?port=` |
| 5 | GET | `/api/update-status` | ✗ | 读状态文件 |
| 6 | POST | `/api/update-check` | ✓ | 触发联网检查 |
| 7 | GET | `/api/local-models` | ✓(本机) | Ollama/LM Studio 1.2s 探活 |
| 8 | POST | `/api/provider-models` | ✓ | 带 Key 拉 `/v1/models` |
| 9 | GET | `/api/wallet/status` | ✗ | **回显明文 apiKey + rechargeUrl** |
| 10 | POST | `/api/wallet/claim` | ✓ | 一键领取 |
| 11 | GET | `/api/wallet/balance` | ✓ | 查余额 |
| 12 | POST | `/api/wallet/rotate` | ✓ | 换 Key，两阶段提交 |
| 13 | POST | `/api/wallet/adopt` | ✓ | body `{key}` |
| 14 | POST | `/api/wallet/reset-local` | ✗ | 仅清本地 |

## 2. 端点契约

> 「敏感字段」标注约定：🚫 表示**绝对不能写入日志**、不能上报到远端、能落本地但需脱敏。

### 2.1 `GET /api/runtime`

读取 `runtime.json` 拿到 `configServerPort`，再走 `gatewayPortFromRuntime()` 的三级回退解析 `gatewayPort`：
1. `runtime.json.gatewayPort`
2. `launcher-instance.lock/owner.json.port`
3. 都拿不到 → `null`

**响应 200**
```json
{ "configServerPort": 18788, "gatewayPort": 18789 }
```

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `configServerPort` | `number\|null` | 当前服务实际绑定的端口 |
| `gatewayPort` | `number\|null` | 探测到的 gateway 端口，找不到则为 `null`（前端应回退到 `findGatewayPort()` 盲扫） |

**敏感字段**：无。

**错误**：本端点永不返回 `5xx`——`runtime.json` 损坏时两项字段都按 `null` 返回。

---

### 2.2 `GET /api/config`

直接 `fs.readFileSync(CONFIG_PATH)` + `JSON.parse`，文件不存在则返回 `{}`。

**响应 200**：整个 `openclaw.json` 原文（任意结构）。服务端不做字段过滤。

**敏感字段**：🚫 `models.providers[*].apiKey` **明文回显**（服务把 Key 原文存进 openclaw.json）。
调用方拿到的 JSON 整体都不能落到明文日志。

**错误 500**：`{ "error": "<fs/JSON 错误消息原文>" }`

---

### 2.3 `POST /api/config`

合并写入而非整份覆盖（issue #58）。逻辑见 `lib/merge-config.mjs`：
- 受管顶层字段 `gateway / commands / meta / models / agents / env`：以本次请求为准整体替换，**未带则视为清空**（但 `gateway` 有保底：缺字段时补回 `{mode:'local', auth:{mode:'token', token:'uclaw'}}`）。
- `channels`（issue #67）：请求体里带了且是对象 → **整体替换**磁盘上的 `channels`（支持删除）；没带或不是对象 → 保留磁盘版本（保存模型不会冲掉渠道）。
- 其余顶层字段（`plugins` 等 UI 不管理的字段）：**无视请求体里的值**，一律保留磁盘上的版本。
- 顶层 `agent`（旧键）会被 `delete merged.agent` 清掉。
- 写盘是**原子写**：`.tmp-<pid>-<rand>` → `renameSync` 替换；写前尽力备份 `.bak`，备份失败不阻断。
- 写之前调用 `moveIncomingSecretsToStore()`：所有 `providers[*].apiKey` 与 `env.*` 中命中 `/(API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD)$/i` 的值，会通过 `openclaw.mjs secrets store set` 走 stdin 落本机 secret store，回写 `{source:'store', provider:'default', id:'UCLAW_MODEL_<NAME>'}`；检测到脱敏占位串（`xxxxxx...yyyyyy` 形如 `/^[A-Za-z0-9_-]{3,12}\.\.\.[A-Za-z0-9_-]{3,8}$/`）或中文占位 `（已加密保存，无需重填）` 会抛 `SecretSaveError`。
- `official-provider-guard.mjs` 仅 advisory，失败**不阻断保存**，只 `console.error`。
- 写盘后触发 `runSecretsReload()` 调 `openclaw.mjs secrets reload`，命中 `ECONNREFUSED` / `ETIMEDOUT` 等连接错时返回 `{pendingRestart:true}`。

**请求体**：任意 JSON 对象（顶层是 openclaw.json 的形状）。

**响应 200**：保存成功
```json
{
  "ok": true,
  "mode": "live",            // 或 pendingRestart / reloadError
  "pendingRestart": false,   // 可选
  "reloadError": "..."       // 可选，失败原因
}
```

**响应 200**：密钥校验失败（HTTP 仍是 200）
```json
{ "ok": false, "error": "请重新输入 API Key" }
// 或 "检测到已脱敏的密钥串，请重新输入完整 API Key"
// 或 "无法安全保存 API Key（<reason>）"
```

**响应 500**：JSON 解析失败或合并/原子写异常
```json
{ "ok": false, "error": "<异常消息原文>" }
```

**敏感字段**：请求体里的 `apiKey` / `token` / `secret` / `password` 🚫——服务端会把它们转成 `SecretRef`，过程中明文只走 stdin，不入 argv、不入日志。

**并发与幂等**：本端点**没有显式写锁**。两次 POST 并发时都 `readConfigSafe → mergeConfig → writeConfigAtomic`，最后一次 rename 胜出；但每次写盘前都会读最新磁盘版，所以不会丢字段——只会丢「两次 POST 之间、第三方进程（wallet applyKey）的写入」。桌面壳并发触发保存时，建议先与本服务确认语义再批量合并。

---

### 2.4 `GET /api/gateway-check?port=<n>`

服务端 Node fetch 目标端口的 `/ready`（**不**走浏览器 CORS），校验响应体形状：
```json
{ "ready": <bool>, "failing": [...], "uptimeMs": <num>, "eventLoop": {...} }
```
四个字段类型全部匹配才返回 `{ok:true}`。超时 1500ms。

**Query 参数**

| 名 | 类型 | 必填 | 说明 |
| -- | ---- | ---- | ---- |
| `port` | `number` | 是 | 1–65535 整数；非法返回 `400` |

**响应 200**
```json
{ "ok": true }        // 是真 OpenClaw gateway
// 或
{ "ok": false }       // 端口不可达 / 响应体形状不符
```

**响应 400**
```json
{ "ok": false, "error": "bad port" }
```

**响应 500**（仅内部异常）
```json
{ "ok": false, "error": "<message>" }
```

**敏感字段**：无。

---

### 2.5 `GET /api/update-status`

读 `<stateDir>/update-available.json`（不存在/损坏都返回降级形态）。**永不返回 5xx**——所有失败路径都是 `{available:false}`。

| 场景 | Body |
| ---- | ---- |
| 文件不存在 | `{available:false, reason:"no-check-yet"}` |
| 有新版（`lib/check-update.mjs` 写入） | `{available:true, checkedAt, localVersion, remoteVersion, releaseDate, downloadUrl, releasePageUrl, notes}` |
| 已是最新 | `{available:false, checkedAt}` |
| 读失败 | `{available:false, reason:"read-failed", error}` |

**敏感字段**：无。

### 2.6 `POST /api/update-check`

`import('../lib/check-update.mjs')` → `checkUpdate({versionFilePath, stateDir})`。5s 超时拉 OSS `latest.json`，写/清 `update-available.json`。**请求体忽略**。

**响应 200**：成功或可恢复失败 → `{ok:true, available, localVersion, remoteVersion, ...}` / `{ok:false, reason:"missing-paths"|"no-local-version"|"fetch-failed"|"invalid-manifest"}`

**响应 500**：`import` 失败或未捕获异常 → `{error}`

**敏感字段**：无。

---

### 2.7 `GET /api/local-models`

并发探测 Ollama 与 LM Studio（1.2s 超时/路，`Promise.all`）：

| provider | base | api（期望响应） |
| -------- | ---- | ---- |
| `ollama` | `http://127.0.0.1:11434/v1` | `http://127.0.0.1:11434/api/tags`（`{models:[{name}]}`） |
| `lmstudio` | `http://127.0.0.1:1234/v1` | `http://127.0.0.1:1234/v1/models`（`{data:[{id}]}`） |

**响应 200**：`{providers:[{provider, label, base, models:[...]}, ...]}`；都探测不到 `providers:[]`。

**敏感字段**：无。

---

### 2.8 `POST /api/provider-models`

带用户 Key 调平台 `/v1/models`。Key 仅本次使用，**不落盘、不打日志**。

**请求体**：`{provider, base, apiKey}`。`zai` 时缺省 `base=https://open.bigmodel.cn/api/paas/v4`；`base` 必须 `new URL()` 可解析 + `protocol` 是 `http:`/`https:` + 不含 `username/password/hash`；`apiKey` 必填；`anthropic.com` 自动改 `x-api-key` + `anthropic-version:2023-06-01`；`redirect:'error'`；body 上限 `1e6` 字节（超出 `req.destroy()`）；超时 15s。

**响应 200**：成功 → `{ok:true, models:[...]}`（最多 500，按字典序去重）
**响应 200**：失败 → `{ok:false, error:"请先填写 API Key 再拉取"|"Key 校验失败(401)"|"平台返回 HTTP <n>"|"API 地址格式不正确"|"仅支持 http(s) 地址"|"API 地址含不支持的部分"|"该提供商不支持在线拉取，可直接手填模型名"|"平台响应超时"|"平台返回了空列表"}`

**敏感字段**：🚫 请求体 `apiKey`。

---

### 2.9 `GET /api/wallet/status`

`lib/wallet-client.mjs` 的 `getStatus()`，**不联网**；有 wallet 时额外拼 `rechargeUrl`（用 `payBaseUrl()`）。

| 场景 | Body |
| ---- | ---- |
| 有钱包 | `{ok:true, hasWallet:true, apiKey🚫:"sk-xxxx", maskedKey:"sk-abc...wxyz", walletId, hasPending, pendingKind, rechargeUrl🚫:"https://api.u-claw.org.cn/recharge?key=sk-xxxx"}` |
| 无钱包 | `{ok:true, hasWallet:false, apiKey:"", maskedKey:"", walletId:"", hasPending:false, pendingKind:""}` |
| 本地存储损坏 | `{ok:false, error, hasWallet:false, apiKey:"", maskedKey:"", hasPending:false, pendingKind:""}` |

**敏感字段**：🚫 `apiKey` + `rechargeUrl` 都含明文；日志只记 `maskedKey`。

---

### 2.10 `POST /api/wallet/claim`

一键领取。`claimWallet()`：`state.apiKey` 已存在 → `{alreadyClaimed:true}`；否则 POST `/device/bind`（failover 走 `lib/uclaw-cloud-endpoints.mjs.fetchWithFailover`），拿 `apiKey+walletId` 后落 `<stateDir>/uclaw-device.json`，再 `applyKey()` 合并写 openclaw.json（清旧 `uclaw-cloud` provider → 插新 Key）。并发去重 `claimInFlight`。

**请求体**：无。**响应 200**：成功 → `{ok:true, apiKey🚫, walletId, alreadyClaimed:false|true}`
**响应 200**：失败 → `{ok:false, error:"领取的人太多..."（429）|"连不上虾盘云服务器..."（status=0 或 ≥500）|"领取失败：HTTP <n>（<error>）"|<底层>}`

**敏感字段**：🚫 `apiKey` 明文。

### 2.11 `GET /api/wallet/balance`

并行调 `/v1/dashboard/billing/subscription` + `/v1/dashboard/billing/usage`，换算 USD 与 quota（`500,000 quota = $1`）。

**响应 200**：成功 → `{ok:true, remainingUsd, usedUsd, grantedUsd, remainingQuota, usedQuota, grantedQuota}`
**响应 200**：失败 → `{ok:false, error:"查询余额失败：HTTP <n>"|"查询用量失败：HTTP <n>"|"余额返回格式不认识"|"还没有设备钱包"|<底层>}`

### 2.12 `POST /api/wallet/rotate`

两阶段提交换 Key：mint `/device/rotate` → 只读 `GET /v1/models` 验证（**不消耗额度**）→ `/device/rotate/commit`；若有 `pendingKey` 先 `settlePendingState()`。并发去重 `rotateInFlight`。

**请求体**：无。**响应 200**：成功 → `{ok:true, apiKey🚫, walletId}`
**响应 200**：失败 → `{ok:false, error:"还没有设备钱包，请先领取"|"换密钥失败：HTTP <n> <error>"|"新密钥验证未通过，已保留旧密钥，请稍后重试"|<底层>}`

**敏感字段**：🚫 `apiKey` 明文。

### 2.13 `POST /api/wallet/adopt`

填入已有 Key（跨机迁移）：本地校验前缀 `sk-`、长度 ≥8、无空白字符；`GET /v1/models` 只读验签；通过则覆盖本地五字段 + `applyKey()` 合并写 openclaw.json。

**请求体**：`{key:"sk-xxxx"}`。
**响应 200**：成功 → `{ok:true, apiKey🚫}`
**响应 200**：失败 → `{ok:false, error:"请先填入密钥"|"这不像一把虾盘云密钥（应以 sk- 开头）"|"密钥里混进了空格或换行，请重新复制"|"这把密钥用不了，没有保存"|<底层>}`

**敏感字段**：🚫 请求体 `key` + 响应 `apiKey`。

### 2.14 `POST /api/wallet/reset-local`

只清本机五字段 + 清 `openclaw.json.models.providers.uclaw-cloud` + 若主模型指向它一并清空。**绝不调服务端**——旧钱包余额不受影响，旧 Key 仍可在别的机器上 `adopt`。

**请求体**：无。**响应 200**：成功 → `{ok:true}`
**响应 200**：失败 → `{ok:false, error:"有未识别的待处理操作，为安全起见拒绝清除，请联系支持"|<底层>}`

**敏感字段**：无。

## 3. 通用错误形状与状态码速查

| 状态码 | 出现条件 | Body 形状 |
| ------ | -------- | --------- |
| 200 | 业务成功 / 业务失败（wallet 系列、provider-models、config 密钥校验） | `{ok:true,...}` 或 `{ok:false,error:"..."}` |
| 400 | `/api/gateway-check` 的 `port` 非法 | `{ok:false, error:"..."}` |
| 404 | 静态文件找不到 | 文本 `Not Found` |
| 500 | 服务端抛未捕获异常（JSON.parse 失败、import 失败、fs 异常等） | `{error:"..."}` 或 `{ok:false,error:"..."}` |

⚠️ 钱包与 `provider-models` 端点**故意把业务错误也塞进 200**（body `ok:false`），避免前端在弱网/限流下被浏览器 fetch 误判为致命。

## 4. 给第二调用方（桌面壳 U-King）的接入注意

### 4.1 端口发现

不要硬编码 `18788`。先 `GET /api/runtime` 拿 `configServerPort`（处理 `null` 兜底），再用 `/api/gateway-check?port=<gatewayPort>` 二次确认 gateway 是不是真的活着（CORS 浏览器侧无法做到）。`runtime.json` 也可能损坏，端口字段为 `null` 是正常降级路径。

### 4.2 配置写回 `POST /api/config` 的语义

| 问题 | 答案（基于代码事实） |
| ---- | -------------------- |
| 是整份覆盖还是合并？ | **合并**：`mergeConfig(existing, incoming)`。`gateway/commands/meta/models/agents/env` 六个受管顶层字段以本次请求为准整体替换（未带视为清空，但 `gateway` 有保底 token）；`channels` 请求里带了（且是对象）就整体替换、没带则保留磁盘原值；其他顶层字段（典型如 `plugins`）一律保留磁盘原值。 |
| 有写锁吗？ | **没有显式写锁**。两次并发 POST 时两次都 `readConfigSafe → mergeConfig → writeConfigAtomic`，最后一次 `renameSync` 胜出；中间过程不会丢字段但会丢「两次 POST 之间第三方进程（wallet `applyKey`）的写入」。建议应用层串行化，或每次保存前 `GET /api/config` 拉最新再改。 |
| 写盘是原子的吗？ | **是**：`writeConfigAtomic()` 用 `.<name>.tmp-<pid>-<rand>` 写临时文件再 `renameSync` 替换；写前会备份 `<name>.bak`，备份失败不阻断。 |
| 失败会半截写坏吗？ | **不会**：renameSync 在同一文件系统内是原子操作，进程被杀/断电不会留下半截 JSON。 |
| 重复保存同一份配置会怎样？ | 幂等：`mergeConfig(existing, existing) === existing`，`writeConfigAtomic` 会重写一遍文件、备份一遍 `.bak`，无副作用。 |
| 旧版「agent」键会怎样？ | 会被 `delete merged.agent` 清掉（挪自原 server.js 逻辑）。 |
| 桌面壳只关心某一字段，能不能 GET 出来改一个字段再 POST 回去？ | **能，且推荐这么做**：先 `GET /api/config` → 改目标字段 → `POST /api/config`，这样受管字段之外的 `plugins` 等会自动保留。 |

### 4.3 服务生命周期

| 项 | 事实 |
| ---- | ---- |
| 谁负责启动 | 由 `portable/` 启动脚本（`Windows-Start.bat` / `Mac-Start.command`）拉起，源码注释里写「18789-18799」段；实际起始是 `18788`，向下顺延到 `18778`。 |
| 谁负责退出 | 进程被父脚本终止时自然退出；`server.js` 本身没有 SIGTERM 处理、不会优雅清理。 |
| 端口占用行为 | `EADDRINUSE` 时**向下**顺延（`PORT_RANGE_FLOOR = 18778`）。注意 Windows 双绑怪癖：bind 已占用端口时回调先返回 `listening=true`，`EADDRINUSE` 后到——`setTimeout(..., 250)` 推迟横幅/runtime 写入就是为了躲这个窗口。 |
| 端口复用（runtime.json） | 每次成功 listen 后写 `runtime.json`，**不是原子写**（普通 `writeFileSync`，与 `/api/config` 不同）。两个 server 进程同时写可能截断，但 `GET /api/runtime` 对损坏文件做了 `try/catch` 兜底。 |
| 桌面壳 vs 配置中心自带页面（`public/index.html`）共存 | **不冲突**：两者都是 127.0.0.1 的客户端，谁先抢到端口谁就是主，runtime.json 会随后写好新端口。桌面壳应优先用 `/api/runtime` 而不是猜端口。 |
| CORS 与桌面壳 | 桌面壳走 `http://127.0.0.1:<port>` 在白名单内；若用 Electron / Tauri webview 默认 Origin 通常就是 `http://127.0.0.1`，预检会成功。如果桌面壳改了 user-agent 或代理导致 Origin 不是 127.0.0.1，需要确认 webview 行为。 |
| 重启/升级时的 reload | `POST /api/config` 成功后调 `openclaw.mjs secrets reload`；连接错返回 `{pendingRestart:true}` 表示需要重启 gateway 才生效。桌面壳触发相关保存后应主动建议用户重启 gateway。 |

### 4.4 敏感字段速查（决定能否落日志）

| 端点 | 字段 | 是否明文 | 日志建议 |
| ---- | ---- | -------- | -------- |
| `GET /api/config` | 整个 body | 含 `models.providers[*].apiKey` 明文 | 整体🚫；只记 `maskedKey` |
| `POST /api/config` | 请求 body | 含 `apiKey/token/secret/password` 明文 | 落本地日志也要脱敏 |
| `POST /api/provider-models` | 请求 `apiKey`、响应 `models` 数组 | Key 不回显；模型 ID 安全 | Key🚫、models 可记 |
| `GET /api/wallet/status` | `apiKey`、`rechargeUrl` | 明文 | 🚫；只记 `maskedKey` |
| `POST /api/wallet/claim` | 响应 `apiKey` | 明文 | 🚫 |
| `POST /api/wallet/rotate` | 响应 `apiKey` | 明文 | 🚫 |
| `POST /api/wallet/adopt` | 请求 `key`、响应 `apiKey` | 明文 | 🚫 |
| 其余端点 | — | 无敏感字段 | 可记 |

### 4.5 已知边界与降级

- `/api/wallet/*` 的所有失败路径都在 200 里——客户端必须看 `ok` 字段，不能只看 HTTP 状态。
- `/api/update-status` 永不 5xx；桌面壳 UI 上看到 `available:false` 就是「无更新或还没检查」，不要重试风暴。
- `/api/runtime` 的 `gatewayPort:null` 是合法降级；桌面壳应再走一次本地 18778-18798 盲扫兜底（旧的 `findGatewayPort()` 行为）。
- `/api/local-models` 同时探测 Ollama 与 LM Studio，单边超时 1.2s，最坏情况 1.2s 后返回（两个 Promise.all 并发）——不要在前端把这个接口的 timeout 设短于 2s。

---

## 5. 同步说明

- 本文档基于 `portable/config-server/server.js` 逐行核对。
- 涉及模块：`lib/merge-config.mjs`、`lib/check-update.mjs`、`lib/wallet-client.mjs`、`lib/portable-instance-lock.mjs`、`lib/official-provider-guard.mjs`、`lib/uclaw-cloud-endpoints.mjs`。
- 文档与代码不一致时，以 `server.js` 为准并提 issue；契约字段新增/重命名前，请先修订本文档再发版。