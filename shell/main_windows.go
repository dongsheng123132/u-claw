// U-Claw's optional window. The Gateway remains owned by Windows-Start.bat.
package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

func main() {
	var targetFlag = flag.String("url", "", "U-Claw Gateway loopback dashboard URL")
	var cacheFlag = flag.String("user-data-dir", "", "Host-side WebView2 data directory")
	flag.Parse()
	if *targetFlag == "" || *cacheFlag == "" {
		fail("Usage: U-Claw-Shell.exe --url <loopback-url> --user-data-dir <host-cache-directory>")
	}
	target, err := url.Parse(*targetFlag)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.User != nil {
		fail("Only the local U-Claw Gateway can be opened.")
	}
	cache, err := filepath.Abs(*cacheFlag)
	if err != nil {
		fail("Invalid host cache directory.")
	}
	if err = os.MkdirAll(cache, 0700); err != nil {
		fail("Cannot create host cache: " + err.Error())
	}
	w := webview.NewWithOptions(webview.WebViewOptions{DataPath: cache, AutoFocus: true, WindowOptions: webview.WindowOptions{Title: "U-Claw · WebView2", Width: 1280, Height: 800, Center: true}})
	if w == nil {
		fail("WebView2 Runtime is unavailable. Please use Windows-App.bat (Edge) instead.")
	}
	defer w.Destroy()
	// Subclass the native window so accidental close has an explicit confirmation.
	// The callback delegates every other message to WebView2's original procedure.
	user32 := syscall.NewLazyDLL("user32.dll")
	setProc := user32.NewProc("SetWindowLongPtrW")
	callProc := user32.NewProc("CallWindowProcW")
	messageBox := user32.NewProc("MessageBoxW")
	hwnd := uintptr(w.Window())
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

func fail(message string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("U-Claw")
	user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
	os.Exit(1)
}
