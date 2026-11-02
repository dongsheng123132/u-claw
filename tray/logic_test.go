// 平台无关逻辑的单元测试。托盘本身只能在 Windows 上跑，但 URL 拼装、token 优先级、
// runtime.json 容错、/ready 形状判定这些“最容易改错又最难在 Windows 上肉眼验”的部分
// 全部在 logic.go 里，用 `go test ./...`（macOS / Linux / CI）就能回归。
package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func tempStateDir(t *testing.T) (root, stateDir string) {
	t.Helper()
	root = t.TempDir()
	stateDir = filepath.Join(root, "data", ".openclaw")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatalf("mkdir state dir: %v", err)
	}
	return root, stateDir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func serverPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}
	return port
}

// ── URL 规则（必须与 lib/open-app.ps1 / lib/loading.html 一致）───────────────

func TestDashboardURL(t *testing.T) {
	cases := []struct {
		port  int
		token string
		want  string
	}{
		{18789, "uclaw", "http://127.0.0.1:18789/#token=uclaw"},
		{18790, "deadbeef", "http://127.0.0.1:18790/#token=deadbeef"},
		{18789, "a b&c#d", "http://127.0.0.1:18789/#token=a%20b%26c%23d"},
	}
	for _, c := range cases {
		if got := dashboardURL(c.port, c.token); got != c.want {
			t.Errorf("dashboardURL(%d, %q) = %q, want %q", c.port, c.token, got, c.want)
		}
	}
}

func TestConfigCenterURL(t *testing.T) {
	if got, want := configCenterURL(18788), "http://127.0.0.1:18788/"; got != want {
		t.Errorf("configCenterURL = %q, want %q", got, want)
	}
}

func TestEscapeFragment(t *testing.T) {
	// 与 JS encodeURIComponent 对齐：未保留字符不动，其余按 UTF-8 字节百分号转义。
	cases := map[string]string{
		"uclaw":            "uclaw",
		"a b":              "a%20b",
		"a&b=c#d%e":        "a%26b%3Dc%23d%25e",
		"Abc-_.!~*'()123":  "Abc-_.!~*'()123",
		"é":                "%C3%A9",
		"token/with+slash": "token%2Fwith%2Bslash",
	}
	for in, want := range cases {
		if got := escapeFragment(in); got != want {
			t.Errorf("escapeFragment(%q) = %q, want %q", in, got, want)
		}
	}
}

// ── runtime.json / token 读取 ────────────────────────────────────────────────

func TestReadRuntimePorts(t *testing.T) {
	_, stateDir := tempStateDir(t)

	// 文件不存在：一律未知（0），不猜端口。
	if ports := readRuntimePorts(stateDir); ports.GatewayPort != 0 || ports.ConfigServerPort != 0 {
		t.Errorf("missing runtime.json: %+v", ports)
	}

	// 合法字段。
	writeFile(t, filepath.Join(stateDir, "runtime.json"), `{"gatewayPort":18793,"configServerPort":18788}`)
	ports := readRuntimePorts(stateDir)
	if ports.GatewayPort != 18793 || ports.ConfigServerPort != 18788 {
		t.Errorf("valid runtime.json: %+v", ports)
	}

	// 越界 / 非整数 / 字符串端口：逐字段丢弃，不允许把脏值带进 URL。
	writeFile(t, filepath.Join(stateDir, "runtime.json"), `{"gatewayPort":70000,"configServerPort":-1}`)
	ports = readRuntimePorts(stateDir)
	if ports.GatewayPort != 0 || ports.ConfigServerPort != 0 {
		t.Errorf("out-of-range ports accepted: %+v", ports)
	}
	writeFile(t, filepath.Join(stateDir, "runtime.json"), `{"gatewayPort":"18789","configServerPort":null}`)
	ports = readRuntimePorts(stateDir)
	if ports.GatewayPort != 0 || ports.ConfigServerPort != 0 {
		t.Errorf("wrong-type ports accepted: %+v", ports)
	}

	// 损坏的 JSON：当没有（config-server 对同一文件也是这个宽容态度）。
	writeFile(t, filepath.Join(stateDir, "runtime.json"), `{"gatewayPort":`)
	if ports = readRuntimePorts(stateDir); ports.GatewayPort != 0 {
		t.Errorf("corrupt runtime.json accepted: %+v", ports)
	}
}

