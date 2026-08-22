# U-Claw 新主线开发计划

> 目标：在保留 `dongsheng123132/u-claw` 仓库与 SEO 权重的前提下，启动一条干净的新主线。新主线继续跟随 OpenClaw 上游，但把 U 盘、AI 设置、设备钱包、影核、本象、本境和 TaskPassport 放在 OpenClaw 外层。
>
> 修订 2026-08-21：确立「瘦壳 + 可换内核」形态（运行时落本机、U 盘只存身份），补状态边界、运行时探测与复用、离线 seed、分支与发布策略。

## 0. 立项时的仓库现状（2026-08-21 实测，作为基线）

| 项 | 值 |
|---|---|
| Star / Fork | 1727 / 414，MIT，公开 |
| 最新 Release | v2.1.17（2026-07-26） |
| 唯一产物 | `u-claw-portable-windows-v2.1.17.zip`，238.2 MB，1543 次下载 |
| `OPENCLAW_VERSION` | `2026.7.1-2`，与 `npm view openclaw version` 一致 |
| upstream 其它 tag | `beta: 2026.8.1-beta.2`、`extended-stable: 2026.6.34` |
| `track-upstream.yml` | 每日 cron，连续在跑，状态正常（不是假绿） |

这组数字决定了三件事：仓库不能换（1727 star / 414 fork）、main 不能长期不可发版（1543 次下载是活的分发渠道）、v3 不能破坏「解压即用、零网络依赖」这个承诺。

## 1. 产品定位

U-Claw 不是 OpenClaw 的另一个分叉，而是：

```text
OpenClaw 上游运行时（可换内核）
        ↓
U-Claw 瘦壳：便携数据边界 + 版本化内核管理
        ↓
U-King 风格统一设置 + 设备钱包 + 协议层
```

OpenClaw 负责 Agent、Gateway、模型调用、渠道和插件；U-Claw 负责安装、便携、配置、迁移、钱包和机器可调用动作。

**形态参考 `v2/u-dsh`（U-DSH Portable）**，它已经把这套架构在 DeepSeek Harness 上跑通了，全部 1820 行。v3 是把它套到 OpenClaw 上，不是重新设计：

| u-dsh 模块 | 行数 | v3 复用点 |
|---|---|---|
| `src/portable-paths.js` | 76 | 状态落盘边界 |
| `src/kernel-manager.js` | 422 | 版本化内核：临时目录 → 校验 → 原子改名 → 激活指针，新版启不来回退旧版 |
| `src/runtime-channel.js` + `config/runtime-channel.json` | 16 + 配置 | Node 版本 / SHA256 / 内核版本 / 镜像回退集中一处 |
| `src/device-wallet.js` | 299 | 五字段状态机（已按 C1–C6 落地） |
| `src/action-core.js` + `src/cli.js` + `action-parity.config.json` | 225+ | 影核：GUI/CLI 共用动作核心 + `generated/` 工具链 |
| `src/atomic-file.js` | 26 | 原子写 |

旧版本通过 Git tag、Release 和 `legacy/` 归档保留，不再让旧配置和旧安装器阻塞新主线。

## 2. 状态边界（Phase 0 第一件事，定错后面全返工）

v2 的根本病是**运行时住在 U 盘上**：`node_modules` 几万个小文件在 U 盘上随机读写，慢、易坏、还要求 NTFS。v3 把状态分三类：

