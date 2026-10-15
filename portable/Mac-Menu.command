#!/bin/bash
# U-Claw Menu - Portable AI Agent
# macOS version

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"

# Migration shim: rename old core-mac to core for existing USB users
if [ -d "$APP_DIR/core-mac" ] && [ ! -d "$APP_DIR/core" ]; then
    mv "$APP_DIR/core-mac" "$APP_DIR/core"
fi

CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
CONFIG_PATH="$STATE_DIR/openclaw.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# Node.js — detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
else
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
fi
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"
export PATH="$NODE_DIR/bin:$PATH"
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"

mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# Load maintenance functions
source "$UCLAW_DIR/lib/maintain.sh"

# Remove macOS quarantine
if xattr -l "$NODE_BIN" 2>/dev/null | grep -q "com.apple.quarantine"; then
    xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true
fi

# Run openclaw command
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"

run_oc() {
    cd "$CORE_DIR"
    "$NODE_BIN" "$OPENCLAW_MJS" "$@"
}

# Show menu
show_menu() {
    clear
    local NODE_VER=$("$NODE_BIN" --version 2>/dev/null || echo "N/A")
    local CFG_STATUS="${RED}未配置${NC}"
    [ -f "$CONFIG_PATH" ] && CFG_STATUS="${GREEN}已配置${NC}"

    echo ""
    echo -e "  ${CYAN}${BOLD}╔══════════════════════════════════════╗"
    echo -e "  ║   U-Claw 虾盘 v1.1                   ║"
    echo -e "  ║   Portable AI Agent                   ║"
    echo -e "  ╚══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Node: ${GREEN}${NODE_VER}${NC}  配置: ${CFG_STATUS}"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 配置 ──────────────────────────────${NC}"
    echo -e "  ${GREEN}[1]${NC}  模型配置（填写 API Key）"
    echo -e "  ${GREEN}[2]${NC}  打开网页控制台"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 维护 ──────────────────────────────${NC}"
    echo -e "  ${GREEN}[3]${NC}  诊断修复"
    echo -e "  ${GREEN}[4]${NC}  备份配置"
    echo -e "  ${GREEN}[5]${NC}  恢复备份"
    echo -e "  ${GREEN}[6]${NC}  系统信息"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 高级维护 ──────────────────────────${NC}"
    echo -e "  ${GREEN}[7]${NC}  杀死残留进程"
    echo -e "  ${GREEN}[8]${NC}  查看日志"
    echo -e "  ${GREEN}[9]${NC}  恢复出厂设置"
    echo -e "  ${GREEN}[10]${NC} 卸载"
    echo -e "  ${GREEN}[11]${NC} 检查更新"
    echo -e "  ${GREEN}[12]${NC} 清理空间"
    echo -e "  ${GREEN}[13]${NC} 进入 CLI 终端"
    echo ""
    echo -e "  ${DIM}[0]  退出${NC}"
    echo ""
}

# [1] Shared model configuration page
do_config() {
    local CONFIG_PORT=""
    local STARTED=0
    for i in $(seq 1 60); do
        while IFS='=' read -r _k _v; do
            case "$_k" in UCLAW_CONFIG_PORT) CONFIG_PORT="$_v" ;; esac
        done < <("$NODE_BIN" "$UCLAW_DIR/lib/runtime-ports.mjs" read "$STATE_DIR" 2>/dev/null)
        if [ -n "$CONFIG_PORT" ] && curl --noproxy '*' --max-time 1 -fsS "http://127.0.0.1:$CONFIG_PORT/api/runtime" >/dev/null 2>&1; then
            open "http://127.0.0.1:$CONFIG_PORT/" 2>/dev/null || true
            return
        fi
        if [ "$STARTED" = "0" ]; then
            open "$UCLAW_DIR/Mac-Start.command" 2>/dev/null || { echo "请先双击 Mac-Start.command 启动。"; return; }
            STARTED=1
        fi
        sleep 0.5
    done
    echo "配置页面尚未就绪，请在启动完成后重试。"
}

# [2] Web dashboard
do_dashboard() {
    bash "$UCLAW_DIR/Mac-Start.command"
}

