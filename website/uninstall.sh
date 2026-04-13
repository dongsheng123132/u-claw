#!/bin/bash
# ============================================================
# U-Claw 一键卸载 (macOS / Linux)
# Usage: curl -fsSL https://u-claw.org/uninstall.sh | bash
# ============================================================

UCLAW_DIR="$HOME/.uclaw"
AGENT_DIR="/tmp/uclaw"

echo ""
echo "  =========================================="
echo "    U-Claw 一键卸载"
echo "  =========================================="
echo ""

# 1. Stop OpenClaw
if pgrep -f openclaw >/dev/null 2>&1; then
    echo "  [1/3] 停止 OpenClaw 进程..."
    pkill -f openclaw 2>/dev/null || true
    sleep 1
    echo "  [OK] 已停止"
else
    echo "  [1/3] OpenClaw 未在运行"
fi

# 2. Stop Agent (if running)
if pgrep -f "$AGENT_DIR/agent" >/dev/null 2>&1; then
    echo "  [2/3] 停止 Agent 进程..."
    pkill -f "$AGENT_DIR/agent" 2>/dev/null || true
    sleep 1
    echo "  [OK] 已停止"
else
    echo "  [2/3] Agent 未在运行"
fi

# 3. Remove files
echo "  [3/3] 清理文件..."
REMOVED=""

if [ -d "$UCLAW_DIR" ]; then
    rm -rf "$UCLAW_DIR"
    REMOVED="$REMOVED ~/.uclaw"
    echo "  [OK] 已删除 ~/.uclaw"
fi

if [ -d "$AGENT_DIR" ]; then
    rm -rf "$AGENT_DIR"
    REMOVED="$REMOVED /tmp/uclaw"
    echo "  [OK] 已删除 /tmp/uclaw"
fi

if [ -z "$REMOVED" ]; then
    echo "  [OK] 没有找到需要清理的文件"
fi

echo ""
echo "  =========================================="
echo "    卸载完成！已彻底清理。"
echo "  =========================================="
echo ""
echo "  想重装？运行："
echo "  curl -fsSL https://u-claw.org/install.sh | bash"
echo ""
