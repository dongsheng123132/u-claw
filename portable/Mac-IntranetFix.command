#!/bin/bash
# ============================================================
# U-Claw - 内网体检 / Intranet Check (macOS)
# 双击运行：代理env + 直连可达 + 真发一条对话
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CONFIG_FILE="$UCLAW_DIR/data/.openclaw/openclaw.json"

ARCH=$(uname -m)
case "$ARCH" in
    arm64)  NODE_BIN="$APP_DIR/runtime/node-mac-arm64/bin/node" ;;
    x86_64) NODE_BIN="$APP_DIR/runtime/node-mac-x64/bin/node" ;;
    *)      NODE_BIN="" ;;
esac
# 退而求其次：用系统 node
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "  [错误] 找不到 Node 运行环境。请先正常启动一次 U-Claw。"
    read -p "  按回车关闭..."
    exit 1
fi

# 去掉 macOS 隔离属性，避免 Gatekeeper 拦截
xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true

# 接入本机缓存 helper（体检工具：失败时报告错误但继续基础网络检查）。
if ! . "$UCLAW_DIR/lib/portable-cache-env.sh" "$UCLAW_DIR/data/.openclaw" "$UCLAW_DIR" "$NODE_BIN"; then
    echo "  [警告] 无可写本机缓存目录（见上方错误），继续体检。"
fi

"$NODE_BIN" "$UCLAW_DIR/lib/intranet-check.mjs" "$CONFIG_FILE"

echo ""
echo "  把整个窗口截图发给技术支持即可。"
echo ""
read -p "  按回车关闭..."