func TestValidPort(t *testing.T) {
	cases := map[int]int{0: 0, -1: 0, 65535: 65535, 65536: 0, 18789: 18789}
	for in, want := range cases {
		if got := validPort(in); got != want {
			t.Errorf("validPort(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestReadGatewayTokenPrecedence(t *testing.T) {
	// 1) token 文件优先于 openclaw.json（随机 token 时代是唯一真相源）。
	_, stateDir := tempStateDir(t)
	writeFile(t, filepath.Join(stateDir, "gateway-token"), "file-token\n")
	writeFile(t, filepath.Join(stateDir, "openclaw.json"), `{"gateway":{"auth":{"token":"config-token"}}}`)
	if got := readGatewayToken(stateDir); got != "file-token" {
		t.Errorf("token file priority: got %q", got)
	}

	// 2) token 文件里是旧值 "uclaw"：照读（迁移是启动脚本的事，托盘不篡改）。
	writeFile(t, filepath.Join(stateDir, "gateway-token"), "uclaw")
	if got := readGatewayToken(stateDir); got != "uclaw" {
		t.Errorf("legacy file token: got %q", got)
	}

	// 3) token 文件损坏（内部空白）：回退 openclaw.json。
	writeFile(t, filepath.Join(stateDir, "gateway-token"), "bad token")
	if got := readGatewayToken(stateDir); got != "config-token" {
		t.Errorf("corrupt token file fallback: got %q", got)
	}

	// 4) 两个文件都没有：旧默认值兜底（与 config-server/server.js 一致）。
	_, emptyDir := tempStateDir(t)
	if got := readGatewayToken(emptyDir); got != defaultToken {
		t.Errorf("default token: got %q", got)
	}

	// 5) openclaw.json 损坏 / token 不是字符串：仍回退默认值，不 panic。
	writeFile(t, filepath.Join(emptyDir, "openclaw.json"), `{"gateway":{"auth":{"token":123}}}`)
	if got := readGatewayToken(emptyDir); got != defaultToken {
		t.Errorf("non-string config token: got %q", got)
	}
}

func TestUsableToken(t *testing.T) {
	cases := map[string]bool{
		"abc123":                   true,
		"  abc123  ":               true, // TrimSpace 后可用
		"":                         false,
		"   ":                      false,
		"has space":                false,
		"tab\there":                false,
		"line\nbreak":              false,
		"nul\x00char":              false,
		"del\x7fchar":              false,
		"中文token":                  true,
		"0123456789abcdef01234567": true,
	}
	for token, want := range cases {
		if got := usableToken(token) != ""; got != want {
			t.Errorf("usableToken(%q) valid=%v, want %v", token, got, want)
		}
	}
}

func TestModelConfigured(t *testing.T) {
	_, stateDir := tempStateDir(t)

	if modelConfigured(stateDir) {
		t.Error("missing openclaw.json should be NOT configured")
	}
	writeFile(t, filepath.Join(stateDir, "openclaw.json"), `{"agents":{"defaults":{"model":{"primary":"xiapan/deepseek"}}}}`)
	if !modelConfigured(stateDir) {
		t.Error("primary set should be configured")
	}
	writeFile(t, filepath.Join(stateDir, "openclaw.json"), `{"agents":{"defaults":{"model":{"primary":"   "}}}}`)
	if modelConfigured(stateDir) {
		t.Error("blank primary should be NOT configured")
	}
	writeFile(t, filepath.Join(stateDir, "openclaw.json"), `not-json`)
	if modelConfigured(stateDir) {
		t.Error("corrupt config should be NOT configured")
	}
}

// ── /ready 形状判定（与 lib/open-app.ps1 Test-GatewayReady 同语义）──────────

func TestProbeGateway(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		body      string
		wantShape bool
		wantReady bool
	}{
		{"ready true", 200, `{"ready":true,"failing":[],"uptimeMs":1234,"eventLoop":{}}`, true, true},
		{"ready false", 200, `{"ready":false,"failing":["x"],"uptimeMs":12,"eventLoop":{"lag":1}}`, true, false},
		{"html 200 from some other server", 200, `<html><body>hello</body></html>`, false, false},
		{"missing eventLoop", 200, `{"ready":true,"failing":[],"uptimeMs":1}`, false, false},
		{"eventLoop is string", 200, `{"ready":true,"failing":[],"uptimeMs":1,"eventLoop":"x"}`, false, false},
		{"failing not array", 200, `{"ready":true,"failing":{},"uptimeMs":1,"eventLoop":{}}`, false, false},
		{"http 500", 500, `{"ready":true,"failing":[],"uptimeMs":1,"eventLoop":{}}`, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/ready" {
					t.Errorf("probe hit %q, want /ready", r.URL.Path)
				}
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			shape, ready := probeGateway(serverPort(t, srv))
			if shape != c.wantShape || ready != c.wantReady {
				t.Errorf("probeGateway = (shape=%v, ready=%v), want (%v, %v)", shape, ready, c.wantShape, c.wantReady)
			}
		})
	}

	// 未知端口 / 连不上的端口：不 panic，直接 false。
	if shape, ready := probeGateway(0); shape || ready {
		t.Errorf("probeGateway(0) = (%v, %v)", shape, ready)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadPort := serverPort(t, srv)
	srv.Close()
	if shape, ready := probeGateway(deadPort); shape || ready {
		t.Errorf("probeGateway(closed) = (%v, %v)", shape, ready)
	}
}

func TestProbeConfigServer(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html>Config Center</html>"))
	}))
	defer ok.Close()
	if !probeConfigServer(serverPort(t, ok)) {
		t.Error("200 config server should be alive")
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer bad.Close()
	if probeConfigServer(serverPort(t, bad)) {
		t.Error("500 config server should be NOT alive")
	}

	if probeConfigServer(0) {
		t.Error("unknown config port should be NOT alive")
	}
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadPort := serverPort(t, dead)
	dead.Close()
	if probeConfigServer(deadPort) {
		t.Error("closed config server should be NOT alive")
	}
}

