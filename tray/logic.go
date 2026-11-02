// U-Claw 托盘的平台无关逻辑：根目录推断、runtime.json / token 读取、URL 拼装、
// /ready 探活语义。放在无 build tag 的文件里，好让 macOS / CI 上也能用 `go test ./...`
// 验证（Windows 专属部分在 main_windows.go）。本文件不 import systray，也不写任何文件。

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const (
	// 单次 HTTP 探活超时。loopback 探活不该等太久；U 盘慢不体现在这里。
	probeTimeout = 1500 * time.Millisecond
	// 旧版全便携版共用的固定 token：token 文件 / 配置都读不到时才兜底（与 config-server 一致）。
	defaultToken = "uclaw"

	openclawConfigFile = "openclaw.json"
	gatewayTokenFile   = "gateway-token"
)

// 宿主机的 HTTP_PROXY 会劫持 loopback 探活（客户机上 Clash / 公司代理很常见），显式关掉。
var probeClient = &http.Client{
	Timeout: probeTimeout,
	Transport: &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
	},
}

type options struct {
	root   string // 命令行显式指定的 U 盘根（空 = 按 exe 位置自动推断）
	noOpen bool   // 只驻留托盘，不自动拉起/打开 WebUI
}

type trayState struct {
	root     string // U 盘根
	stateDir string // <root>/data/.openclaw

	gwPort   int    // runtime.json 的 gatewayPort（0 = 未知）
	cfgPort  int    // runtime.json 的 configServerPort（0 = 未知）
	token    string // 打开 Dashboard 用的 gateway token
	gwShape  bool   // /ready 响应体形状正确 = 真的是我们的 gateway 在监听
	gwReady  bool   // shapeOK 且 ready == true
	cfgAlive bool   // 配置中心 HTTP 可达
}

// ── 命令行 ───────────────────────────────────────────────────────────────────

func parseArgs(args []string) options {
	var opt options
	for _, arg := range args {
		switch strings.ToLower(strings.TrimSpace(arg)) {
		case "--tray-only", "-tray-only", "--no-open", "-no-open":
			opt.noOpen = true
		default:
			// 第 1 个非选项参数 = U 盘根（显式指定优先于 exe 位置推断）。
			if opt.root == "" && strings.TrimSpace(arg) != "" {
				opt.root = strings.TrimSpace(arg)
			}
		}
	}
	if v := strings.TrimSpace(os.Getenv("UCLAW_TRAY_NO_OPEN")); v == "1" || strings.EqualFold(v, "true") {
		opt.noOpen = true
	}
	return opt
}

// ── U 盘根定位 ───────────────────────────────────────────────────────────────

