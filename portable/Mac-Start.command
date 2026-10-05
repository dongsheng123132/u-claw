#!/bin/bash
# ============================================================
# U-Claw - Portable AI Agent (macOS)
# Double-click to start / 双击启动
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
CORE_DIR="$APP_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
STATE_DIR="$DATA_DIR/.openclaw"
CONFIG_FILE="$STATE_DIR/openclaw.json"

# Migration shim: rename old core-mac to core for existing USB users
if [ -d "$APP_DIR/core-mac" ] && [ ! -d "$APP_DIR/core" ]; then
    mv "$APP_DIR/core-mac" "$APP_DIR/core"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🦞 U-Claw v2.1                  ║"
echo "  ║     Portable AI Agent               ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ---- 1. Detect CPU & set runtime ----
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-arm64"
    echo -e "  ${GREEN}Apple Silicon (M series)${NC}"
elif [ "$ARCH" = "x86_64" ]; then
    NODE_DIR="$APP_DIR/runtime/node-mac-x64"
    echo -e "  ${GREEN}Intel Mac (x64)${NC}"
else
    echo -e "  ${RED}Unsupported architecture: $ARCH${NC}"
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_BIN="$NODE_DIR/bin/node"
export PATH="$NODE_DIR/bin:$PATH"

# ---- 2. Remove macOS quarantine ----
if xattr -l "$NODE_BIN" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo -e "  ${YELLOW}Removing macOS security restriction...${NC}"
    xattr -rd com.apple.quarantine "$UCLAW_DIR" 2>/dev/null || true
    echo -e "  ${GREEN}Done${NC}"
fi

# ---- 2b. 启动日志收集（bug 证据自动留盘）----
# 把本次启动的全部输出同时写进 data/logs/startup-YYYYMMDD-HHMMSS.log，
# 网关异常退出时把尾部快照进 bug-report-*.log。保留最近 10 份，老的自动清。
# 用户反馈 bug 时：直接把这个文件发来即可，不用截图猜。
# 注意：必须在 runtime 检查/setup 自动调用之前开启，否则 setup 阶段的失败无日志可查。
mkdir -p "$DATA_DIR/logs"
START_LOG="$DATA_DIR/logs/startup-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$START_LOG") 2>&1
echo "U-Claw start $(date) | $(uname -s) $(uname -m) | OPENCLAW $(cat "$UCLAW_DIR/OPENCLAW_VERSION" 2>/dev/null)"
# 清理旧日志：只留最近 10 个 startup/bug 报告
ls -t "$DATA_DIR"/logs/startup-*.log "$DATA_DIR"/logs/bug-report-*.log 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null || true

# ---- 3. Check runtime ----
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${YELLOW}首次在这台 Mac 使用 / 运行时缺失，自动补齐（约 1-2 分钟）...${NC}"
    echo ""
    if bash "$UCLAW_DIR/setup.sh"; then
        echo ""
        if [ -f "$NODE_BIN" ]; then
            echo -e "  ${GREEN}✓ 环境就绪，继续启动${NC}"
        else
            echo -e "  ${RED}setup 完成但仍找不到 $NODE_BIN${NC}"
            echo "  可手动重试: bash setup.sh   或查看 data/logs/startup-*.log"
            read -p "  Press Enter to exit..."
            exit 1
        fi
    else
        echo -e "  ${RED}自动搭建失败（多半是网络问题）。${NC}"
        echo "  手动重试: bash setup.sh"
        echo "  完整日志: $START_LOG （反馈 bug 时请一并附上）"
        read -p "  Press Enter to exit..."
        exit 1
    fi
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js: ${GREEN}${NODE_VER}${NC}"
echo ""

# ---- 4. Init data directories ----
mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# ---- 4b. Strip host-machine provider credential variables (parity with Windows) ----
# If the Mac happens to have DASHSCOPE_API_KEY etc. exported, OpenClaw treats that
# provider as configured and tries to install its plugin during startup migration,
# which can fail on read-only/odd media and blocks gateway ready. Inheriting those
# vars would also silently spend the host owner's API credits.
_UCLAW_STRIP_ENV="$("$NODE_BIN" "$UCLAW_DIR/lib/strip-provider-env.mjs" 2>/dev/null | sed 's/^UCLAW_STRIP_ENV=//')"
if [ -n "$_UCLAW_STRIP_ENV" ]; then
    # strip-provider-env.mjs uses commas; bash only word-splits spaces by default.
    # shellcheck disable=SC2086
    for _v in ${_UCLAW_STRIP_ENV//,/ }; do
        unset "$_v" 2>/dev/null
    done
    echo -e "  ${YELLOW}Stripped host provider env vars:${NC} $_UCLAW_STRIP_ENV"
fi
unset _UCLAW_STRIP_ENV

# ---- 5. Default config ----
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -f "$DATA_DIR/config.json" ]; then
        echo -e "  ${YELLOW}Migrating legacy config...${NC}"
        cp "$DATA_DIR/config.json" "$CONFIG_FILE"
        echo -e "  ${GREEN}Config migrated${NC}"
    else
        echo -e "  ${YELLOW}First run - creating default config...${NC}"
        cat > "$CONFIG_FILE" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "update": {
    "checkOnStart": false,
    "auto": { "enabled": false }
  }
}
CFGEOF
        echo -e "  ${GREEN}Config created${NC}"
    fi
    echo ""
