#!/bin/bash
# ============================================================
# U-Claw Maintain (macOS) — 薄菜单：只收输入、打开入口
# 模型/钱包设置、诊断、本机日志、备份、恢复到新目录、原生 CLI、稳定发行页
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
MAINT="$UCLAW_DIR/lib/portable-maintenance.mjs"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$UCLAW_DIR/app/runtime/node-mac-arm64/bin/node"
else
    NODE_BIN="$UCLAW_DIR/app/runtime/node-mac-x64/bin/node"
fi

export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$STATE_DIR/openclaw.json"
export OPENCLAW_DISABLE_BONJOUR=1

if [ ! -f "$NODE_BIN" ]; then
    echo "  运行时不存在: $NODE_BIN"
    echo "  请先运行 setup.sh，再打开 Mac-Maintain.command。"
    read -r -p "  Press Enter to exit..."
    exit 1
fi
if [ ! -f "$MAINT" ]; then
    echo "  缺少维护工具: $MAINT"
    read -r -p "  Press Enter to exit..."
    exit 1
fi

show_menu() {
    echo ""
    echo "  ========================================"
    echo "    U-Claw Maintain / 维护菜单"
    echo "  ========================================"
    echo ""
    echo "  1) 模型钱包设置"
    echo "  2) 现有 Diagnose 诊断"
    echo "  3) 打开本机日志"
    echo "  4) 备份"
    echo "  5) 恢复到新目录"
    echo "  6) 原生 CLI"
    echo "  7) 稳定发行页"
    echo ""
    echo "  0) 退出"
    echo ""
}

do_settings() {
    local url
    url="$("$NODE_BIN" "$MAINT" settings-url)"
    if [ -z "$url" ]; then
        echo "  取不到设置地址。请先启动 U-Claw（Mac-Start.command）。"
        return
    fi
    open "$url"
}

do_logs() {
    local dir
    dir="$("$NODE_BIN" "$MAINT" logs-path)"
    if [ -z "$dir" ]; then
        echo "  取不到本机日志目录。"
        return
    fi
    open "$dir"
}

do_backup() {
    echo ""
    echo "  注意：进行中的会话 .jsonl 不会包含在 openclaw backup 里（上游当作易失数据跳过）。"
    read -r -p "  备份输出路径（回车 = 默认 data/backups 目录）: " out
    if [ -n "$out" ]; then
        "$NODE_BIN" "$MAINT" backup --output "$out"
    else
        "$NODE_BIN" "$MAINT" backup
    fi
}

do_restore() {
    echo ""
    echo "  注意：进行中的会话 .jsonl 不会包含在 openclaw backup 里（上游当作易失数据跳过）。"
    echo "  恢复只会写入 data/backups 下的全新空目录，绝不覆盖正在使用的状态；切换前请先停 Gateway。"
    read -r -p "  要恢复的备份归档路径: " archive
    if [ -z "$archive" ]; then
        echo "  未输入归档路径。"
        return
    fi
    "$NODE_BIN" "$MAINT" restore "$archive"
}

do_cli() {
    bash "$UCLAW_DIR/Mac-OpenClaw-CLI.command"
}

do_release() {
    open "https://github.com/dongsheng123132/u-claw/releases"
}

while true; do
    show_menu
    read -r -p "  请选择: " choice
    case "$choice" in
        1) do_settings ;;
        2) bash "$UCLAW_DIR/Mac-Diagnose.command" ;;
        3) do_logs ;;
        4) do_backup; read -r -p "  Press Enter to continue..." _ ;;
        5) do_restore; read -r -p "  Press Enter to continue..." _ ;;
        6) do_cli ;;
        7) do_release ;;
        0) exit 0 ;;
        *) ;;
    esac
done
