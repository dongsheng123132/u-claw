#!/bin/bash
# ============================================================
# M-Claw Maintenance Functions (shared by Mac menus)
# Requires caller to set: $UCLAW_DIR, $DATA_DIR, $STATE_DIR,
#   $CONFIG_PATH, $NODE_BIN, $NPM_BIN, $CORE_DIR,
#   color vars ($RED $GREEN $YELLOW $CYAN $WHITE $NC $BOLD $DIM),
#   and run_oc() function.
# ============================================================

LOG_DIR="$DATA_DIR/logs"
BACKUP_DIR="$DATA_DIR/backups"
DEFAULT_CONFIG="$UCLAW_DIR/default-config.json"

# Detect install mode: installed (~/.uclaw), usb (/Volumes or /media), portable (other)
detect_install_mode() {
    if echo "$UCLAW_DIR" | grep -q "/.uclaw"; then
        echo "installed"
    elif echo "$UCLAW_DIR" | grep -qE "/Volumes/|/media/|/mnt/"; then
        echo "usb"
    else
        echo "portable"
    fi
}

# ── [9] Kill residual gateway processes ──────────────────────

do_kill_gateway() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 杀死残留进程 ━━━${NC}"
    echo ""

    local FOUND=0

    # Method 1: Check ports 18789-18799
    for PORT in $(seq 18789 18799); do
        local PIDS=""
        if command -v lsof >/dev/null 2>&1; then
            PIDS=$(lsof -ti :$PORT 2>/dev/null)
        elif command -v ss >/dev/null 2>&1; then
            PIDS=$(ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
        fi
        if [ -n "$PIDS" ]; then
            for PID in $PIDS; do
                local CMD=$(ps -p "$PID" -o comm= 2>/dev/null || echo "unknown")
                echo -e "  ${YELLOW}端口 $PORT: PID $PID ($CMD)${NC}"
                FOUND=1
            done
        fi
    done

    # Method 2: Check for openclaw.mjs processes
    local OC_PIDS=$(pgrep -f "openclaw.mjs gateway" 2>/dev/null)
    if [ -n "$OC_PIDS" ]; then
        for PID in $OC_PIDS; do
            echo -e "  ${YELLOW}OpenClaw 网关进程: PID $PID${NC}"
            FOUND=1
        done
    fi

    if [ "$FOUND" = "0" ]; then
        echo -e "  ${GREEN}没有发现残留进程${NC}"
        return
    fi

    echo ""
    read -p "  确认杀死以上进程? (y/N): " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo -e "  ${YELLOW}已取消${NC}"
        return
    fi

    # Kill port processes
    for PORT in $(seq 18789 18799); do
        if command -v lsof >/dev/null 2>&1; then
            lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null
        elif command -v ss >/dev/null 2>&1; then
            ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | xargs kill 2>/dev/null
        fi
    done

    # Kill openclaw.mjs processes
    pgrep -f "openclaw.mjs gateway" 2>/dev/null | xargs kill 2>/dev/null

    sleep 1
    echo -e "  ${GREEN}进程已清理${NC}"
}

# ── [10] View/export/clean logs ──────────────────────────────

do_logs() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 日志管理 ━━━${NC}"
    echo ""

    mkdir -p "$LOG_DIR"
    local LOG_FILE="$LOG_DIR/gateway.log"

    echo -e "  ${GREEN}[a]${NC}  查看最近日志（最后 50 行）"
    echo -e "  ${GREEN}[b]${NC}  导出日志到桌面"
    echo -e "  ${GREEN}[c]${NC}  清理 7 天前的旧日志"
    echo ""
    read -p "  选择 (a-c): " -n 1 LOG_CHOICE
    echo ""
    echo ""

    case $LOG_CHOICE in
        a)
            if [ -f "$LOG_FILE" ]; then
                echo -e "  ${DIM}── $LOG_FILE ──${NC}"
                echo ""
                tail -50 "$LOG_FILE"
            else
                echo -e "  ${YELLOW}日志文件不存在: $LOG_FILE${NC}"
                echo "  启动网关后会自动生成日志。"
            fi
            ;;
        b)
            if [ ! -f "$LOG_FILE" ]; then
                echo -e "  ${YELLOW}没有日志可导出${NC}"
                return
            fi
            local TS=$(date +%Y%m%d_%H%M%S)
            local EXPORT_DIR="$HOME/Desktop"
            [ ! -d "$EXPORT_DIR" ] && EXPORT_DIR="$HOME"
            local EXPORT_FILE="$EXPORT_DIR/uclaw-logs-$TS.txt"
            cp "$LOG_FILE" "$EXPORT_FILE"
            echo -e "  ${GREEN}日志已导出: $EXPORT_FILE${NC}"
            echo "  大小: $(du -sh "$EXPORT_FILE" | cut -f1)"
            ;;
        c)
            local COUNT=$(find "$LOG_DIR" -name "*.log" -mtime +7 2>/dev/null | wc -l | tr -d ' ')
            if [ "$COUNT" = "0" ]; then
                echo -e "  ${GREEN}没有需要清理的旧日志${NC}"
                return
            fi
            echo -e "  找到 ${YELLOW}$COUNT${NC} 个超过 7 天的日志文件"
            read -p "  确认清理? (y/N): " CONFIRM
            if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
                find "$LOG_DIR" -name "*.log" -mtime +7 -delete 2>/dev/null
                echo -e "  ${GREEN}旧日志已清理${NC}"
            else
                echo -e "  ${YELLOW}已取消${NC}"
            fi
            ;;
        *)
            echo -e "  ${RED}无效选择${NC}"
            ;;
    esac
}