fi

# ---- 5b. 加速：把可重建的高 IO 数据放到本机硬盘 ----
# 会话、设备身份与授权状态全部留在 U 盘；只有打过补丁的受管 Chromium 目录在本机。
unset OPENCLAW_MANAGED_BROWSER_DIR
while IFS='=' read -r _k _v; do
    case "$_k" in
        UCLAW_COMPILE_CACHE_DIR) export NODE_COMPILE_CACHE="$_v" ;;
        UCLAW_CACHE_ROOT) UCLAW_CACHE_ROOT="$_v" ;;
        UCLAW_MANAGED_BROWSER_DIR) export OPENCLAW_MANAGED_BROWSER_DIR="$_v" ;;
    esac
done < <("$NODE_BIN" "$UCLAW_DIR/lib/portable-cache.mjs" "$STATE_DIR" "$UCLAW_DIR" 2>/dev/null)
[ -n "$NODE_COMPILE_CACHE" ] && echo -e "  ${GREEN}Cache on local disk:${NC} $UCLAW_CACHE_ROOT"

# ---- 5c. 单实例闸门（同一支 U 盘不能双击出两个 Gateway）----
# 锁跟随 U 盘 state（不是本机缓存）：复制 U 盘也不会错误复用另一支盘的实例。
INSTANCE_ROOT="$STATE_DIR"
INSTANCE_STATUS="unavailable"
INSTANCE_PORT=""
while IFS='=' read -r _k _v; do
    case "$_k" in
        UCLAW_INSTANCE_STATUS) INSTANCE_STATUS="$_v" ;;
        UCLAW_INSTANCE_PORT) INSTANCE_PORT="$_v" ;;
    esac
done < <("$NODE_BIN" "$UCLAW_DIR/lib/portable-instance-lock.mjs" acquire "$INSTANCE_ROOT" "$STATE_DIR" "$$" 2>/dev/null)

if [ "$INSTANCE_STATUS" = "existing" ] || [ "$INSTANCE_STATUS" = "busy" ]; then
    echo -e "  ${YELLOW}U-Claw is already running; reusing the existing instance.${NC}"
    if [ -n "$INSTANCE_PORT" ]; then
        open "http://127.0.0.1:$INSTANCE_PORT/#token=uclaw" 2>/dev/null || true
    else
        echo "  The existing instance is still starting. Please wait a moment."
    fi
    exit 0
fi

# ---- 6. Set environment (portable mode) ----
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
# U-Claw opens the local dashboard directly; disable mDNS/Bonjour discovery.
# On macOS the bonjour plugin auto-starts and advertises the gateway on the LAN
# (_openclaw-gw._tcp.local), which is unnecessary for local use and triggers
# "no IPv4 address available on utunN" warnings on machines with VPN/Tailscale.
export OPENCLAW_DISABLE_BONJOUR=1
# USB installs can't self-update (not a git checkout) and USB I/O makes an
# in-place update risky anyway; upgrades ship as a new USB image instead.
export OPENCLAW_NO_AUTO_UPDATE=1

# ---- 7. Check dependencies ----
if [ ! -d "$CORE_DIR/node_modules" ]; then
    echo -e "  ${YELLOW}[WARN] node_modules not found${NC}"
    echo "  This release should ship with deps pre-installed."
    echo "  Falling back to npm install (USB drives may take 20+ min)."
    echo "  TIP: re-download u-claw-portable-*.zip with bundled deps."
    cd "$CORE_DIR"
    # 把 npm 缓存留在盘内，避免污染系统 ~/.npm（拔盘不留痕）
    npm_config_cache="$APP_DIR/.npm-cache" \
    "$NODE_BIN" "$NODE_DIR/bin/npm" install --registry=https://registry.npmmirror.com --ignore-scripts --no-audit --no-fund --omit=dev 2>&1
    echo -e "  ${GREEN}Dependencies installed${NC}"
    echo ""
