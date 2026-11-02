# U-Claw 托盘（U-Claw-Tray.exe）

U 盘版 U-Claw 的「像 App」入口：**无窗口常驻通知区**，双击就用，菜单能开 Dashboard /
配置中心、能拉起后端。它是被降级的 WebView2 壳（`app/shell/U-Claw-Shell.exe`）的替代，
壳继续保留为可选模式。

- 纯 Go + [`github.com/getlantern/systray`](https://github.com/getlantern/systray) v1.2.2；
  Windows 后端是纯 `syscall` 实现：**无 CGO、不需要 MinGW，也不需要 WebView2 运行时**。
- gateway 的归属仍然是 `Windows-Start.bat`：托盘只负责「拉起 / 打开 / 显示状态」，
  不接管后端生命周期，也不写 U 盘任何状态文件。

## 构建

```bash
cd tray && ./build.sh
# 产物：tray/build/U-Claw-Tray.exe

# build.sh 里等价的那一行：
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w -H windowsgui" -o build/U-Claw-Tray.exe .
```

- 需要 **Go 1.24+**（`go.mod` 的 `go 1.24`；与 `.github/workflows/release.yml` 里
  `actions/setup-go` 的 `go-version: '1.24'` 一致）。
- 国内网络如果拉不到依赖：`export GOPROXY=https://goproxy.cn,direct`
  （或 `export https_proxy=http://127.0.0.1:7897`）。
- macOS / Linux 上普通 `go build ./...` 只会编出 `main_other.go` 的占位程序
  （提示「只支持 Windows」），不会误编出无用的托盘二进制。
- 校验（CI 里也可以跑）：

```bash
GOOS=windows GOARCH=amd64 go vet ./...   # 交叉平台 vet 通过
go test ./...                            # logic_test.go：URL / token / 探活 / 容错
```

## 放置位置

建议 CI / 发布包把产物放到 **`app/tray/U-Claw-Tray.exe`**，最终 U 盘结构：

```text
U-Claw/
├─ Windows-Start.bat          ← 后端启动器（托盘会调用它，不改它）
├─ Windows-App.bat            ← 现有 Edge app 模式（托盘之外的另一种入口）
├─ app/
│  ├─ tray/U-Claw-Tray.exe    ← 本目录产物
│  ├─ shell/…                 ← 可选 WebView2 壳（U-Claw-Shell.exe）
│  └─ runtime/… core/…        ← setup 下载的运行时
└─ data/.openclaw/
   ├─ runtime.json            ← 端口唯一真相源（gatewayPort / configServerPort）
   ├─ openclaw.json           ← 用户配置（含 gateway.auth.token 兜底）
   └─ gateway-token           ← 随机 token 唯一真相源（如果启动器已升级）
```

U 盘根的定位顺序（`logic.go` 的 `resolveRoot`）：

1. 命令行第 1 个非选项参数（如 `U-Claw-Tray.exe D:\U-Claw`）；
2. 从 exe 所在目录向上最多 4 层，找 `Windows-Start.bat` / `data/.openclaw` /
   `lib/runtime-ports.mjs` 任一骨架标记（所以放 `app/tray/` 或 U 盘根都能用）；
   顺带认开发布局 `<repo>/portable/`；
3. 兜底：exe 所在目录的上级。

> 说明：exe 文件本身没有 Win32 资源图标（与 `shell/U-Claw-Shell.exe` 一致），Windows
> 资源管理器里显示 Go 默认图标；**通知区图标**来自内嵌的 `icon.ico`（7 个尺寸：16/24/32/48/64/128/256）。

## 用法

```text
U-Claw-Tray.exe [--tray-only] [U盘根目录]

  --tray-only          只驻留托盘，不自动拉起/打开 WebUI（登录自启时用）
  UCLAW_TRAY_NO_OPEN=1 同上（给快捷方式/启动项用）
```

- **双击 exe / 快捷方式** = 像 App 一样直接用：
  - 后端已在跑 → 直接打开 WebUI；
  - 后端没跑 → 用 `Windows-Start.bat` 后台拉起（`UCLAW_HEADLESS=1`，不会另弹 loading
    页/浏览器），就绪后打开 WebUI；**没配置过模型时先打开配置中心**（与
    `lib/open-app.ps1` 的 ConfigFirst 规则一致，否则用户找不到虾盘云钱包 / 模型 Key 入口）。
- **单实例**：重复双击不会出现第二个托盘图标（命名互斥体 `Local\U-Claw-Tray`）。
- 每 5 秒刷新一次 tooltip 和菜单可用状态。

### 右键菜单

| 菜单项 | 行为 | 可用条件 |
|---|---|---|
| 打开 Dashboard | 默认浏览器打开 `http://127.0.0.1:<gatewayPort>/#token=<token>` | gateway `/ready` 真就绪 |
| 打开配置中心 | 默认浏览器打开 `http://127.0.0.1:<configServerPort>/` | `runtime.json` 有 `configServerPort` |
| 启动 U-Claw | `cmd /c ""<U盘根>\Windows-Start.bat""`（后台） | gateway 未就绪且不在启动中 |
| 状态：… | 只读文案（tooltip 也显示端口/就绪），点击立即刷新 | 始终 |
| 退出本托盘 | 只退出图标；gateway 继续在后台运行 | 始终 |

打开浏览器用 `rundll32 url.dll,FileProtocolHandler <url>`：不闪黑窗，URL 以独立参数传入，
不需要 shell 转义。

## 状态与 token 的来源（与 lib/ 保持同一真相源）

- **端口**：只读 `data/.openclaw/runtime.json` 的 `gatewayPort` / `configServerPort`
  （见 `portable/lib/runtime-ports.mjs`）。字段缺失/损坏 = 未知，**绝不猜**「配置端口 + 1」。
- **token**：`data/.openclaw/gateway-token`（`lib/gateway-token.mjs` 引入的每支盘随机
  token）→ `openclaw.json` 的 `gateway.auth.token` → 旧默认值 `uclaw`。与
  `config-server/server.js` 的 `readGatewayToken()` 完全同优先级。token 进 URL fragment
  前按 `encodeURIComponent` 语义转义（hex token / `uclaw` 下与原样等价）。
- **就绪**：`GET /ready` 且响应体形状正确
  （`{ready: bool, failing: array, uptimeMs: number, eventLoop: object}`），与
  `lib/open-app.ps1` 的 `Test-GatewayReady`、config-server 的 `/api/gateway-check` 同语义；
  「谁在端口上回 200」不算就绪。
- **零后台写**：托盘进程不写 U 盘；唯一的文件写是 systray 把图标写到系统 `%TEMP%`
  （`os.TempDir()`），不在 U 盘上。

## 已知 Windows 坑

1. **Windows 11 默认把新托盘图标收进 `^` 溢出区**，第一次可能“看不见”。点 `^` 把图标拖到
   常驻区即可（系统行为；托盘刻意不写注册表，保持零宿主状态写）。
2. **未签名 exe 的 SmartScreen / 杀软**：从网上下载的 zip 带 Mark-of-the-Web，首次运行可能
   被拦。正式发行建议代码签名，或按现有 U-Claw 的分发说明引导用户「仍要运行」。
3. `-H windowsgui` = 无控制台：systray 内部错误只写 stderr（看不到）；后端自己的报错在
   `Windows-Start.bat` 的控制台窗口里。
4. **Explorer 崩溃/重启**：systray v1.2.2 自己处理 `TaskbarCreated`，图标会自动加回。
5. **高 DPI**：systray 用 `SM_CXSMICON` 选图标尺寸、`LoadImage(LR_DEFAULTSIZE)` 加载；
   icon.ico 已含多尺寸，常见缩放清晰；进程无 DPI manifest，极端缩放下可能略糊。
6. **盘符漂移**：U 盘拔下再插到别的盘符，托盘记住的是启动时的根，需要重启托盘。
7. **宿主机代理**：探活显式关掉 `HTTP_PROXY`（`Proxy: nil`），127.0.0.1 不会发给 Clash。
8. **退出托盘 ≠ 停止 gateway**：要停后端仍是关掉 `Windows-Start.bat` 的控制台窗口（与现有
   行为一致）。

## 手工冒烟（Windows 上）

1. 构建后放 `app/tray/U-Claw-Tray.exe`，双击：通知区出图标 + 后端控制台窗口拉起 +
   就绪后默认浏览器打开 WebUI（首次运行进配置中心）。
2. 关掉浏览器，右键图标 →「打开 Dashboard」应立即打开；后端没起时该项是灰的。
3. 右键 →「退出本托盘」：图标消失、gateway 继续跑；再双击 exe 能重新驻留（单实例不冲突）。
4. 关掉后端控制台窗口，5 秒内 tooltip 变「未就绪」，Dashboard 变灰、「启动 U-Claw」变可点。
5. `U-Claw-Tray.exe --tray-only`：只出图标，不拉起后端、不开浏览器。

## CI 接入建议（未改 `release.yml`，留给 Lead 决定）

`portable-windows-full` job 已经装了 `actions/setup-go@v5`（`go-version: '1.24'`）并有相邻的
「Build optional WebView2 shell」步骤；在它后面加一个同构的步骤即可（ubuntu runner 交叉编译）：

```yaml
      - name: Build tray (Windows x64)
        run: |
          tag_name="${GITHUB_REF_NAME:-${{ github.event.inputs.tag }}}"
          stage_dir="dist/u-claw-portable-windows-${tag_name}"
          mkdir -p "$stage_dir/app/tray"
          cd tray
          GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w -H windowsgui' -o "../$stage_dir/app/tray/U-Claw-Tray.exe" .
```

可选：在任意有 Go 的 job 里加 `cd tray && GOOS=windows GOARCH=amd64 go vet ./... && go test ./...`
做逻辑回归（`logic_test.go` 不依赖 Windows）。`tray/build/` 已在 `tray/.gitignore` 与根
`.gitignore`（`*.exe`）里忽略。