func TestWaitGatewayReady(t *testing.T) {
	root, stateDir := tempStateDir(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ready":true,"failing":[],"uptimeMs":42,"eventLoop":{}}`))
	}))
	defer srv.Close()
	port := serverPort(t, srv)

	writeFile(t, filepath.Join(stateDir, "runtime.json"), `{"gatewayPort":`+strconv.Itoa(port)+`}`)
	writeFile(t, filepath.Join(stateDir, "gateway-token"), "runtime-token")

	gotPort, gotToken, ok := waitGatewayReady(root, 5*time.Second)
	if !ok || gotPort != port || gotToken != "runtime-token" {
		t.Errorf("waitGatewayReady = (%d, %q, %v), want (%d, %q, true)", gotPort, gotToken, ok, port, "runtime-token")
	}

	// 永远起不来：超时后返回 false（有界等待，绝不挂死）。
	_, emptyRoot := tempStateDir(t)
	start := time.Now()
	if _, _, ok := waitGatewayReady(emptyRoot, 100*time.Millisecond); ok {
		t.Error("waitGatewayReady should time out on empty root")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("timeout wait took %v, want bounded", elapsed)
	}
}

// ── 根目录推断 / 参数解析 / 状态文案 ────────────────────────────────────────

func TestLooksLikeRoot(t *testing.T) {
	empty := t.TempDir()
	if looksLikeRoot(empty) {
		t.Error("empty dir should NOT look like U-Claw root")
	}

	withBat := t.TempDir()
	writeFile(t, filepath.Join(withBat, "Windows-Start.bat"), "@echo off\r\n")
	if !looksLikeRoot(withBat) {
		t.Error("dir with Windows-Start.bat should look like a root")
	}

	withData := t.TempDir()
	if err := os.MkdirAll(filepath.Join(withData, "data", ".openclaw"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !looksLikeRoot(withData) {
		t.Error("dir with data/.openclaw should look like a root")
	}

	withLib := t.TempDir()
	writeFile(t, filepath.Join(withLib, "lib", "runtime-ports.mjs"), "//\n")
	if !looksLikeRoot(withLib) {
		t.Error("dir with lib/runtime-ports.mjs should look like a root")
	}
}

func TestParseArgs(t *testing.T) {
	t.Setenv("UCLAW_TRAY_NO_OPEN", "")

	opt := parseArgs([]string{`D:\U-Claw`})
	if opt.root != `D:\U-Claw` || opt.noOpen {
		t.Errorf("root arg: %+v", opt)
	}

	opt = parseArgs([]string{"--tray-only", "/Volumes/U-Claw"})
	if opt.root != "/Volumes/U-Claw" || !opt.noOpen {
		t.Errorf("flag before root: %+v", opt)
	}

	opt = parseArgs([]string{"/Volumes/U-Claw", "--tray-only"})
	if opt.root != "/Volumes/U-Claw" || !opt.noOpen {
		t.Errorf("flag after root: %+v", opt)
	}

	opt = parseArgs(nil)
	if opt.root != "" || opt.noOpen {
		t.Errorf("no args: %+v", opt)
	}

	t.Setenv("UCLAW_TRAY_NO_OPEN", "1")
	if opt = parseArgs(nil); !opt.noOpen {
		t.Errorf("env UCLAW_TRAY_NO_OPEN=1 should set noOpen: %+v", opt)
	}
}

func TestStatusText(t *testing.T) {
	base := trayState{root: "/x", stateDir: "/x/data/.openclaw"}

	s := base
	if got := statusText(s, false); got != "状态：U-Claw 未运行" {
		t.Errorf("not running: %q", got)
	}

	s = base
	s.gwPort, s.cfgPort = 18789, 18788
	s.gwShape, s.gwReady = true, true
	if got := statusText(s, false); got != "状态：已就绪 · Gateway :18789 · 配置中心 :18788" {
		t.Errorf("ready: %q", got)
	}

	s = base
	s.gwPort = 18789
	if got := statusText(s, true); got != "状态：启动中 · Gateway :18789" {
		t.Errorf("starting: %q", got)
	}

	s = base
	s.gwPort, s.cfgPort = 18789, 18788
	s.gwShape = true
	if got := statusText(s, false); got != "状态：网关启动中 · Gateway :18789" {
		t.Errorf("warming up: %q", got)
	}

	s = base
	s.gwPort, s.cfgPort = 18789, 18788
	if got := statusText(s, false); got != "状态：未就绪（Gateway :18789 无有效响应） · 配置中心 :18788" {
		t.Errorf("stale port: %q", got)
	}

	s = base
	s.cfgPort = 18788
	s.cfgAlive = true
	if got := statusText(s, false); got != "状态：网关未运行（配置中心 :18788 在线）" {
		t.Errorf("config only: %q", got)
	}
}