fi

# WeChat is unavailable in Config Center; skip unused plugin staging.

# ---- 7b. Async update check (non-blocking, 5s timeout, silent failure) ----
# Writes data/.openclaw/update-available.json if a newer version is on OSS.
# config-server serves this file via GET /api/update-status for the desktop shell.
# Version file lookup: portable/OPENCLAW_VERSION (USB) → ../OPENCLAW_VERSION (dev)
VERSION_FILE="$UCLAW_DIR/OPENCLAW_VERSION"
[ -f "$VERSION_FILE" ] || VERSION_FILE="$UCLAW_DIR/../OPENCLAW_VERSION"
if [ -f "$VERSION_FILE" ]; then
    "$NODE_BIN" "$UCLAW_DIR/lib/check-update.mjs" "$VERSION_FILE" "$STATE_DIR" >/dev/null 2>&1 &
fi

# ---- 7c. Intranet/self-hosted model fix ----
# Keep the configured model host(s) off any corporate HTTP_PROXY/HTTPS_PROXY.
# OpenClaw routes ALL fetch through the env proxy when it is set, which breaks
# calls to internal model endpoints (http://10.x / 192.168.x / a machine-room IP).
# Add those hosts + loopback to NO_PROXY so they connect directly.
# Silent no-op when no proxy/model is configured.
NO_PROXY_LINE="$("$NODE_BIN" "$UCLAW_DIR/lib/resolve-no-proxy.mjs" "$CONFIG_FILE" 2>/dev/null)"
case "$NO_PROXY_LINE" in
    UCLAW_NO_PROXY=*)
        export NO_PROXY="${NO_PROXY_LINE#UCLAW_NO_PROXY=}"
        export no_proxy="$NO_PROXY"
        echo "  Direct-connect (NO_PROXY): $NO_PROXY"
        ;;
esac

# ---- 8. Start Config Server in background, then poll for its actual port ----
# config-server can fall back off 18788 (busy machine, see server.js
# PORT_RANGE_PREFERRED/PORT_RANGE_FLOOR); its own runtime.json write is the only
# source of truth for which port it actually bound, so poll for that instead of
# assuming 18788 like pre-v2.2.1 did.
echo -e "  ${CYAN}Starting Config Center...${NC}"
CONFIG_SERVER="$UCLAW_DIR/config-server"
RUNTIME_JSON="$STATE_DIR/runtime.json"
rm -f "$RUNTIME_JSON" 2>/dev/null || true
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!

for i in $(seq 1 20); do
    if [ -f "$RUNTIME_JSON" ]; then
        break
    fi
    sleep 0.3
done
CONFIG_PORT=18788
while IFS='=' read -r _k _v; do
    case "$_k" in
        UCLAW_CONFIG_PORT) [ -n "$_v" ] && CONFIG_PORT="$_v" ;;
    esac
done < <("$NODE_BIN" "$UCLAW_DIR/lib/runtime-ports.mjs" read "$STATE_DIR" 2>/dev/null)
echo -e "  ${CYAN}Config Center port: $CONFIG_PORT${NC}"

# ---- 9. Find available gateway port after Config Center has bound its port ----
# lsof -sTCP:LISTEN restricts the probe to sockets actually listening on this
# machine (a plain "lsof -i :$PORT" also matches established connections that
# merely happen to use that local port, which is a false positive for "busy").
PORT=18789
while lsof -i :$PORT -sTCP:LISTEN >/dev/null 2>&1; do
    echo -e "  ${YELLOW}Port $PORT in use, trying next...${NC}"
    PORT=$((PORT + 1))
    if [ $PORT -gt 18799 ]; then
        echo -e "  ${RED}No available port (18789-18799)${NC}"
        read -p "  Press Enter to exit..."
        exit 1
    fi
done

# 端口确定后立刻发布给第二次点击的启动器；它会复用这个地址，不会再启动一份。
"$NODE_BIN" "$UCLAW_DIR/lib/portable-instance-lock.mjs" publish "$INSTANCE_ROOT" "$STATE_DIR" "$$" "$PORT" 2>/dev/null || true

# 单一真相源（v2.2.1）：config-server 不再把 gateway 端口猜成 configServerPort + 1，
# 而是读这里发布的值。见 lib/runtime-ports.mjs 顶部注释。
"$NODE_BIN" "$UCLAW_DIR/lib/runtime-ports.mjs" publish "$STATE_DIR" gateway "$PORT" 2>/dev/null || true

