# 社区便携版调研：OpenClaw-USB-Portable

调研时间：2026-11-02
对象：[techjarves/OpenClaw-USB-Portable](https://github.com/techjarves/OpenClaw-USB-Portable)（142★，PowerShell 主导）
只读副本：`_refs/OpenClaw-USB-Portable/`（已 gitignore；需要再看时按下方命令重拉）

```bash
curl -sL -x http://127.0.0.1:7897 \
  https://codeload.github.com/techjarves/OpenClaw-USB-Portable/tar.gz/HEAD \
  | tar xz -C _refs/OpenClaw-USB-Portable --strip-components=1
```

## 它的架构（和我们一致的部分）

- 盘内便携 Node + 盘内安装 openclaw，`data/` 随盘走，`runtime|packages/<platform>` 按 OS 分目录。
- 提供 `run.bat` / `run.sh` 两个入口，内部菜单：Setup / Chat / Dashboard / Tools / Run CLI。
- `templates/openclaw.portable.json` 显式写 `gateway.bind: loopback`、`gateway.tailscale.mode: off`。
- 首启联网下载本机平台的 Node 与 OpenClaw；之后同平台复用。

## 可以借鉴的 3 条（已落地/待落地）

| 借鉴点 | 我们的做法 |
|---|---|
| 显式声明 `gateway.bind=loopback`、`tailscale=off` | ✅ 已落地：`lib/gateway-token.mjs#normalizeGatewayBinding` 在启动时补默认值（用户显式设置不覆盖） |
| 菜单给"聊天/工具/CLI"直达入口 | ✅ 已有：`Windows-Menu.bat` 的 [16] CLI 终端与 [2] Dashboard；另新增 `Windows-Config.bat` |
| 健康检查 + 日志尾巴（`gateway health` + tail 日志） | 部分已有：`Windows-Diagnose.bat`；后续可把 `/ready` 形状校验与日志尾合并进诊断输出 |
| 每 OS 独立 `runtime/<platform>` | 我们单目录 `app/runtime/node-win-x64`，Mac 版则是 `node-mac-arm64`；同一支盘双平台靠 `.uclaw-runtime-platform` 逗号列表，不强求同目录 |

## 不要学的一条（会伤 U 盘）

它把 `HOME / USERPROFILE / APPDATA / LOCALAPPDATA / TEMP / XDG_*` 全部重定向到盘内 `data/home`、`data/temp`。
便携性听起来彻底，但这是把**全部临时写和工具缓存压到 U 盘**，写放大直接拉满。
我们的做法相反：`lib/portable-cache.mjs` 只把"可重建的重 IO 数据"（V8 编译缓存、受管 Chromium profile）
放本机盘，TEMP 保持系统 temp，业务状态才随盘走。

## 结论

社区这个项目验证了"盘内 Node + 盘内 openclaw + data/ 随盘"的路线可行，
但它没有解决 exFAT 写入、单实例、宿主凭证隔离、会话库升级这些问题——这些仍是我们自己的护城河。
官方至今没有 portable/USB 形态（install 页只有桌面 app 与一键脚本），所以不存在"抄现成轮子"的选项。
