//go:build windows

// U-Claw 托盘（U-Claw-Tray.exe）—— 无窗口常驻的轻量「像 App」入口。
//
// 定位：替代被降级的 WebView2 壳（app/shell/U-Claw-Shell.exe 保留为可选）。它自己不是
// 浏览器，只负责三件事：把 U 盘上的 U-Claw 拉起来、在默认浏览器里打开 WebUI、在通知区
// 显示真实状态。gateway 的归属仍然是 Windows-Start.bat，托盘不接管它的生命周期。
//
// 设计约束（与 portable/lib/ 里的助手法则一致）：
//   - 只做 UI：托盘进程本身不写 U 盘任何状态文件（唯一的文件写是 systray 把图标写到
//     系统临时目录，也就是 os.TempDir()，不在 U 盘上）。
//   - 端口唯一真相源 = data/.openclaw/runtime.json 的 gatewayPort / configServerPort
//     （见 portable/lib/runtime-ports.mjs）。缺字段就是"不知道"，绝不猜 "配置端口 + 1"。
//   - token 唯一真相源 = data/.openclaw/gateway-token 文件（lib/gateway-token.mjs 引入的
//     每支盘随机 token），回退 openclaw.json 的 gateway.auth.token，再回退旧默认值
//     "uclaw"——与 config-server/server.js 的 readGatewayToken() 完全同一优先级。
//   - 就绪判定复用 lib/open-app.ps1 Test-GatewayReady 的语义：GET /ready 且响应体形状
//     对得上（{ready: bool, failing: array, uptimeMs: number, eventLoop: object}），
//     不用"谁在端口上回 200"当就绪，避免客户机上碰巧占了端口的别家服务被误认。
//
// 平台无关逻辑（根目录推断 / JSON 读取 / URL 拼装 / 探活）在同目录 logic.go，可在
// macOS 与 CI 上用 `go test ./...` 验证；本文件只留 Windows + systray 的部分。
//
// 放置位置：<U 盘根>/app/tray/U-Claw-Tray.exe（推荐），或 <U 盘根>/ 下的任意层级。
// 命令行：U-Claw-Tray.exe [--tray-only] [U盘根目录]
//
//	--tray-only  只驻留托盘，不自动拉起/打开 WebUI（登录自启时用；等价 UCLAW_TRAY_NO_OPEN=1）
package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/getlantern/systray"
	"golang.org/x/sys/windows"
)

//go:embed icon.ico
var iconICO []byte

const (
	// 每 5 秒刷新一次 tooltip / 菜单可用状态。
	refreshInterval = 5 * time.Second
	// 启动 Windows-Start.bat 后等待 gateway 就绪的上限（与 lib/open-app.ps1 的 90s 对齐）：
	// U 盘首次启动可能要几十秒，但等待必须有界，不能把点击永远挂住。
	startReadyTimeout = 90 * time.Second
	// 单实例互斥体：双击两次 exe 不该出现两个托盘图标（Local\ = 每个登录会话一把）。
	trayMutexName = `Local\U-Claw-Tray`
)

type trayApp struct {
	mu    sync.Mutex
	state trayState
	// starting 表示一次「启动 + 等就绪」正在进行，防止连点重复拉起 Windows-Start.bat。
	starting bool
	// autoOpen = 启动时自动打开 WebUI（双击 exe 的默认行为；--tray-only 关闭）。
	autoOpen bool
	done     chan struct{}

	dashboard *systray.MenuItem
	config    *systray.MenuItem
	start     *systray.MenuItem
	status    *systray.MenuItem
}

func main() {
	opt := parseArgs(os.Args[1:])

	// 单实例：已有托盘在跑时静默退出（GUI 子系统没有控制台可以提示）。
	mutex, ok := acquireTrayMutex()
	if !ok {
		return
	}
	if mutex != 0 {
		defer func() { _ = windows.CloseHandle(mutex) }()
	}

	root := resolveRoot(opt.root)
	app := &trayApp{
		state: trayState{
			root:     root,
			stateDir: filepath.Join(root, "data", ".openclaw"),
		},
		autoOpen: !opt.noOpen,
		done:     make(chan struct{}),
	}
	systray.Run(app.onReady, app.onExit)
}