# ---- 10. Start gateway ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT...${NC}"
echo ""

# 清理上次崩溃 / 拔盘残留的 gateway 锁，避免 OpenClaw 报 "gateway already running"。
# 只删持有进程已不在的死锁；活动实例的锁不动。静默、非阻塞。
"$NODE_BIN" "$UCLAW_DIR/lib/clean-stale-lock.mjs" "$CONFIG_FILE" || true
"$NODE_BIN" "$UCLAW_DIR/lib/official-provider-guard.mjs" "$CONFIG_FILE" 2>/dev/null || true

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --port $PORT &
GW_PID=$!

# ---- 11. One startup tab; wait for readiness before first-run configuration ----
MODEL_CONFIGURED="$("$NODE_BIN" "$UCLAW_DIR/lib/check-model-configured.mjs" "$CONFIG_FILE" 2>/dev/null)"
CONFIGURED=0
[ "$MODEL_CONFIGURED" = "UCLAW_MODEL_CONFIGURED=1" ] && CONFIGURED=1
echo -e "  ${YELLOW}正在准备运行环境，首次从 U 盘启动可能需要几分钟...${NC}"
open "http://127.0.0.1:$CONFIG_PORT/startup?port=$PORT&token=uclaw&configured=$CONFIGURED" 2>/dev/null || true

# ---- 11b. gateway 首轮预热（后台、静默、非阻塞）----
# 就绪后先唤醒 config/model 子系统，用户首次点发送时不再等。移植自 4.0 first-turn-prewarm。
"$NODE_BIN" "$UCLAW_DIR/lib/prewarm.mjs" "$PORT" uclaw >/dev/null 2>&1 &

echo -e "  ${GREEN}════════════════════════════════${NC}"
echo -e "  ${GREEN}🦞 U-Claw is running!${NC}"
echo -e "  ${GREEN}   Dashboard:     http://127.0.0.1:$PORT/#token=uclaw${NC}"
echo -e "  ${GREEN}   Config Center: http://127.0.0.1:$CONFIG_PORT/${NC}"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop${NC}"
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo ""

# ---- Cleanup on exit ----
cleanup() {
    kill $GW_PID 2>/dev/null
    kill $CONFIG_PID 2>/dev/null
    "$NODE_BIN" "$UCLAW_DIR/lib/portable-instance-lock.mjs" release "$INSTANCE_ROOT" "$STATE_DIR" "$$" 2>/dev/null || true
    echo ""
    echo -e "  🦞 U-Claw stopped."
    exit 0
}
trap cleanup INT TERM

wait $GW_PID
GW_EXIT=$?

# Ctrl+C 走 trap cleanup（exit 0）不会到这；走到这里说明 gateway 自己退了。
if [ "$GW_EXIT" -ne 0 ]; then
    echo -e "  ${YELLOW}OpenClaw exited unexpectedly (code $GW_EXIT)${NC}"
    # ---- bug 证据自动留盘：网关异常退出 = 有 bug，把现场快照成一份报告 ----
    BUG_LOG="$DATA_DIR/logs/bug-report-$(date +%Y%m%d-%H%M%S).log"
    {
        echo "U-Claw Bug Report (auto-generated)"
        echo "时间: $(date)"
        echo "退出码: $GW_EXIT"
        echo "版本: OPENCLAW $(cat "$UCLAW_DIR/OPENCLAW_VERSION" 2>/dev/null) / macOS $(sw_vers -productVersion 2>/dev/null) $(uname -m)"
        echo ""
        echo "== 本次启动日志尾部（最后 100 行）=="
        tail -n 100 "$START_LOG" 2>/dev/null
        echo ""
        echo "== OpenClaw 自身日志尾部（若有）=="
        tail -n 50 "$HOME/Library/Caches/U-Claw"/*/openclaw*.log 2>/dev/null || true
    } > "$BUG_LOG" 2>&1
    chmod 644 "$BUG_LOG" 2>/dev/null
    echo -e "  ${CYAN}Bug 报告已自动保存: data/logs/$(basename "$BUG_LOG")${NC}"
    echo -e "  ${CYAN}反馈时把这个文件发给我们即可。${NC}"
fi
kill $CONFIG_PID 2>/dev/null
"$NODE_BIN" "$UCLAW_DIR/lib/portable-instance-lock.mjs" release "$INSTANCE_ROOT" "$STATE_DIR" "$$" 2>/dev/null || true
echo ""
echo -e "  🦞 U-Claw stopped."
