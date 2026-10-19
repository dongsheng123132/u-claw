#!/bin/bash
# ============================================================
# U-Claw - OpenClaw Doctor (官方完整体检, 进阶, 英文)
# 注意：先启动 U-Claw 再跑本工具，否则 doctor 会卡在探测未启动的 gateway 上。
# 只读：故意不传 --fix/--repair/--force。卡住可按 Ctrl+C 安全中断。
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"

ARCH=$(uname -m)
case "$ARCH" in
    arm64)  NODE_BIN="$APP_DIR/runtime/node-mac-arm64/bin/node" ;;
    x86_64) NODE_BIN="$APP_DIR/runtime/node-mac-x64/bin/node" ;;
    *)      NODE_BIN="" ;;
esac
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$(command -v node)"; fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "  [错误] 找不到 Node 运行环境。"
    read -p "  按回车关闭..."
    exit 1
fi
if [ ! -f "$OPENCLAW_MJS" ]; then
    echo "  [错误] 找不到 OpenClaw 运行时 (app/core/node_modules/openclaw)。"
    read -p "  按回车关闭..."
    exit 1
fi

# 本机缓存/临时/日志目录（共享 helper）；没有可写本机缓存 = 明确失败退出。
if ! . "$UCLAW_DIR/lib/portable-cache-env.sh" "$STATE_DIR" "$UCLAW_DIR" "$NODE_BIN"; then
    echo "  [错误] 无可写本机缓存目录，拒绝回落 U 盘。"
    read -p "  按回车关闭..."
    exit 1
fi

export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1

xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true

echo ""
echo "  ========================================"
echo "    OpenClaw Doctor (官方体检, 英文, 较慢)"
echo "  ========================================"
echo "  请确保 U-Claw 已经在运行。卡住可 Ctrl+C 中断（只读，安全）。"
echo "  想要快速的中文体检请改用 Mac-IntranetFix.command。"
echo ""
read -p "  按回车开始..."

"$NODE_BIN" "$OPENCLAW_MJS" doctor --non-interactive

echo ""
read -p "  按回车关闭..."
