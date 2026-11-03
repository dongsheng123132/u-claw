// U-Claw's optional window. The Gateway remains owned by Windows-Start.bat.
package main

import (
	_ "embed"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

//go:embed icon.ico
var appIcon []byte

func main() {
	if len(os.Args) < 3 || len(os.Args) > 4 {
		fail("Usage: U-Claw-Shell.exe <loopback-url> <host-cache-directory> [config-server-url]")
	}
	apiBase := ""
	if len(os.Args) == 4 {
		api, apiErr := url.Parse(os.Args[3])
		if apiErr == nil && api.Scheme == "http" && api.Hostname() == "127.0.0.1" {
			apiBase = strings.TrimRight(os.Args[3], "/")
		}
	}
	target, err := url.Parse(os.Args[1])
	if err != nil || target.User != nil {
		fail("Invalid U-Claw URL.")
	}
	loopback := target.Scheme == "http" && target.Hostname() == "127.0.0.1"
	splash := target.Scheme == "file" && strings.HasSuffix(strings.ToLower(filepath.Base(target.Path)), "loading.html")
	if !loopback && !splash {
		fail("Only the local U-Claw Gateway can be opened.")
	}
	cache, err := filepath.Abs(os.Args[2])
	if err != nil {
		fail("Invalid host cache directory.")
	}
	if err = os.MkdirAll(cache, 0700); err != nil {
		fail("Cannot create host cache: " + err.Error())
	}
	iconPath := filepath.Join(cache, "u-claw.ico")
	if err = os.WriteFile(iconPath, appIcon, 0600); err != nil {
		fail("Cannot write window icon: " + err.Error())
	}
	w := webview.NewWithOptions(webview.WebViewOptions{DataPath: cache, AutoFocus: true, WindowOptions: webview.WindowOptions{Title: "U-Claw", Width: 1280, Height: 800, Center: true}})
	if w == nil {
		fail("WebView2 Runtime is unavailable. Please use Windows-App.bat (Edge) instead.")
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	applyWindowIcon(hwnd, iconPath)
	// Subclass the native window so accidental close has an explicit confirmation.
	// The callback delegates every other message to WebView2's original procedure.
	user32 := syscall.NewLazyDLL("user32.dll")
	setProc := user32.NewProc("SetWindowLongPtrW")
	callProc := user32.NewProc("CallWindowProcW")
	messageBox := user32.NewProc("MessageBoxW")
	var original uintptr
	callback := syscall.NewCallback(func(h uintptr, msg uint32, wp, lp uintptr) uintptr {
		if msg == 0x0010 { // WM_CLOSE
			text, _ := syscall.UTF16PtrFromString("关闭 U-Claw 窗口？后台服务会继续运行，再次双击可重新打开。")
			title, _ := syscall.UTF16PtrFromString("U-Claw")
			answer, _, _ := messageBox.Call(h, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x124) // Yes/No, default No
			if answer != 6 {
				return 0
			}
		}
		result, _, _ := callProc.Call(original, h, uintptr(msg), wp, lp)
		return result
	})
	index := int32(-4) // GWLP_WNDPROC
	original, _, err = setProc.Call(hwnd, uintptr(index), callback)
	if original == 0 {
		fail(fmt.Sprint("Unable to install window close protection: ", err))
	}
	w.Navigate(target.String())
	if apiBase != "" {
		// The wallet chip is the only addition to the official Control UI: a small
		// fixed-position badge showing the 虾盘云 balance with a recharge button.
		// Re-injected on every page load so a reload never loses it.
		go func() {
			for i := 0; i < 240; i++ {
				time.Sleep(2 * time.Second)
				w.Dispatch(func() { w.Eval(walletChipScript(apiBase)) })
			}
		}()
	}
	w.Run()
}

func applyWindowIcon(hwnd uintptr, iconPath string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	loadImage := user32.NewProc("LoadImageW")
	sendMessage := user32.NewProc("SendMessageW")
	pathPtr, _ := syscall.UTF16PtrFromString(iconPath)
	const LR_LOADFROMFILE = 0x0010
	for _, big := range []uintptr{0, 1} { // ICON_SMALL, ICON_BIG
		icon, _, _ := loadImage.Call(0, uintptr(unsafe.Pointer(pathPtr)), 1, 0, 0, LR_LOADFROMFILE)
		if icon != 0 {
			sendMessage.Call(hwnd, 0x0080, big, icon) // WM_SETICON
		}
	}
}

func fail(message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("U-Claw")
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
	os.Exit(1)
}

// walletChipScript renders the persistent 虾盘云 badge. It is idempotent (safe to
// re-inject), uses the local config-server for data, and never touches the
// Control UI's own layout: one fixed element in the corner.
func walletChipScript(apiBase string) string {
	return `
(function(){
  if (window.__uclawWalletChip) { window.__uclawWalletChip.refresh(); return; }
  var API = '` + apiBase + `';
  var root = document.createElement('div');
  root.id = 'uclaw-wallet-chip';
  root.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2129;';
  root.innerHTML = '<div id="uclaw-wallet-pill" style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #f0d3c4;box-shadow:0 6px 20px rgba(0,0,0,.12);border-radius:999px;padding:6px 12px;cursor:pointer;">'
    + '<span style="font-size:15px;">💰</span><span id="uclaw-wallet-amount">—</span>'
    + '<span id="uclaw-wallet-hint" style="color:#86909c;font-size:12px;"></span></div>'
    + '<div id="uclaw-wallet-panel" style="display:none;margin-top:8px;width:260px;background:#fff;border:1px solid #e5e6eb;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:12px;">'
    + '<div style="font-weight:600;margin-bottom:6px;">虾盘云钱包</div>'
    + '<div id="uclaw-wallet-big" style="font-size:24px;font-weight:700;">¥ —</div>'
    + '<div id="uclaw-wallet-note" style="color:#86909c;font-size:12px;margin:4px 0 10px;">正在读取…</div>'
    + '<button id="uclaw-wallet-recharge" style="width:100%;background:#ff6b35;color:#fff;border:0;border-radius:8px;padding:8px;font-size:13px;cursor:pointer;">去充值</button>'
    + '<div style="display:flex;gap:8px;margin-top:8px;">'
    + '<button id="uclaw-wallet-copy" style="flex:1;background:#f2f3f5;border:0;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;">复制密钥</button>'
    + '<button id="uclaw-wallet-config" style="flex:1;background:#f2f3f5;border:0;border-radius:8px;padding:6px;font-size:12px;cursor:pointer;">配置页</button>'
    + '</div></div>';
  document.body.appendChild(root);
  var $ = function(id){ return document.getElementById(id); };
  var state = { key: '' };
  function fmt(n){ return '¥' + (Math.round(n * 100) / 100).toFixed(2); }
  function refresh(){
    fetch(API + '/api/wallet/status').then(function(r){ return r.json(); }).then(function(s){
      if (!s || !s.hasWallet) { $('uclaw-wallet-amount').textContent = '未领取'; $('uclaw-wallet-hint').textContent = '点这里领取'; $('uclaw-wallet-big').textContent = '未领取'; $('uclaw-wallet-note').textContent = '在配置页点「领取免费额度」'; return; }
      $('uclaw-wallet-amount').textContent = '钱包';
      return fetch(API + '/api/wallet/balance').then(function(r){ return r.json(); }).then(function(b){
        if (!b || !b.ok) { $('uclaw-wallet-big').textContent = '¥ —'; $('uclaw-wallet-note').textContent = '暂时查不到余额，不影响聊天'; return; }
        var left = Number(b.remainingUsd || 0);
        $('uclaw-wallet-big').textContent = fmt(left);
        $('uclaw-wallet-amount').textContent = fmt(left);
        $('uclaw-wallet-hint').textContent = left > 0 ? '' : '余额不足';
        $('uclaw-wallet-note').textContent = left > 0 ? ('大约还能聊 ' + Math.max(0, Math.floor(left / 0.02)) + ' 次') : '余额不足，先充值再聊天';
      });
    }).catch(function(){ $('uclaw-wallet-big').textContent = '¥ —'; $('uclaw-wallet-note').textContent = '连不上本地服务'; });
  }
  $('uclaw-wallet-pill').onclick = function(){ var p = $('uclaw-wallet-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; refresh(); };
  $('uclaw-wallet-recharge').onclick = function(){ fetch(API + '/api/wallet/open-recharge', { method: 'POST' }).catch(function(){}); };
  $('uclaw-wallet-copy').onclick = function(){ fetch(API + '/api/wallet/status').then(function(r){ return r.json(); }).then(function(s){ if (s && s.apiKey) { navigator.clipboard.writeText(s.apiKey); $('uclaw-wallet-note').textContent = '密钥已复制，请妥善保存'; } }); };
  $('uclaw-wallet-config').onclick = function(){ window.location.href = API + '/'; };
  window.__uclawWalletChip = { refresh: refresh };
  refresh();
  setInterval(refresh, 60000);
})();
`
}