| 类别 | 内容 | 位置 | 随 U 盘走 |
|---|---|---|---|
| 身份与数据 | `openclaw.json`、`data/.openclaw/`、memory、会话、Skills、**设备钱包五字段**、TaskPassport | `U-Claw/data/` | 是 |
| 可重建 | Node、各版本 OpenClaw 内核、npm 缓存、V8 编译缓存 | `%LOCALAPPDATA%\U-Claw\shared\` | 否 |
| 机器/盘绑定 | 浏览器 user-data、gateway.lock、端口占用、pid、日志 | `%LOCALAPPDATA%\U-Claw\slots\<usb-uuid>\` | 否 |

第三类是 u-dsh 没有、U-Claw 必须有的：U-Claw 存在「一台机插过多个 U 盘」和「同一个 U 盘插多台机」两种真实场景。运行时按机器共享（换 U 盘不重下），浏览器 profile 和锁按盘隔离（否则 `gateway already running (pid XXXX)` 会换个马甲回来）。

`portable/lib/portable-cache.mjs` 已经做了这件事的一半（浏览器 user-data junction + `NODE_COMPILE_CACHE`，UUID 隔离让换盘符仍命中同一份缓存）。v3 是把它从「缓存优化」升格成架构主线。

### 不可破坏的产品承诺

以下四条在 v3 里必须继续成立，任何设计与之冲突时改设计，不改承诺：

1. **解压即用、零网络依赖** —— 1543 次下载是冲这句来的。由离线 seed（见 §3）保证。
2. **不再强制 NTFS** —— 运行时不落盘后，`data/` 只有 JSON 和会话，出厂 exFAT 直接能用。当前 release note 里那条 NTFS 警告可以删掉，这是 v3 对客户最直观的收益。
3. **不绑定设备、不打指纹、不上传数据** —— 开源版 2026-06-17 已移除这些逻辑，v3 不得回退。
4. **钱包凭证只在 U 盘** —— 见 §5。

### portable-strict 模式

提供一个开关：全部跑 U 盘、宿主机不留任何东西。慢，但借用他人电脑、网吧、企业管控机需要。默认关闭。

## 3. 运行时探测与复用

首启在一台新电脑上要回答的问题是「这台机器上已经有什么」。探测结果必须可解释——同一套探测同时是 `runtime.probe` 诊断动作的数据源，用来回答 #48 那类「启动失败但不知道为什么」。

### Node 探测顺序

1. **本机托管、当前 slot**：`%LOCALAPPDATA%\U-Claw\shared\runtime\node-v<版本>\` + 完整性标记 `.ok`（内含 SHA256 与写入时间）。版本精确匹配 → 直接用。
2. **本机托管、其它 slot**：同一台机插过别的 U 盘，或装过一键安装版。版本精确匹配 → 复用，不重下。
3. **U 盘离线 seed**：`vendor/node-v<版本>-win-x64.zip` → 解压到 (1)，校验 SHA256。一次性顺序大文件读，U 盘擅长，几十秒。
4. **网络下载**：`config/runtime-channel.json` 里的 url + sha256，镜像回退。
5. **系统 Node**：**默认不用**。只有显式开启 `allowSystemNode`，且同时满足 (a) major 版本达标 (b) 冒烟测试通过 (c) 不是 nvm / volta 这类会随时切版本的 shim，才允许。

顺序理由：(1)(2) 把首启从几分钟压到几秒，是这套架构的主要收益；系统 Node 排最后是因为跟客户自有环境串线的 bug 修起来最贵。

### 内核（OpenClaw）探测顺序

1. `%LOCALAPPDATA%\U-Claw\shared\kernels\openclaw\<version>\` + 激活指针 `current`，版本匹配直接用
2. 本机其它 slot 的 kernels → 复用
3. U 盘 seed `vendor/openclaw-<version>-<target>.{zip,tar.gz}` → 临时目录 → 校验包名/版本/入口 → 原子改名 → 切激活指针

   **seed 必须是装好的整棵树，不是 npm tarball。** openclaw 有 58 个依赖，`npm pack` 出来的包不含它们，装它照样要联网——那就破了「零网络依赖」。又因为它带 `sqlite-vec` 这个原生 `optionalDependency`，整棵树**按平台打**，不能跨平台复用。

   另：openclaw 的 `peerDependencies` 是空的，u-dsh 那套 peer 收敛循环不用移植。
4. 网络 registry + 镜像回退
5. **客户自己全局装的 `openclaw`（`npm i -g` 或 `~/.uclaw/`）：绝不复用。** 版本不受控、配置目录会串——#51 就是这类症状。探测到了只**报告**（「检测到系统中另有 openclaw X.Y，U-Claw 不会使用它」），供诊断用，不接管、不修改、不卸载。

新内核启动失败时回退到已安装的旧版本。「检查更新」只报告 npm 标签，不未经验证自动替换正在使用的内核。

### 空间治理

每台插过的电脑会留约 1 GB。必须提供：

- `runtime.gc` —— 保留 current 与上一版内核，其余可清，显示各 slot 占用
- `runtime.purge_host` —— 从本机彻底移除 U-Claw 缓存（借用他人电脑后清干净）
- 首启时若 `%LOCALAPPDATA%` 不可写（组策略限制、漫游配置文件同步），**降级回落 U 盘运行**并明确提示，不得直接启动失败

## 4. 第一优先级：重做模型设置，减少配置类 Bug

当前用户最容易出问题的是模型配置（#61、#51，以及已修的 `0be55b9` 写死已下线的 `deepseek-chat`、`154e418` 两个配置页模型清单分叉）。新主线必须采用 U-King 原型和 EchoBird 类似的「统一供应商库 + 工具路由」方式，禁止每个工具单独维护一份模型配置页面。

### 4.1 页面分层

#### AI 设置

只负责「哪个工具使用哪个供应商和模型」：

- 供应商库：创建、编辑、删除、测试供应商；
- 模型库：从供应商能力接口读取模型，不在客户端长期写死清单；
- 工具路由：Claude Code、Codex、OpenClaw、Hermes 分别选择供应商和模型；
- 高级设置：Base URL、兼容协议、上下文长度、超时、代理；
- 配置备份：切换前自动备份，失败时自动回滚；
- 本地模型：Ollama、llama.cpp 等作为独立供应商类型，不伪装成云端模型。

#### 设备钱包

只负责余额、充值和云端凭证安全：

- 设备钱包、余额、刷新；
- 一键充值；
- 复制密钥、换一把；
- 填入已有钱包；
- 移除本机钱包。

AI 设置不能再保存第二份钱包 Key；实际模型调用所用的托管 Key 必须由钱包的 `applyKey()` 统一注入。

#### Token 水电表

只读统计本机各工具和模型的 Token 用量。不能充值、换 Key 或修改模型路由，也不能把估算费用冒充钱包真实余额。

### 4.2 统一配置数据模型

建议建立单一配置文件，例如 `data/uclaw-settings.json`：

```json
{
  "schemaVersion": 1,
  "providers": {
    "deepseek": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.deepseek.com/v1",
      "credentialRef": "device-wallet",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  },
  "routes": {
    "openclaw": { "providerId": "deepseek", "modelId": "deepseek-chat" },
    "claude-code": { "providerId": "deepseek", "modelId": "deepseek-reasoner" }
  },
  "advanced": {
    "autoTestBeforeApply": true,
    "backupBeforeApply": true
  }
}
```

约束：

1. `providerId`、`modelId`、`route` 必须经过 schema 校验；
2. API Key 不直接写入页面状态、日志或命令行；只保存 `credentialRef`，由设备钱包或本地密钥存储提供；
3. 模型清单优先读取供应商的 `/v1/models`，读不到时显示「未探测到」，不估、不写假模型；
4. 配置应用采用临时文件 → 校验 → 原子替换；失败保留旧配置；
5. 所有配置变更记录 `schemaVersion`，升级时走迁移，不直接覆盖用户文件。

## 5. 设备钱包与虾盘云

落地顺序、五字段 schema、六条硬契约照 `device-wallet` 技能，不在此重复。v3 特有的三条：

1. **钱包状态存 U 盘，不存本机。** 位置 `U-Claw/data/uclaw-state/device-wallet.json`（对应 u-dsh 的 `data/u-dsh-state/device-wallet.json`）。v3 把本机目录变成了常规落点，这条更容易漏——漏了就是每台插过 U 盘的电脑都留一份能花钱的凭证。分发前 grep 断言见 §10。
2. **钱包只填空、不抢占。** 用户已经选了自己的 provider 时，`applyKey()` 不得覆盖。虾盘云是新用户的开箱即用默认项，不是排他通道；官方 provider 设置完整保留。这是开源版能被社区接受的前提。
3. **开源前服务端先做完匿名 bind 限流，新钱包默认余额 0。** 代码一公开，`POST /device/bind` 就会被扫。这不是 Phase 2 的事，是公开那一刻之前的事。

钱包存储损坏、U 盘只读或虾盘云不可达时，不阻断启动，不拦人进应用。

## 6. 影核动作边界

### 6.1 现状：动作核心已经存在，别重写

**`refactor/action-parity` 分支上已有一套完整实现**（2026-07-26，3531 行 / 25 文件，53/53 测试通过，CLI 可跑）。2026-08-22 复核过，是活的：

```text
portable/lib/core/
  index.mjs        动作注册表（唯一清单来源）
  runtime.mjs      execute / defineAction / validateSchema / redact
  manifest.mjs     导出机器可发现的清单
  logger.mjs       动作执行日志
  paths.mjs
  actions/         config / doctor / bugreport / wechat / gateway / log
