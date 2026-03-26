#!/bin/bash
# M-Claw Menu - Portable AI Agent
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
    echo -e "  ║   M-Claw 虾盘 v1.1                   ║"
    echo -e "  ║   Portable AI Agent                   ║"
    echo -e "  ╚══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Node: ${GREEN}${NODE_VER}${NC}  配置: ${CFG_STATUS}"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 配置 ──────────────────────────────${NC}"
    echo -e "  ${GREEN}[1]${NC}  配置向导（选模型、填 API Key）"
    echo -e "  ${GREEN}[2]${NC}  打开网页控制台"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 聊天平台 ──────────────────────────${NC}"
    echo -e "  ${GREEN}[3]${NC}  接入 QQ 机器人（推荐，1分钟搞定）"
    echo -e "  ${GREEN}[4]${NC}  接入其他平台（飞书/Telegram/微信）"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 维护 ──────────────────────────────${NC}"
    echo -e "  ${GREEN}[5]${NC}  诊断修复"
    echo -e "  ${GREEN}[6]${NC}  备份配置"
    echo -e "  ${GREEN}[7]${NC}  恢复备份"
    echo -e "  ${GREEN}[8]${NC}  系统信息"
    echo ""
    echo -e "  ${WHITE}${BOLD}── 高级维护 ──────────────────────────${NC}"
    echo -e "  ${GREEN}[9]${NC}  杀死残留进程"
    echo -e "  ${GREEN}[10]${NC} 查看日志"
    echo -e "  ${GREEN}[11]${NC} 恢复出厂设置"
    echo -e "  ${GREEN}[12]${NC} 卸载"
    echo -e "  ${GREEN}[13]${NC} 检查更新"
    echo -e "  ${GREEN}[14]${NC} 清理空间"
    echo -e "  ${GREEN}[15]${NC} 插件管理"
    echo -e "  ${GREEN}[16]${NC} 换 LLM / 重新配置"
    echo ""
    echo -e "  ${DIM}[0]  退出${NC}"
    echo ""
}

# [1] Config wizard
do_config() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 配置向导 ━━━${NC}"
    echo ""
    echo -e "  ${WHITE}国产模型选择提示:${NC}"
    echo ""
    echo -e "  DeepSeek  → 选 Custom Provider"
    echo -e "              URL: https://api.deepseek.com/v1"
    echo -e "              模型: deepseek-chat"
    echo -e "  Kimi      → 选 Moonshot AI"
    echo -e "  通义千问  → 选 Qwen"
    echo -e "  豆包      → 选 Volcano Engine"
    echo ""
    read -p "  按回车启动配置向导..."
    run_oc onboard
}

# [2] Web dashboard
do_dashboard() {
    echo ""
    echo -e "  ${CYAN}启动网页控制台...${NC}"
    echo ""
    cd "$CORE_DIR"

    # Find free port
    local PORT=18789
    while lsof -i :$PORT >/dev/null 2>&1; do
        PORT=$((PORT + 1))
        if [ $PORT -gt 18799 ]; then
            echo -e "  ${RED}端口 18789-18799 全被占用${NC}"
            return
        fi
    done

    local TOKEN=$(python3 -c "import json,os; p='$CONFIG_PATH'; d=json.load(open(p)) if os.path.exists(p) else {}; print(d.get('gateway',{}).get('auth',{}).get('token','uclaw'))" 2>/dev/null || echo "uclaw")

    "$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
    local PID=$!

    for i in $(seq 1 30); do
        sleep 0.5
        if curl --noproxy '*' -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
            local URL="http://127.0.0.1:$PORT/#token=$TOKEN"
            echo -e "  ${GREEN}控制台: $URL${NC}"
            open "$URL" 2>/dev/null
            break
        fi
    done

    echo "  关闭此窗口会停止服务"
    wait $PID
}

# [16] Reconfigure LLM (use the unified config-server wizard)
do_reconfig() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 换 LLM / 重新配置 ━━━${NC}"
    echo ""
    if command -v lsof >/dev/null 2>&1 && lsof -i:18788 >/dev/null 2>&1; then
        open "http://127.0.0.1:18788/config" 2>/dev/null || true
    else
        echo -e "  ${YELLOW}未发现 18788 配置中心服务${NC}"
        echo -e "  请先运行 ${GREEN}Mac-Start.command${NC}"
        read -p "  Press Enter to continue..."
    fi
}

# [3] QQ Bot (pre-installed)
do_qq() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 接入 QQ 机器人 ━━━${NC}"
    echo ""
    echo -e "  ${GREEN}QQ 插件已预装！只需输入 AppID 和 AppSecret。${NC}"
    echo ""
    echo "  获取方式: 访问 q.qq.com → 创建机器人"
    echo ""
    read -p "  AppID: " QQ_ID
    read -p "  AppSecret: " QQ_SECRET
    echo ""

    if [ -z "$QQ_ID" ] || [ -z "$QQ_SECRET" ]; then
        echo -e "  ${YELLOW}已取消${NC}"
        return
    fi

    run_oc channels add --channel qqbot --token "${QQ_ID}:${QQ_SECRET}" 2>&1 || true
    echo ""
    read -p "  你的 QQ 号（设白名单，留空跳过）: " QQ_ALLOW
    if [ -n "$QQ_ALLOW" ]; then
        run_oc config set channels.qqbot.allowFrom "\"${QQ_ALLOW}\"" 2>&1 || true
        echo -e "  ${GREEN}白名单已设置${NC}"
    fi
    echo ""
    echo -e "  ${GREEN}QQ 机器人配置完成！重启网关后生效。${NC}"
}

# [4] Other platforms
do_platforms() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 其他聊天平台 ━━━${NC}"
    echo ""
    echo -e "  ${GREEN}[a]${NC} 飞书 Feishu      — 企业首选"
    echo -e "  ${GREEN}[b]${NC} Telegram         — 海外推荐"
    echo -e "  ${GREEN}[c]${NC} 微信（社区插件） — iPad协议"
    echo -e "  ${GREEN}[d]${NC} Discord"
    echo ""
    read -p "  选择 (a-d): " -n 1 CH
    echo ""
    echo ""

    case $CH in
        a) echo "  飞书: 访问 open.feishu.cn/app 创建应用" ;;
        b) echo "  Telegram: 找 @BotFather 创建机器人" ;;
        c)
            echo -e "  ${YELLOW}安装微信插件...${NC}"
            run_oc plugins install @icesword760/openclaw-wechat 2>&1 || true
            ;;
        d) echo "  Discord: 访问 discord.com/developers/applications" ;;
        *) echo "  无效选择" ;;
    esac
    echo ""
    echo "  配置完成后运行配置向导 [1] 绑定平台"
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

# Main loop
while true; do
    show_menu
    read -p "  请选择 [0-16]: " CHOICE
    echo ""

    case $CHOICE in
        1) do_config ;;
        2) do_dashboard ;;
        3) do_qq ;;
        4) do_platforms ;;
        5) do_doctor ;;
        6) do_backup ;;
        7) do_restore ;;
        8) do_sysinfo ;;
        9) do_kill_gateway ;;
        10) do_logs ;;
        11) do_factory_reset ;;
        12) do_uninstall ;;
        13) do_update ;;
        14) do_cleanup ;;
        15) do_plugins ;;
        16) do_reconfig ;;
        0) echo -e "  ${CYAN}再见!${NC}"; exit 0 ;;
        *) echo -e "  ${RED}无效选择${NC}" ;;
    esac

    echo ""
    read -p "  按回车返回..."
done