// ── 托盘生命周期 ─────────────────────────────────────────────────────────────

func (a *trayApp) onReady() {
	// 图标必须先设置：systray 随后弹出的菜单挂在通知区图标上。
	systray.SetIcon(iconICO)
	systray.SetTitle("U-Claw")

	// 菜单文本固定；可用/禁用状态和「状态」这一行的文字由 applyUI 每 5 秒刷新。
	a.status = systray.AddMenuItem("状态：正在读取…", "U-Claw 状态（点击立即刷新）")
	a.dashboard = systray.AddMenuItem("打开 Dashboard", "在默认浏览器打开 U-Claw WebUI")
	a.config = systray.AddMenuItem("打开配置中心", "打开 U-Claw 配置中心（虾盘云钱包 / 模型 Key 配置）")
	systray.AddSeparator()
	a.start = systray.AddMenuItem("启动 U-Claw", "运行 U 盘上的 Windows-Start.bat（后台启动 gateway）")
	systray.AddSeparator()
	quit := systray.AddMenuItem("退出本托盘", "只退出托盘图标；gateway 继续在后台运行（关掉 U-Claw 控制台窗口才会停止）")

	// 先只用本地文件填状态（毫秒级，托盘立刻可用），HTTP 探活交给后台首轮刷新。
	a.refreshLocal()
	a.applyUI()

	// 点击回调统一走 ClickedCh 的常驻接收者：systray 的点击通知是"无接收者就丢弃"的
	// 非阻塞发送，接收者必须在点击前就绪；回调里只做派发，耗时的 HTTP / 启动等待全部
	// 丢进 goroutine，避免按住菜单、丢弃后续点击。
	go func() {
		for {
			select {
			case <-a.dashboard.ClickedCh:
				go a.onDashboardClick()
			case <-a.config.ClickedCh:
				go a.onConfigClick()
			case <-a.start.ClickedCh:
				go a.startBackground(false, false) // 只启动，不抢开浏览器
			case <-a.status.ClickedCh:
				go a.refresh()
			case <-quit.ClickedCh:
				systray.Quit()
				return
			case <-a.done:
				return
			}
		}
	}()

	go a.loop()

	// 双击 exe = 像 App 一样直接用：没运行就拉起，就绪后打开 WebUI（首次运行进配置中心）。
	if a.autoOpen {
		go func() {
			time.Sleep(200 * time.Millisecond) // 让通知区图标先出来，避免看起来"没反应"
			a.startBackground(true, true)
		}()
	}
}

func (a *trayApp) onExit() {
	select {
	case <-a.done:
	default:
		close(a.done)
	}
}

func (a *trayApp) loop() {
	ticker := time.NewTicker(refreshInterval)
	defer ticker.Stop()
	a.refresh() // 首轮探活尽快跑完，菜单立刻反映真实状态
	for {
		select {
		case <-ticker.C:
			a.refresh()
		case <-a.done:
			return
		}
	}
}

// ── 状态刷新 ─────────────────────────────────────────────────────────────────

// refreshLocal 只读 U 盘上的本地文件（runtime.json / token），不碰网络。
func (a *trayApp) refreshLocal() {
	a.mu.Lock()
	stateDir := a.state.stateDir
	a.mu.Unlock()

	ports := readRuntimePorts(stateDir)
	token := readGatewayToken(stateDir)

	a.mu.Lock()
	a.state.gwPort = ports.GatewayPort
	a.state.cfgPort = ports.ConfigServerPort
	a.state.token = token
	a.mu.Unlock()
}