// resolveRoot 定位 U 盘根：命令行参数优先，其次从 exe 所在目录向上找骨架标记。
func resolveRoot(explicit string) string {
	if explicit != "" {
		if abs, err := filepath.Abs(explicit); err == nil {
			if fi, statErr := os.Stat(abs); statErr == nil && fi.IsDir() {
				return abs
			}
		}
	}

	exe, err := os.Executable()
	if err != nil {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			return wd
		}
		return "."
	}
	if resolved, linkErr := filepath.EvalSymlinks(exe); linkErr == nil {
		exe = resolved
	}

	// 从 exe 所在目录往上找（最多 4 层），兼容两种放置：
	//   <root>/U-Claw-Tray.exe            → <root>
	//   <root>/app/tray/U-Claw-Tray.exe   → <root>（README 推荐位置）
	// 同时认 dev 布局：<repo>/portable/Windows-Start.bat。
	dir := filepath.Dir(exe)
	for i := 0; i < 4; i++ {
		if looksLikeRoot(dir) {
			return dir
		}
		if child := filepath.Join(dir, "portable"); looksLikeRoot(child) {
			return child
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	// 兜底：exe 所在目录的上级（约定放在 app/ 下时这里就是 U 盘根）。
	return filepath.Dir(filepath.Dir(exe))
}

// looksLikeRoot 判断目录是否像 U 盘根，避免把随便一个目录当成 U 盘。
func looksLikeRoot(dir string) bool {
	if fi, err := os.Stat(filepath.Join(dir, "Windows-Start.bat")); err == nil && !fi.IsDir() {
		return true
	}
	if fi, err := os.Stat(filepath.Join(dir, "data", ".openclaw")); err == nil && fi.IsDir() {
		return true
	}
	if fi, err := os.Stat(filepath.Join(dir, "lib", "runtime-ports.mjs")); err == nil && !fi.IsDir() {
		return true
	}
	return false
}

// ── U 盘状态读取（只读）─────────────────────────────────────────────────────

type runtimePorts struct {
	GatewayPort      int `json:"gatewayPort"`
	ConfigServerPort int `json:"configServerPort"`
}

// readRuntimePorts 读 lib/runtime-ports.mjs 维护的 runtime.json；读不到就返回 0（未知）。
func readRuntimePorts(stateDir string) runtimePorts {
	var ports runtimePorts
	data, err := os.ReadFile(filepath.Join(stateDir, "runtime.json"))
	if err != nil {
		return ports
	}
	var raw runtimePorts
	if err := json.Unmarshal(data, &raw); err != nil {
		return ports
	}
	ports.GatewayPort = validPort(raw.GatewayPort)
	ports.ConfigServerPort = validPort(raw.ConfigServerPort)
	return ports
}

func validPort(port int) int {
	if port > 0 && port <= 65535 {
		return port
	}
	return 0
}

// readGatewayToken 与 config-server/server.js readGatewayToken() 同优先级：
// token 文件（gateway-token，每支盘随机）→ openclaw.json 的 gateway.auth.token → "uclaw"。
func readGatewayToken(stateDir string) string {
	if data, err := os.ReadFile(filepath.Join(stateDir, gatewayTokenFile)); err == nil {
		if token := usableToken(string(data)); token != "" {
			return token
		}
	}
	if data, err := os.ReadFile(filepath.Join(stateDir, openclawConfigFile)); err == nil {
		var cfg struct {
			Gateway struct {
				Auth struct {
					Token string `json:"token"`
				} `json:"auth"`
			} `json:"gateway"`
		}
		if json.Unmarshal(data, &cfg) == nil {
			if token := usableToken(cfg.Gateway.Auth.Token); token != "" {
				return token
			}
		}
	}
	return defaultToken
}

// usableToken 与 lib/gateway-token.mjs 的 usableToken 判定一致：非空、无内部空白/控制字符。
func usableToken(raw string) string {
	token := strings.TrimSpace(raw)
	if token == "" || len(token) > 4096 {
		return ""
	}
	for _, r := range token {
		if r <= 0x1f || r == 0x7f || unicode.IsSpace(r) {
			return ""
		}
	}
	return token
}

// modelConfigured 与 lib/check-model-configured.mjs 的判定一致：
// openclaw.json 的 agents.defaults.model.primary 是非空字符串 = 已配置模型。
// 静默失败：文件缺失 / JSON 损坏 / 字段缺失一律当"未配置"（宁可多弹一次配置页）。
func modelConfigured(stateDir string) bool {
	data, err := os.ReadFile(filepath.Join(stateDir, openclawConfigFile))
	if err != nil {
		return false
	}
	var cfg struct {
		Agents struct {
			Defaults struct {
				Model struct {
					Primary string `json:"primary"`
				} `json:"model"`
			} `json:"defaults"`
		} `json:"agents"`
	}
	if json.Unmarshal(data, &cfg) != nil {
		return false
	}
	return strings.TrimSpace(cfg.Agents.Defaults.Model.Primary) != ""
}

// ── 探活 ─────────────────────────────────────────────────────────────────────

// probeGateway 判定端口上是不是"我们的 gateway 且已就绪"。
//
//	shapeOK = /ready 响应体形状正确（真的是 OpenClaw gateway 在监听）
//	ready   = shapeOK 且 ready == true（还在启动时为 false）
func probeGateway(port int) (shapeOK, ready bool) {
	if port <= 0 {
		return false, false
	}
	resp, err := probeClient.Get(fmt.Sprintf("http://127.0.0.1:%d/ready", port))
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return false, false
	}
	var probe struct {
		Ready     *bool              `json:"ready"`
		Failing   *[]json.RawMessage `json:"failing"`
		UptimeMs  *float64           `json:"uptimeMs"`
		EventLoop json.RawMessage    `json:"eventLoop"`
	}
	if json.Unmarshal(body, &probe) != nil {
		return false, false
	}
	// 真 OpenClaw /ready 固定返回 {ready: boolean, failing: array, uptimeMs: number,
	// eventLoop: {...}}；四个字段同时存在，比"HTTP 200"难被无关本地服务偶然撞上。
	if probe.Ready == nil || probe.Failing == nil || probe.UptimeMs == nil || !isJSONObject(probe.EventLoop) {
		return false, false
	}
	return true, *probe.Ready
}