# ── [11] Factory reset ───────────────────────────────────────

do_factory_reset() {
    echo ""
    echo -e "  ${RED}${BOLD}━━━ 恢复出厂设置 ━━━${NC}"
    echo ""
    echo -e "  ${RED}警告: 此操作将删除所有配置和记忆数据！${NC}"
    echo ""
    echo "  将执行以下操作:"
    echo "    1. 自动备份当前配置和记忆"
    echo "    2. 删除配置文件 (openclaw.json)"
    echo "    3. 删除记忆数据 (memory/)"
    echo "    4. 恢复默认配置"
    echo ""
    echo -e "  ${YELLOW}请输入 RESET 确认（区分大小写）:${NC}"
    read -p "  > " CONFIRM

    if [ "$CONFIRM" != "RESET" ]; then
        echo -e "  ${YELLOW}已取消${NC}"
        return
    fi

    # Step 1: Auto backup
    echo ""
    echo -e "  ${CYAN}[1/4] 自动备份...${NC}"
    local TS=$(date +%Y%m%d_%H%M%S)
    local BK="$BACKUP_DIR/pre-reset_$TS"
    mkdir -p "$BK"
    [ -f "$CONFIG_PATH" ] && cp "$CONFIG_PATH" "$BK/" 2>/dev/null
    [ -d "$DATA_DIR/memory" ] && cp -R "$DATA_DIR/memory" "$BK/" 2>/dev/null
    echo -e "  ${GREEN}备份已保存: $BK${NC}"

    # Step 2: Delete config
    echo -e "  ${CYAN}[2/4] 删除配置...${NC}"
    rm -f "$CONFIG_PATH" 2>/dev/null
    rm -f "$DATA_DIR/config.json" 2>/dev/null

    # Step 3: Delete memory
    echo -e "  ${CYAN}[3/4] 清理记忆数据...${NC}"
    rm -rf "$DATA_DIR/memory" 2>/dev/null
    mkdir -p "$DATA_DIR/memory"

    # Step 4: Restore default config
    echo -e "  ${CYAN}[4/4] 恢复默认配置...${NC}"
    mkdir -p "$STATE_DIR"
    if [ -f "$DEFAULT_CONFIG" ]; then
        cp "$DEFAULT_CONFIG" "$CONFIG_PATH"
    else
        cat > "$CONFIG_PATH" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  }
}
CFGEOF
    fi

    echo ""
    echo -e "  ${GREEN}出厂设置已恢复！${NC}"
    echo -e "  备份位置: $BK"
    echo -e "  请重新运行配置向导 [1] 设置模型。"
}

# ── [12] Uninstall ───────────────────────────────────────────

