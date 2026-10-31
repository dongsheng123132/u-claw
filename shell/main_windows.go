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
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

//go:embed icon.ico
var appIcon []byte

func main() {
	if len(os.Args) != 3 {
		fail("Usage: U-Claw-Shell.exe <loopback-url> <host-cache-directory>")
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
