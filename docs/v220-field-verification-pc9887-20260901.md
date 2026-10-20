# v2.2.0 实机验证报告（pc-9887，2026-09-01 21:3x）

## 环境突变说明
- 今早装 U-Claw-2.0 的 U 盘（D: 29GB）已拔走；现 F:（15GB UCLAW）= U-King 客户U盘。
- 实机验证改在 E:\uclaw-test（机器第二块系统盘）+ 真实旧配置上做——恰好是完美标本：
  该 openclaw.json 与 pc-9887 客户机病灶一模一样【没有 gateway 段】。

## 验证结果（v2.2.0 守卫 official-provider-guard.mjs @ node v22.20.0 真机跑）

| 验证项 | 结果 |
|---|---|
| 守卫首次跑（配置无 gateway 段 + uclaw-cloud provider） | EXIT 0，无报错 |
| gateway 段自愈 | ✅ 配置尾部出现 {"gateway":{"mode":"local","auth":{"mode":"token","token":"uclaw"}}} |
| provider 名保留（uclaw-cloud 非官方 catalog 名） | ✅ 未被误改名 |
| 幂等性（第二次跑） | ✅ EXIT 0 无动作无重复写 |
| merge-config 新逻辑（模拟「前端不带 gateway 的保存」） | ✅ 删除 gateway 后合并，结果自动补回 {"mode":"local","auth":{"mode":"token","token":"uclaw"}} |

## 结论
v2.2.0 两修复在真实 Windows + 真实残缺配置上按设计工作：
1. 启动守卫会自动补回丢失的 gateway 段（修「Dashboard 永远 401」）；
2. 保存路径不再会弄丢 gateway 段；
3. 官方 provider 名守卫逻辑已在开发机 143/143 测试 + 产物冒烟验证（本机无该场景，逻辑分支由测试覆盖）。

## 遗留
- U-Claw 的 U 盘（今早 D: 那块）不在机器上，exFAT 实盘启动验证待该 U 盘下次插回
  （或任何客户机拿到 v2.2.0 包后自动生效——守卫在启动时自愈）。
- DeepSeek key 仍是坏的（sk-tai…23字符占位符），需在配置中心重填真 key。