// refresh 重读端口 / token 并做 HTTP 探活，然后刷新 tooltip 与菜单可用状态。
func (a *trayApp) refresh() {
	a.mu.Lock()
	stateDir := a.state.stateDir
	a.mu.Unlock()

	ports := readRuntimePorts(stateDir)
	token := readGatewayToken(stateDir)
	shapeOK, readyNow := probeGateway(ports.GatewayPort)
	cfgAlive := probeConfigServer(ports.ConfigServerPort)

	a.mu.Lock()
	a.state.gwPort = ports.GatewayPort
	a.state.cfgPort = ports.ConfigServerPort
	a.state.token = token
	a.state.gwShape = shapeOK
	a.state.gwReady = shapeOK && readyNow
	a.state.cfgAlive = cfgAlive
	a.mu.Unlock()

	a.applyUI()
}

// refreshNow 刷新后返回当前状态快照（点击处理里用它拿"此刻"的端口和 token）。
func (a *trayApp) refreshNow() trayState {
	a.refresh()
	return a.snapshot()
}

func (a *trayApp) snapshot() trayState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

// stopped 表示托盘正在退出：退出后再调 systray（图标/菜单已销毁）没有意义，也避免在
// 事件循环结束后碰已销毁的 Win32 句柄。
func (a *trayApp) stopped() bool {
	select {
	case <-a.done:
		return true
	default:
		return false
	}
}

// applyUI 把状态映射到 tray icon 的 tooltip 和菜单项可用状态。systray 的这些调用内部有
// 互斥保护，可以从任意 goroutine 调用。
func (a *trayApp) applyUI() {
	if a.stopped() {
		return
	}
	a.mu.Lock()
	s := a.state
	starting := a.starting
	a.mu.Unlock()

	// NOTIFYICONDATA.szTip 上限 127 个 UTF-16 单元，下面的文案远小于它（Windows 会截断，不会报错）。
	switch {
	case s.gwReady:
		systray.SetTooltip(fmt.Sprintf("U-Claw 已就绪 · Gateway 端口 %d", s.gwPort))
	case starting:
		systray.SetTooltip("U-Claw 启动中，请稍候…")
	case s.gwShape:
		systray.SetTooltip(fmt.Sprintf("U-Claw 网关启动中 · 端口 %d", s.gwPort))
	case s.gwPort > 0:
		systray.SetTooltip(fmt.Sprintf("U-Claw 未就绪 · 端口 %d 无有效响应", s.gwPort))
	case s.cfgAlive:
		systray.SetTooltip("U-Claw 未运行（配置中心在线）")
	default:
		systray.SetTooltip("U-Claw 未运行")
	}

	if a.status != nil {
		a.status.SetTitle(statusText(s, starting))
	}
	// Dashboard 只在「真的就绪」时可点：端口没起来时点开只会得到一个拒连错误页。
	setEnabled(a.dashboard, s.gwReady)
	// 配置中心的端口是启动过程早期就发布到 runtime.json 的，有端口就允许打开。
	setEnabled(a.config, s.cfgPort > 0)
	setEnabled(a.start, !s.gwReady && !starting)
}

// ── 点击动作 ─────────────────────────────────────────────────────────────────

func (a *trayApp) onDashboardClick() {
	s := a.refreshNow()
	if s.gwReady && s.gwPort > 0 {
		openURL(dashboardURL(s.gwPort, s.token))
		return
	}
	// 5 秒刷新的间隙里 gateway 刚掉线：按"打开即拉起"处理。
	a.startBackground(true, false)
}

func (a *trayApp) onConfigClick() {
	s := a.refreshNow()
	if s.cfgPort > 0 {
		openURL(configCenterURL(s.cfgPort))
		return
	}
	// 端口未知 = backend 还没起来：拉起后按首屏规则打开（未配置模型时会进配置中心）。
	a.startBackground(true, true)
}