portable/uclaw.mjs           CLI 投影
portable/action-parity.json  717 行清单，spec_version 0.3.0，AP-1
tests/action-core.test.mjs / action-log.test.mjs / action-parity.test.mjs
```

已有动作：`bug.collect`、`config.get`、`config.set`、`doctor.diagnose`、`gateway.start`、`gateway.stop`、`lock.clean`、`log.tail`、`plugin.wechat.install`。

其中 `lock.clean` 正是「gateway already running (pid XXXX)」那个老问题的动作化解法，`clean-stale-lock.mjs` 也在这个分支上。

**所以 v3 的影核工作不是"从零建"，是"合进来 + 扩展"。** 原计划把它列成 Phase 3 待办是错的。

### 6.2 命名必须对齐，不许并存两套词汇

原计划自己拟了一套 ID（`runtime.start` / `wallet.reset_local` 等），和已有的撞了。两套动作词汇并存就是宪法第 8 条说的漂移。**以已有实现的约定为准**，新能力按它的形状扩展：

| 原计划拟的 | 定为 | 理由 |
|---|---|---|
| `runtime.start` / `stop` / `status` | ~~删~~，用已有的 `gateway.start` / `gateway.stop` | 网关进程的生命周期已经有主了 |
| `runtime.probe` / `seed` / `install` / `activate` / `gc` | 保留 | 这些管的是 Node/内核本身，和网关进程是两回事 |
| `runtime.purge_host` | `runtime.host.purge` | 三段式对齐 `plugin.wechat.install` |
| `wallet.reset_local` | `wallet.local.reset` | 同上；且全仓库不用 snake_case |
| `ai.*`（供应商库 / 路由 / 备份） | 保留 | 与已有 `config.get/set` 分工：`config.*` 读写 openclaw.json 原始配置，`ai.*` 是供应商/路由层，**且是唯一被允许写 provider 配置的一层** |
| `task.*` | 推迟到 Phase 5 | 跟本象/本境一起 |

新动作一律注册进 `portable/lib/core/index.mjs` 的 `ACTIONS`，由 `tests/action-parity.test.mjs` 断言注册表与 `action-parity.json` 对齐——那条测试已经在了，白拿。

GUI、CLI、MCP、OpenClaw Skill 和测试都调用同一套核心，不能在界面里再实现一份配置逻辑。

危险动作（换 Key、移除钱包、`runtime.purge_host`）需主进程确认；CLI 使用时显式传 `--yes`。密钥禁止作为命令行参数或普通 JSON 输出，填入 Key 只接受标准输入或文件。

## 7. 模型配置的防 Bug 设计

### 应用前测试

点击「应用」时按以下顺序执行：

```text
读取输入
  → schema 校验
  → 解析供应商和模型
  → 只读连通测试
  → 生成临时配置
  → 启动/探测目标工具
  → 原子提交