func isJSONObject(raw json.RawMessage) bool {
	return strings.HasPrefix(strings.TrimSpace(string(raw)), "{")
}

// probeConfigServer 判定配置中心是否在线。配置中心没有 /health 端点，GET / 是 Config.html
// 静态页（config-server/server.js）——只要它在监听且不是 5xx，用户点开就是可用页面。
func probeConfigServer(port int) bool {
	if port <= 0 {
		return false
	}
	resp, err := probeClient.Get(configCenterURL(port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	return resp.StatusCode > 0 && resp.StatusCode < http.StatusInternalServerError
}

// waitGatewayReady 轮询 runtime.json + /ready，直到就绪或超时。
// token 每轮都重读：首次启动时 lib/gateway-token.mjs 是在启动过程中才生成 token 文件的。
func waitGatewayReady(root string, timeout time.Duration) (port int, token string, ok bool) {
	stateDir := filepath.Join(root, "data", ".openclaw")
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ports := readRuntimePorts(stateDir)
		if ports.GatewayPort > 0 {
			if shapeOK, readyNow := probeGateway(ports.GatewayPort); shapeOK && readyNow {
				return ports.GatewayPort, readGatewayToken(stateDir), true
			}
		}
		time.Sleep(time.Second)
	}
	return 0, "", false
}

// ── URL 拼装 ─────────────────────────────────────────────────────────────────

// dashboardURL 拼装规则与 lib/open-app.ps1 / lib/loading.html 一致：
//
//	http://127.0.0.1:<gatewayPort>/#token=<token>
func dashboardURL(port int, token string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/#token=%s", port, escapeFragment(token))
}

// configCenterURL 与 lib/open-app.ps1 的 config 模式一致。
func configCenterURL(port int) string {
	return fmt.Sprintf("http://127.0.0.1:%d/", port)
}

// escapeFragment 按 JS encodeURIComponent 语义转义（与 lib/loading.html 的
// encodeURIComponent(token) 一致）：token 进 URL fragment，hex token 转义后与原样等价，
// 老盘的 "uclaw" 也不变；用户手工设过含 & / # / % 的 token 时不会被 fragment 语法截断。
func escapeFragment(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z',
			c >= 'A' && c <= 'Z',
			c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'', c == '(', c == ')':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0x0f])
		}
	}
	return b.String()
}

// ── 状态文案 ─────────────────────────────────────────────────────────────────

func statusText(s trayState, starting bool) string {
	gw := "—"
	if s.gwPort > 0 {
		gw = fmt.Sprintf(":%d", s.gwPort)
	}
	cfg := "—"
	if s.cfgPort > 0 {
		cfg = fmt.Sprintf(":%d", s.cfgPort)
	}
	switch {
	case s.gwReady:
		return fmt.Sprintf("状态：已就绪 · Gateway %s · 配置中心 %s", gw, cfg)
	case starting:
		return fmt.Sprintf("状态：启动中 · Gateway %s", gw)
	case s.gwShape:
		return fmt.Sprintf("状态：网关启动中 · Gateway %s", gw)
	case s.gwPort > 0:
		return fmt.Sprintf("状态：未就绪（Gateway %s 无有效响应） · 配置中心 %s", gw, cfg)
	case s.cfgAlive:
		return fmt.Sprintf("状态：网关未运行（配置中心 %s 在线）", cfg)
	default:
		return "状态：U-Claw 未运行"
	}
}