do_uninstall() {
    echo ""
    echo -e "  ${RED}${BOLD}━━━ 卸载 M-Claw ━━━${NC}"
    echo ""

    local MODE=$(detect_install_mode)

    case $MODE in
        installed)
            echo "  检测到: 已安装版本 (~/.uclaw/)"
            echo ""
            echo "  将删除以下目录:"
            echo -e "    ${YELLOW}$HOME/.uclaw/${NC}"
            if [ -d "$HOME/.uclaw" ]; then
                echo "    大小: $(du -sh "$HOME/.uclaw" 2>/dev/null | cut -f1)"
            fi
            echo ""
            echo -e "  ${RED}请输入 UNINSTALL 确认:${NC}"
            read -p "  > " CONFIRM
            if [ "$CONFIRM" != "UNINSTALL" ]; then
                echo -e "  ${YELLOW}已取消${NC}"
                return
            fi
            rm -rf "$HOME/.uclaw"
            echo -e "  ${GREEN}卸载完成！${NC}"
            ;;
        usb)
            echo "  检测到: U 盘模式"
            echo ""
            echo "  便携版不需要卸载 —— 只需:"
            echo "    1. 关闭所有 M-Claw 窗口"
            echo "    2. 安全弹出 U 盘"
            echo "    3. 如需清理电脑上的数据，删除 ~/.uclaw/ (如果存在)"
            echo ""
            if [ -d "$HOME/.uclaw" ]; then
                echo -e "  ${YELLOW}发现本机数据: ~/.uclaw/${NC}"
                echo "  大小: $(du -sh "$HOME/.uclaw" 2>/dev/null | cut -f1)"
                read -p "  是否删除本机数据? (y/N): " DEL
                if [ "$DEL" = "y" ] || [ "$DEL" = "Y" ]; then
                    rm -rf "$HOME/.uclaw"
                    echo -e "  ${GREEN}本机数据已清理${NC}"
                fi
            fi
            ;;
        portable)
            echo "  检测到: 便携版本"
            echo ""
            echo "  便携版不需要卸载 —— 直接删除文件夹即可:"
            echo -e "    ${YELLOW}$UCLAW_DIR${NC}"
            echo ""
            if [ -d "$HOME/.uclaw" ]; then
                echo -e "  ${YELLOW}发现本机数据: ~/.uclaw/${NC}"
                echo "  大小: $(du -sh "$HOME/.uclaw" 2>/dev/null | cut -f1)"
                read -p "  是否删除本机数据? (y/N): " DEL
                if [ "$DEL" = "y" ] || [ "$DEL" = "Y" ]; then
                    rm -rf "$HOME/.uclaw"
                    echo -e "  ${GREEN}本机数据已清理${NC}"
                fi
            fi
            echo ""
            echo "  Electron 桌面版卸载:"
            echo "    macOS: 将 M-Claw.app 从「应用程序」拖到废纸篓"
            ;;
    esac
}

# ── [13] Check for updates (P1) ─────────────────────────────

do_update() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 检查更新 ━━━${NC}"
    echo ""

    if [ ! -f "$NODE_BIN" ]; then
        echo -e "  ${RED}Node.js 未找到，无法检查更新${NC}"
        return
    fi

    echo -e "  ${DIM}正在查询最新版本...${NC}"

    # Get current version
    local CUR_VER=""
    if [ -f "$CORE_DIR/node_modules/openclaw/package.json" ]; then
        CUR_VER=$("$NODE_BIN" -e "console.log(require('$CORE_DIR/node_modules/openclaw/package.json').version)" 2>/dev/null)
    fi

    if [ -z "$CUR_VER" ]; then
        echo -e "  ${RED}无法读取当前版本（OpenClaw 可能未安装）${NC}"
        return
    fi

    # Get latest version from npmmirror
    local LATEST_VER=$(curl -s --connect-timeout 10 "https://registry.npmmirror.com/openclaw/latest" 2>/dev/null | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('error')}})" 2>/dev/null)

    if [ -z "$LATEST_VER" ] || [ "$LATEST_VER" = "error" ]; then
        echo -e "  ${YELLOW}无法获取最新版本（网络问题？）${NC}"
        echo "  当前版本: $CUR_VER"
        return
    fi

    echo "  当前版本: $CUR_VER"
    echo "  最新版本: $LATEST_VER"
    echo ""

    if [ "$CUR_VER" = "$LATEST_VER" ]; then
        echo -e "  ${GREEN}已是最新版本！${NC}"
        return
    fi

    echo -e "  ${YELLOW}有新版本可用！${NC}"
    read -p "  是否立即升级? (y/N): " DO_UPDATE
    if [ "$DO_UPDATE" != "y" ] && [ "$DO_UPDATE" != "Y" ]; then
        echo -e "  ${YELLOW}已取消${NC}"
        return
    fi

    echo ""
    echo -e "  ${CYAN}正在升级...${NC}"
    cd "$CORE_DIR"
    "$NPM_BIN" install openclaw@latest --registry=https://registry.npmmirror.com 2>&1
    local NEW_VER=$("$NODE_BIN" -e "console.log(require('./node_modules/openclaw/package.json').version)" 2>/dev/null)
    echo ""
    echo -e "  ${GREEN}升级完成！${NC} $CUR_VER → $NEW_VER"
}

# ── [14] Disk cleanup (P1) ───────────────────────────────────