```

测试失败时保留当前可用配置，并明确显示失败原因；不能先写坏配置再测试。

### 模型清单防漂移

- 供应商能力由 `/v1/models` 或本地探测返回；
- UI 不维护第二份模型清单；
- OpenClaw、Claude Code、Codex 的适配器各自只负责格式转换；
- 模型 ID 只在供应商层存一次；
- 过期模型显示「已失效」，不能静默替换成另一个模型。

### Key 防串线

- 设备钱包是托管云 Key 的唯一真相源；
- 自备 Key 可以存在本地安全存储，但不能写入 Git、日志或 URL；
- 所有路由最终汇入同一个 `resolveCredential(providerId)`；
- 钱包 rotate、adopt、reset-local 都必须重新调用 `applyKey()`；
- 并发首启和并发保存必须 in-flight 去重。

### 可恢复性

- 每次应用前保留最近 10 份配置备份；
- 启动发现配置损坏时自动回滚到上一份有效配置；
- OpenClaw 启动失败时显示「配置错误 / 上游不可用 / Key 无效」三类明确诊断；
- 配置页始终提供「恢复上一份配置」；
- 没有钱包或没有云 Key 时，仍允许配置本地模型和自备供应商。

## 8. 新目录建议

```text
u-claw/
├── portable/              # 新版默认便携发行版入口（= U 盘内容）
│   ├── vendor/            # 离线 seed：node 官方 zip + openclaw 整棵树（按平台）+ 渠道插件
│   ├── config/            # 配置页与配置服务
│   │   └── runtime-channel.json   # Node/内核版本、SHA256、镜像回退，单一真相源
│   ├── actions/           # 影核 Action Core
│   ├── services/          # AI 设置、钱包、用量、迁移、运行时探测
│   └── data/              # U 盘内用户数据（openclaw.json / 会话 / Skills / 钱包）
├── protocols/             # 本象、本境、TaskPassport 的 schema/适配器（可选插件，见 §10）
├── install/               # Windows / Mac / Linux 安装器
├── bootable/              # Linux 可启动 U 盘
├── legacy/                # 旧版源码归档，仅修安全问题，不继续扩展
└── tests/                 # 核心动作、迁移、配置和发行版测试
```

与 v2 的关键差异：**`portable/app/` 不再存在**。Node runtime 与 OpenClaw 内核不进 U 盘运行目录，只以 seed 形式躺在 `vendor/`，首启时装到 `%LOCALAPPDATA%\U-Claw\`。

第一步在现有 `portable/` 内建立新服务层，等新版本通过验收后再把旧实现移动到 `legacy/`，避免一次性大迁移。

## 9. 分支与发布策略

| 分支 | 角色 |
|---|---|
| `main` | 仍是 v2 生产线，继续发版、继续跟随 upstream。**`track-upstream.yml` 不动。** |
| `v3` | 新架构开发分支，从本计划定稿那次提交切出 |
| `v2`（暂不创建） | Phase 4 切换时才从 main 切，给 414 个 fork 一个稳定基座 |

v3 走独立分支后，每日 cron 只碰 main，与 v3 无冲突，CI 一行不用改。合并时 `OPENCLAW_VERSION` 会有一次平凡冲突。

**Phase 4 切换动作（按序）**：main 打 `v2-final` tag → 推 `v2` 维护分支 → `v3` 合入 main → `track-upstream.yml` 改指 `v2`。

**v3 开发期间 main 不能静默。** #52「为什么不更新下载包了呢？」还开着。（#48/#46 已于 2026-08-22 关闭——查证发现 `270cf4b` 早在 v2.1.10 就修了并已随各版本发布，只是 issue 一直没关。）

### 9.1 开发路径：干活之前先看这张表

**工作副本只留两个**，别再开第三个：

| 路径 | 分支 | 干什么 |
|---|---|---|
| `v1-开源/u-claw/` | `main` | v2 生产线：修 bug、发版、跟 upstream |
| `v1-开源/u-claw-v3-wt/` | `v3` | 新架构：瘦壳、钱包、AI 设置、影核 |

临时 worktree 用完即撤（`git worktree remove`），不留过夜——三个副本同时在，就会有人在错的那个里改。

### 9.2 分支清点（2026-08-22 核过）

| 分支 | 状态 | 处置 |
|---|---|---|
| `main` | 活 | 保留 |
| `v3` | 活 | 保留 |
| `refactor/action-parity` | **活且完整**，53/53 通过 | **合进 v3**，见 §6.1。这是最有价值的一条 |
| `fix/no-proxy-public-hosts` | 未并，2 个提交（NO_PROXY 范围 + 发布页死链） | 真实待办，评估后并入 main |
| `fix/portable-stability-and-config` | 3 个提交**已被 `refactor/action-parity` 完全包含**（`git cherry` 验过） | 冗余，可删 |
| `fix/xiapan-cloud-card` | 功能（虾盘云首选卡）**已由另一条路径进 main** | 过时，可删 |
| `chore/opensource-cleanup` | 已并入 main | 可删 |
| `chore/drop-desktop-electron` | 已并入 main，仅本地 | 可删 |
| `fix/deepseek-v4-model-id` | 已并入 main，仅本地 | 可删 |

规矩：**分支合了就删**。上面五条躺了两个月，直接后果是 `refactor/action-parity` 这份完整成果被埋在噪音里一个月没人合。

## 10. 开发阶段

### Phase 0：冻结边界

- 写死 §2 状态边界表，此后任何新代码写文件前先归类；
- 锁定 OpenClaw 版本和升级策略（`runtime-channel.json`）；
- 列出旧配置格式、旧钱包格式、旧启动入口；
- 从 main 切 `v3` 分支；
- 禁止新代码继续增加第二套模型配置。

### Phase 0.5：移植 u-dsh 骨架（新增，必须在 Phase 1 之前）

- `portable-paths.js` → 三层路径（U 盘 data / 本机 shared / 本机 slot）；
- `runtime-channel.js` + `runtime-channel.json`；
- `kernel-manager.js` → 适配 OpenClaw 包名与入口；
- `atomic-file.js`；
- 运行时探测与复用（§3），含 `runtime.probe` 输出；
- 离线 seed 首启解压路径（`kernel-manager.mjs`：seed → 校验 → 原子落地 → 激活/回退/gc）；
- **CI 产出 seed**：把现在 release zip 里的 `app/core/` 改打成 `vendor/openclaw-<version>-<target>`；
- 首启进度界面（扩现有 `loading.html`，不得黑窗）。

> 踩到的坑，记在这里免得再踩：Windows 上解 tar.gz **必须点名 `%SystemRoot%\System32\tar.exe`**（bsdtar）。
> 客户机和开发机的 PATH 上常有 GNU tar，它把 `C:\...` 的冒号当 `host:path` 分隔符，直接
> 报 `Cannot connect to C: resolve failed`。只写 `tar` 在 CI 上可能是绿的，到客户机上就炸。

理由：AI 设置的落盘位置取决于状态边界，边界没落地就做配置核心必然返工。

### Phase 1：统一 AI 设置核心

- 配置 schema 和迁移器；
- 供应商库、模型探测、工具路由；
- 应用前只读测试；
- 原子写入、备份、回滚；
- OpenClaw / Claude Code / Codex / Hermes 适配器。

### Phase 2：接入设备钱包

- bind / rotate / commit / adopt / reset-local；
- `applyKey()` 汇流，且不抢占用户已选 provider；
- 设备钱包 UI；
- 钱包和 AI 设置分离；
- 断网、只读 U 盘、进程中断、换机恢复测试。

### Phase 3：影核收口（多数已完成，主要是合并）

- **合并 `refactor/action-parity`**（已完成的 3531 行，见 §6.1）——这是本阶段最大的一块，不是新写；
- 按 §6.2 对齐命名，把 Phase 0.5/1/2 的新能力注册进 `lib/core/index.mjs`；
- ActionParity 工具链接入 CI（`action-parity.test.mjs` 已有，接上跑即可）；
- 多实例 / 多 slot（回应 #53）。

### Phase 4：重新打包发行版

- Windows 便携版（含 seed）；
- Mac 便携版；
- 一键安装版；
- Linux 启动盘；
- 国内镜像和离线包；
- GitHub Release 与官网下载链路；
- 按 §9 完成分支切换。

### Phase 5（延后）：本象 / 本境 / TaskPassport

**从原 Phase 3 降级为主线之后的可选插件。** 它们不解决客户当下最痛的两件事（模型配置出 Bug、U 盘慢），放在主线里会把发行版一直往后拖。影核不同——按开发宪法第 13 条，U-Claw「第二个界面 / 被 AI 操作 / 跨设备」三条全中，且 u-dsh 工具链现成，属于净赚，保留在 Phase 3。

「影刻」尚未定义清楚是什么能力，在有明确定义前不进计划，避免又一个会漂的名词。

## 11. 最低验收标准

### 模型配置

- 错误 API Key 不会覆盖当前可用配置；
- 不存在的模型 ID 不能保存；
- 供应商 `/v1/models` 变化后页面不会继续显示假模型；
- 应用失败能自动回滚；
- OpenClaw、Claude Code、Codex 不会互相覆盖配置；
- 钱包 Key 不出现在日志、命令历史和公开产物；
- 断网时应用能进入，仍可使用本地模型；
- U 盘只读时应用不会卡在「正在配置」；
- 同时打开两个配置页面不会互相覆盖；
- 旧版本配置可以迁移或明确提示用户手动选择。

### 便携与运行时（新增）

- **干净机 + 断网首启**：从 U 盘 seed 装起来并跑通，全程不需要网络；
- **干净机 + 有网首启**：走网络路径同样跑通，且校验 SHA256；
- **二次启动**：命中本机缓存，秒起；
- **换机**：同一 U 盘插另一台干净机，数据、会话、钱包余额都在；
- **一机两盘**：两个 U 盘插同一台机，共享 runtime 不重下，锁和浏览器 profile 互不干扰；
- **一盘两机**：同一 U 盘先后插两台机，不残留对方的锁；
- **exFAT U 盘**：不格式化成 NTFS 也能跑通（这条过了才能删 release note 里的 NTFS 警告）；
- **U 盘只读**：能进应用；
- **热拔盘**：进程不崩、有明确提示；
- **`%LOCALAPPDATA%` 不可写**：降级回落 U 盘运行，不是启动失败；
- **系统里另装有 openclaw**：`runtime.probe` 报告它，但 U-Claw 不使用、不修改它；
- **`runtime.purge_host` 之后**：宿主机无残留，U 盘数据完好，再插能用。

### 分发前自检（新增）

```bash
# 1. 产物里不许有凭证（不要限定 hex，服务端签发的随机 key 不一定是纯 hex）
grep -rl 'sk-' <产物>/