# [5] Doctor
do_doctor() {
    echo ""
    echo -e "  ${CYAN}━━━ 诊断修复 ━━━${NC}"
    echo ""
    run_oc doctor --repair 2>&1 || echo -e "  ${YELLOW}诊断命令执行失败${NC}"
}

# [6] Backup
do_backup() {
    echo ""
    local TS=$(date +%Y%m%d_%H%M%S)
    local BK="$DATA_DIR/backups/backup_$TS"
    mkdir -p "$BK"

    [ -f "$CONFIG_PATH" ] && cp "$CONFIG_PATH" "$BK/" && echo -e "  ${GREEN}  + openclaw.json${NC}"
    [ -d "$DATA_DIR/memory" ] && cp -R "$DATA_DIR/memory" "$BK/" 2>/dev/null && echo -e "  ${GREEN}  + memory/${NC}"

    echo ""
    echo -e "  ${GREEN}备份完成: $BK${NC}"
    echo "  大小: $(du -sh "$BK" | cut -f1)"
}

# [7] Restore
do_restore() {
    echo ""
    local BK_DIR="$DATA_DIR/backups"
    if [ ! -d "$BK_DIR" ] || [ -z "$(ls -A "$BK_DIR" 2>/dev/null)" ]; then
        echo -e "  ${YELLOW}没有备份${NC}"
        return
    fi

    echo "  可用备份:"
    local i=1
    for b in "$BK_DIR"/*/; do
        echo -e "  ${GREEN}[$i]${NC} $(basename "$b") ($(du -sh "$b" | cut -f1))"
        i=$((i+1))
    done
    echo ""
    read -p "  选择编号: " NUM

    local j=1
    for b in "$BK_DIR"/*/; do
        if [ "$j" = "$NUM" ]; then
            [ -f "$b/openclaw.json" ] && cp "$b/openclaw.json" "$CONFIG_PATH" && echo -e "  ${GREEN}  + 配置已恢复${NC}"
            [ -d "$b/memory" ] && cp -R "$b/memory" "$DATA_DIR/" && echo -e "  ${GREEN}  + 记忆已恢复${NC}"
            echo -e "  ${GREEN}恢复完成${NC}"
            return
        fi
        j=$((j+1))
    done
    echo -e "  ${RED}无效选择${NC}"
}

# [8] System info
do_sysinfo() {
    echo ""
    echo "  系统:  $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"
    echo "  CPU:   $(uname -m)"
    echo "  内存:  $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1024/1024/1024}')"
    echo "  Node:  $("$NODE_BIN" --version 2>/dev/null)"
    echo "  路径:  $UCLAW_DIR"
    echo "  大小:  $(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)"
    echo "  磁盘:  $(df -h "$UCLAW_DIR" | tail -1 | awk '{print $4 " 可用"}')"
}

# [16] CLI terminal (advanced: openclaw chat/configure/doctor)
do_cli() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ CLI 终端 ━━━${NC}"
    echo ""
    echo "  在新的终端窗口打开已配置好环境的 'openclaw' 命令行..."
    open "$UCLAW_DIR/Mac-OpenClaw-CLI.command" 2>/dev/null || \
        echo -e "  ${YELLOW}无法自动打开新窗口，请手动双击 Mac-OpenClaw-CLI.command${NC}"
}

# Main loop
while true; do
    show_menu
    read -p "  请选择 [0-13]: " CHOICE
    echo ""

    case $CHOICE in
        1) do_config ;;
        2) do_dashboard ;;
        3) do_doctor ;;
        4) do_backup ;;
        5) do_restore ;;
        6) do_sysinfo ;;
        7) do_kill_gateway ;;
        8) do_logs ;;
        9) do_factory_reset ;;
        10) do_uninstall ;;
        11) do_update ;;
        12) do_cleanup ;;
        13) do_cli ;;
        0) echo -e "  ${CYAN}再见!${NC}"; exit 0 ;;
        *) echo -e "  ${RED}无效选择${NC}" ;;
    esac

    echo ""
    read -p "  按回车返回..."
done