do_cleanup() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 清理空间 ━━━${NC}"
    echo ""

    # Show directory sizes
    echo -e "  ${WHITE}目录占用:${NC}"
    [ -d "$CORE_DIR/node_modules" ] && echo "    node_modules: $(du -sh "$CORE_DIR/node_modules" 2>/dev/null | cut -f1)"
    [ -d "$DATA_DIR/memory" ] && echo "    memory:       $(du -sh "$DATA_DIR/memory" 2>/dev/null | cut -f1)"
    [ -d "$BACKUP_DIR" ] && echo "    backups:      $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
    [ -d "$LOG_DIR" ] && echo "    logs:         $(du -sh "$LOG_DIR" 2>/dev/null | cut -f1)"
    echo "    总计:         $(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)"
    echo ""

    local CLEANED=0

    # Clean old backups (keep latest 3)
    if [ -d "$BACKUP_DIR" ]; then
        local BK_COUNT=$(ls -d "$BACKUP_DIR"/*/ 2>/dev/null | wc -l | tr -d ' ')
        if [ "$BK_COUNT" -gt 3 ]; then
            local OLD_COUNT=$((BK_COUNT - 3))
            echo -e "  ${YELLOW}发现 $BK_COUNT 个备份，保留最新 3 个，删除 $OLD_COUNT 个旧备份${NC}"
            read -p "  确认? (y/N): " DEL_BK
            if [ "$DEL_BK" = "y" ] || [ "$DEL_BK" = "Y" ]; then
                ls -dt "$BACKUP_DIR"/*/ 2>/dev/null | tail -n "$OLD_COUNT" | while read -r DIR; do
                    rm -rf "$DIR"
                done
                echo -e "  ${GREEN}旧备份已清理${NC}"
                CLEANED=1
            fi
        else
            echo "  备份: ${BK_COUNT} 个（无需清理）"
        fi
    fi

    # Clean old logs (>7 days)
    if [ -d "$LOG_DIR" ]; then
        local OLD_LOGS=$(find "$LOG_DIR" -name "*.log" -mtime +7 2>/dev/null | wc -l | tr -d ' ')
        if [ "$OLD_LOGS" -gt 0 ]; then
            echo -e "  ${YELLOW}发现 $OLD_LOGS 个超过 7 天的日志${NC}"
            read -p "  确认清理? (y/N): " DEL_LOG
            if [ "$DEL_LOG" = "y" ] || [ "$DEL_LOG" = "Y" ]; then
                find "$LOG_DIR" -name "*.log" -mtime +7 -delete 2>/dev/null
                echo -e "  ${GREEN}旧日志已清理${NC}"
                CLEANED=1
            fi
        else
            echo "  日志: 无需清理"
        fi
    fi

    # Clean npm cache
    echo ""
    read -p "  是否清理 npm 缓存? (y/N): " DEL_CACHE
    if [ "$DEL_CACHE" = "y" ] || [ "$DEL_CACHE" = "Y" ]; then
        "$NPM_BIN" cache clean --force 2>/dev/null
        echo -e "  ${GREEN}npm 缓存已清理${NC}"
        CLEANED=1
    fi

    if [ "$CLEANED" = "0" ]; then
        echo ""
        echo -e "  ${GREEN}没有需要清理的内容${NC}"
    else
        echo ""
        echo "  清理后总计: $(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)"
    fi
}

# ── [15] Plugin management (P1) ─────────────────────────────

do_plugins() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 插件管理 ━━━${NC}"
    echo ""
    echo -e "  ${GREEN}[a]${NC}  列出已安装插件"
    echo -e "  ${GREEN}[b]${NC}  安装插件"
    echo -e "  ${GREEN}[c]${NC}  卸载插件"
    echo ""
    read -p "  选择 (a-c): " -n 1 PLG_CHOICE
    echo ""
    echo ""

    case $PLG_CHOICE in
        a)
            echo -e "  ${WHITE}已安装插件:${NC}"
            echo ""
            run_oc plugins list 2>&1 || echo -e "  ${YELLOW}无法获取插件列表${NC}"
            ;;
        b)
            echo "  常用插件:"
            echo "    @icesword760/openclaw-wechat  — 微信"
            echo "    @nicepkg/openclaw-plugin-qq    — QQ（社区版）"
            echo ""
            read -p "  输入插件名称（留空取消）: " PLG_NAME
            if [ -z "$PLG_NAME" ]; then
                echo -e "  ${YELLOW}已取消${NC}"
                return
            fi
            echo ""
            echo -e "  ${CYAN}正在安装 $PLG_NAME ...${NC}"
            run_oc plugins install "$PLG_NAME" 2>&1
            echo ""
            echo -e "  ${GREEN}安装完成${NC}"
            ;;
        c)
            echo -e "  ${WHITE}已安装插件:${NC}"
            echo ""
            run_oc plugins list 2>&1 || true
            echo ""
            read -p "  输入要卸载的插件名称（留空取消）: " PLG_NAME
            if [ -z "$PLG_NAME" ]; then
                echo -e "  ${YELLOW}已取消${NC}"
                return
            fi
            echo ""
            echo -e "  ${CYAN}正在卸载 $PLG_NAME ...${NC}"
            run_oc plugins remove "$PLG_NAME" 2>&1
            echo ""
            echo -e "  ${GREEN}卸载完成${NC}"
            ;;
        *)
            echo -e "  ${RED}无效选择${NC}"
            ;;
    esac
}
