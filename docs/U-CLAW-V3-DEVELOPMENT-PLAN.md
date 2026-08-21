# U-Claw 新主线开发计划

> 目标：在保留 `dongsheng123132/u-claw` 仓库与 SEO 权重的前提下，启动一条干净的新主线。新主线继续跟随 OpenClaw 上游，但把 U 盘、AI 设置、设备钱包、影核、本象、本境和 TaskPassport 放在 OpenClaw 外层。

## 1. 产品定位

U-Claw 不是 OpenClaw 的另一个分叉，而是：

```text
OpenClaw 上游运行时
        ↓
U-Claw 便携运行层
        ↓
U-King 风格统一设置 + 设备钱包 + 协议层
```

OpenClaw 负责 Agent、Gateway、模型调用、渠道和插件；U-Claw 负责安装、便携、配置、迁移、钱包和机器可调用动作。

旧版本通过 Git tag、Release 和 `legacy/` 归档保留，不再让旧配置和旧安装器阻塞新主线。

## 2. 第一优先级：重做模型设置，减少配置类 Bug

当前用户最容易出问题的是模型配置。新主线必须采用 U-King 原型和 EchoBird 类似的“统一供应商库 + 工具路由”方式，禁止每个工具单独维护一份模型配置页面。

### 2.1 页面分层

#### AI 设置

只负责“哪个工具使用哪个供应商和模型”：

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

### 2.2 统一配置数据模型

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
3. 模型清单优先读取供应商的 `/v1/models`，读不到时显示“未探测到”，不估、不写假模型；
4. 配置应用采用临时文件 → 校验 → 原子替换；失败保留旧配置；
5. 所有配置变更记录 `schemaVersion`，升级时走迁移，不直接覆盖用户文件。

## 3. 影核动作边界

页面只做展示和输入，所有业务动作通过稳定 Action ID 执行：

```text
ai.provider.list
ai.provider.save
ai.provider.remove
ai.provider.test
ai.models.refresh
ai.route.get
ai.route.set
ai.settings.backup
ai.settings.restore
wallet.bind
wallet.rotate
wallet.adopt
wallet.reset_local
runtime.start
runtime.stop
runtime.status
task.create
task.inspect
task.resume
```

GUI、CLI、MCP、OpenClaw Skill 和测试都调用同一套动作核心，不能在界面里再实现一份配置逻辑。

## 4. 模型配置的防 Bug 设计

### 应用前测试

点击“应用”时按以下顺序执行：

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
- 过期模型显示“已失效”，不能静默替换成另一个模型。

### Key 防串线

- 设备钱包是托管云 Key 的唯一真相源；
- 自备 Key 可以存在本地安全存储，但不能写入 Git、日志或 URL；
- 所有路由最终汇入同一个 `resolveCredential(providerId)`；
- 钱包 rotate、adopt、reset-local 都必须重新调用 `applyKey()`；
- 并发首启和并发保存必须 in-flight 去重。

### 可恢复性

- 每次应用前保留最近 10 份配置备份；
- 启动发现配置损坏时自动回滚到上一份有效配置；
- OpenClaw 启动失败时显示“配置错误 / 上游不可用 / Key 无效”三类明确诊断；
- 配置页始终提供“恢复上一份配置”；
- 没有钱包或没有云 Key 时，仍允许配置本地模型和自备供应商。

## 5. 新目录建议

```text
u-claw/
├── portable/              # 新版默认便携发行版入口
│   ├── app/               # Node runtime + OpenClaw 上游包
│   ├── config/            # 配置页与配置服务
│   ├── actions/           # 影核 Action Core
│   ├── services/          # AI 设置、钱包、用量、迁移
│   └── data/              # U 盘内用户数据
├── protocols/             # 本象、本境、TaskPassport 的 schema/适配器
├── install/               # Windows / Mac / Linux 安装器
├── bootable/              # Linux 可启动 U 盘
├── legacy/                # 旧版源码归档，仅修安全问题，不继续扩展
└── tests/                 # 核心动作、迁移、配置和发行版测试
```

第一步可以先在现有 `portable/` 内建立新服务层，等新版本通过验收后再把旧实现移动到 `legacy/`，避免一次性大迁移。

## 6. 开发阶段

### Phase 0：冻结边界

- 锁定 OpenClaw 版本和升级策略；
- 列出旧配置格式、旧钱包格式、旧启动入口；
- 给旧版本打最后一个 `v2` tag；
- 禁止新代码继续增加第二套模型配置。

### Phase 1：统一 AI 设置核心

- 配置 schema 和迁移器；
- 供应商库、模型探测、工具路由；
- 应用前只读测试；
- 原子写入、备份、回滚；
- OpenClaw / Claude Code / Codex / Hermes 适配器。

### Phase 2：接入设备钱包

- bind / rotate / commit / adopt / reset-local；
- `applyKey()` 汇流；
- 设备钱包 UI；
- 钱包和 AI 设置分离；
- 断网、只读 U 盘、进程中断、换机恢复测试。

### Phase 3：接入协议层

- 影核动作清单；
- 本象资源 schema；
- 本境上下文和权限；
- TaskPassport 的创建、导入、恢复、迁移；
- GUI / CLI / MCP 共用动作核心。

### Phase 4：重新打包发行版

- Windows 便携版；
- Mac 便携版；
- 一键安装版；
- Linux 启动盘；
- 国内镜像和离线包；
- GitHub Release 与官网下载链路。

## 7. 最低验收标准

模型配置必须至少通过：

- 错误 API Key 不会覆盖当前可用配置；
- 不存在的模型 ID 不能保存；
- 供应商 `/v1/models` 变化后页面不会继续显示假模型；
- 应用失败能自动回滚；
- OpenClaw、Claude Code、Codex 不会互相覆盖配置；
- 钱包 Key 不出现在日志、命令历史和公开产物；
- 断网时应用能进入，仍可使用本地模型；
- U 盘只读时应用不会卡在“正在配置”；
- 同时打开两个配置页面不会互相覆盖；
- 旧版本配置可以迁移或明确提示用户手动选择。

## 8. 当前决策

1. 仓库继续使用 `dongsheng123132/u-claw`，不新建 SEO 替代仓库；
2. 新主线跟随 OpenClaw，上游版本锁定后再升级；
3. 旧版本只归档，不再让旧结构决定新架构；
4. U-King 的 AI 设置与设备钱包信息架构作为 U-Claw 新版标准；
5. 模型配置优先于界面美化和其它扩展；
6. 所有设置、钱包和任务能力最终都要有机器可调用的 Action ID。
