//go:build !windows

// U-Claw 托盘是 Windows 专用程序（systray 的 Windows 后端走纯 syscall，无 CGO）。
// 这个空实现让 macOS/Linux 上的 `go build ./...` / `go vet ./...` 不会被误当成
// Windows 构建（也不会意外产出一个"看起来能用"的托盘二进制）。
package main

import (
	"fmt"
	"os"
	"runtime"
)

func main() {
	fmt.Fprintf(
		os.Stderr,
		"U-Claw-Tray 只支持 Windows（当前 %s/%s）。请交叉编译：cd tray && ./build.sh，\n"+
			"或 GOOS=windows GOARCH=amd64 go build -o build/U-Claw-Tray.exe .\n",
		runtime.GOOS, runtime.GOARCH,
	)
	os.Exit(1)
}