# 2. 钱包文件必须在 U 盘便携目录里，宿主机不许有
ls <产物>/data/uclaw-state/device-wallet.json     # 要有
ls "$LOCALAPPDATA/U-Claw/**/device-wallet.json"   # 不该有
ls "$APPDATA/U-Claw"                              # 不该有

# 3. seed 完整性
sha256sum -c portable/vendor/SHA256SUMS
```

建议补一条源码级测试锁住便携路径的调用点，并做变异验证：注释掉调用，测试必须红。u-dsh 踩过的坑是「便携 helper 写了没人调」，钱包落进宿主机 `%APPDATA%`。

## 12. 当前决策

1. 仓库继续使用 `dongsheng123132/u-claw`，不新建 SEO 替代仓库；
2. 新主线跟随 OpenClaw，上游版本锁定后再升级；
3. 旧版本只归档，不再让旧结构决定新架构；
4. U-King 的 AI 设置与设备钱包信息架构作为 U-Claw 新版标准；
5. 模型配置优先于界面美化和其它扩展；
6. 所有设置、钱包和任务能力最终都要有机器可调用的 Action ID；
7. **采用「瘦壳 + 可换内核」：运行时与缓存落本机，U 盘只存身份与数据**，形态照 `v2/u-dsh` 移植，不重新设计；
8. **离线 seed 是必需项不是优化项**，用于守住「解压即用、零网络依赖」；
9. **系统 Node 默认不复用，客户自装的 openclaw 绝不复用**，只报告；
10. **v3 在独立分支开发，main 继续出货**，`track-upstream.yml` 保持不动；
11. 本象 / 本境 / TaskPassport 降级为 Phase 5 可选插件；影刻在定义清楚前不进计划。

## 附录：现存 Issue 与 v3 的对应

| Issue | 状态 | v3 里的归属 |
|---|---|---|
| #39 node_modules 大批量小文件拷贝到 U 盘耗时太长 | CLOSED | 架构性消除（运行时不上盘） |
| #27 复制到 U 盘时缺少符号链接文件 | CLOSED | 架构性消除（exFAT 不再需要 symlink） |
| #43 U 盘便携版安装后启动失败 | CLOSED | 架构性消除 |
| #29 U 盘安装打开之后无法创建文件 | CLOSED | 架构性消除 |
| #37 U 盘安装不了 | CLOSED | 架构性消除 |
| #61 增加添加模型功能 | OPEN | Phase 1 供应商库 |
| #51 用 OpenRouter 总提示 rates-limit，单独用 openclaw 不会 | OPEN | Phase 1 适配器只做格式转换 + `runtime.probe` 报告系统 openclaw |
| #48 / #46 `127.0.0.1:18789` 拒绝连接 | OPEN | **先在 main（v2）上确认并发版**；v3 里由 `runtime.status` + 首屏轮询兜底 |
| #53 运行方式只能单一 web | OPEN | Phase 3 多实例 / 多 slot |
| #24 设计的启动不合理 | OPEN | Phase 0.5 首启流程重做 |
| #58 微信 clawbot 扫码后不 work | OPEN | 渠道插件问题，与 v3 架构无关，走 v2 线 |
| #52 为什么不更新下载包了 | OPEN | §9：v3 期间 main 保持发版节奏 |