// startBackground 确保 gateway 起来；openAfter 时在就绪后打开 WebUI，firstRun 时套用
// lib/open-app.ps1 的"未配置模型先开配置中心"规则。
func (a *trayApp) startBackground(openAfter, firstRun bool) {
	if a.stopped() {
		return
	}
	a.mu.Lock()
	if a.starting {
		a.mu.Unlock()
		return
	}
	a.starting = true
	root := a.state.root
	a.mu.Unlock()

	go func() {
		defer func() {
			a.mu.Lock()
			a.starting = false
			a.mu.Unlock()
			a.refresh()
		}()

		// 每次点击都重读 runtime.json / token：两者都是启动过程中才落盘的。
		s := a.refreshNow()
		if s.gwReady {
			if openAfter {
				a.openUI(s, firstRun)
			}
			return
		}
		if err := launchStartBat(root); err != nil {
			return // 找不到 Windows-Start.bat 之类：托盘只反映真实状态
		}
		port, token, ok := waitGatewayReady(root, startReadyTimeout)
		if !ok {
			return // 超时：Windows-Start.bat 的控制台窗口里有真实报错
		}
		if openAfter {
			s = a.refreshNow()
			s.gwPort = port
			s.token = token
			a.openUI(s, firstRun)
		}
	}()
}

func (a *trayApp) openUI(s trayState, firstRun bool) {
	// 首次运行（还没配模型）：先开配置中心——与 lib/open-app.ps1 的 ConfigFirst 一致。
	// 否则用户从 Dashboard 找不到虾盘云钱包 / 模型 Key 入口（v2.3.8 shell 回归的根因）。
	if firstRun && s.cfgPort > 0 && !modelConfigured(s.stateDir) {
		openURL(configCenterURL(s.cfgPort))
		return
	}
	if s.gwPort > 0 {
		openURL(dashboardURL(s.gwPort, s.token))
	}
}

func setEnabled(item *systray.MenuItem, enabled bool) {
	if item == nil {
		return
	}
	if enabled {
		item.Enable()
	} else {
		item.Disable()
	}
}

// ── 打开浏览器 / 启动 Windows-Start.bat ──────────────────────────────────────

// openURL 用 rundll32 打开默认浏览器：进程是 GUI 子系统 + HideWindow，不闪黑窗；
// URL 作为独立 argv 传入，& / # / % 都是纯数据（cmd /c start 需要额外转义）。
func openURL(rawURL string) {
	if rawURL == "" {
		return
	}
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		return
	}
	go func() { _ = cmd.Wait() }()
}

// launchStartBat 用未改动的 Windows-Start.bat 拉起 gateway，然后立刻返回。
// 显式给 CmdLine 是为了复刻 lib/open-app.ps1 的 `cmd /c ""<path>""`：U 盘文件夹名里
// 有空格或 & 也不会被 cmd.exe 拆开。
func launchStartBat(root string) error {
	bat := filepath.Join(root, "Windows-Start.bat")
	if fi, err := os.Stat(bat); err != nil || fi.IsDir() {
		return fmt.Errorf("Windows-Start.bat not found under %s", root)
	}
	cmd := exec.Command("cmd.exe")
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `/c ""` + bat + `""`}
	// 托盘自己负责打开 UI：让后端不要再弹 loading 页 / 浏览器（否则一次点击弹两个窗口）。
	// 先剔除继承来的 UCLAW_HEADLESS 再追加，避免环境块里出现两个同名变量（Windows 对
	// 重复项取哪一个没有稳定约定）；子进程必须拿到 1。
	env := make([]string, 0, len(os.Environ())+1)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(strings.ToUpper(kv), "UCLAW_HEADLESS=") {
			continue
		}
		env = append(env, kv)
	}
	cmd.Env = append(env, "UCLAW_HEADLESS=1")
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// ── 单实例 ───────────────────────────────────────────────────────────────────

// acquireTrayMutex 拿会话级命名互斥体。返回 (句柄, 是否应继续运行)：
// 互斥体创建失败时不拦启动（宁可多一个托盘图标，也别让程序起不来）。
func acquireTrayMutex() (windows.Handle, bool) {
	name, err := windows.UTF16PtrFromString(trayMutexName)
	if err != nil {
		return 0, true
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil || handle == 0 {
		return 0, true
	}
	// CreateMutex 成功但同名互斥体早就存在时，LastError 是 ERROR_ALREADY_EXISTS。
	if lastErr := windows.GetLastError(); lastErr == windows.ERROR_ALREADY_EXISTS {
		_ = windows.CloseHandle(handle)
		return 0, false
	}
	return handle, true
}
