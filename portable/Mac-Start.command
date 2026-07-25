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
echo "  ║     🦞 U-Claw v1.1                  ║"
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

# ---- 3. Check runtime ----
if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}Error: Node.js runtime not found${NC}"
    echo "  Please run: bash setup.sh"
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js: ${GREEN}${NODE_VER}${NC}"
echo ""

# ---- 4. Init data directories ----
mkdir -p "$STATE_DIR" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# ---- 4b. 加速：把"重 IO、可重建"的缓存从 U 盘搬到本机硬盘 ----
# portable-cache.mjs 算出本机缓存目录(~/Library/Caches/U-Claw/slot，UUID 隔离，
# 换盘符仍复用)，并把 .openclaw/browser 做成 symlink 指向本机盘。
# 浏览器 user-data(几百 MB 随机小写)和 V8 编译缓存因此落本机盘，不再拖慢 U 盘。
# 静默失败：取不到就跳过，缓存留 U 盘，照常启动。
while IFS='=' read -r _k _v; do
    case "$_k" in
        UCLAW_COMPILE_CACHE_DIR) export NODE_COMPILE_CACHE="$_v" ;;
        UCLAW_CACHE_ROOT) UCLAW_CACHE_ROOT="$_v" ;;
    esac
done < <("$NODE_BIN" "$UCLAW_DIR/lib/portable-cache.mjs" "$STATE_DIR" "$UCLAW_DIR" 2>/dev/null)
[ -n "$NODE_COMPILE_CACHE" ] && echo -e "  ${GREEN}Cache on local disk:${NC} $UCLAW_CACHE_ROOT"

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
  }
}
CFGEOF
        echo -e "  ${GREEN}Config created${NC}"
    fi
    echo ""
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

# ---- 7a. Pre-stage WeChat plugin (parity with Windows) ----
# OpenClaw 从 OPENCLAW_STATE_DIR/extensions 单一目录加载扩展（无 ~/.openclaw 兜底），
# 而我们把 STATE_DIR 指向 U 盘，所以插件必须放到 $STATE_DIR/extensions 才会被加载。
WECHAT_PLUGIN_SRC="$APP_DIR/extensions/openclaw-weixin"
WECHAT_PLUGIN_DST="$STATE_DIR/extensions/openclaw-weixin"
if [ -f "$WECHAT_PLUGIN_SRC/openclaw.plugin.json" ] && [ ! -f "$WECHAT_PLUGIN_DST/openclaw.plugin.json" ]; then
    echo -e "  ${CYAN}Installing WeChat plugin...${NC}"
    mkdir -p "$STATE_DIR/extensions"
    cp -R "$WECHAT_PLUGIN_SRC" "$WECHAT_PLUGIN_DST" 2>/dev/null \
        && echo -e "  ${GREEN}WeChat plugin installed${NC}"
fi
# 确保插件能解析到 'zod'：npm 包不带 zod，且宿主 node_modules 不在插件的解析路径上，
# 否则插件以 "Cannot find module 'zod'" 加载失败。从内置 OpenClaw core 复制 zod 过去。
# 每次启动都跑，已经装好但缺 zod 的旧盘会自愈。
if [ -f "$WECHAT_PLUGIN_DST/openclaw.plugin.json" ] && [ ! -d "$WECHAT_PLUGIN_DST/node_modules/zod" ] && [ -d "$CORE_DIR/node_modules/zod" ]; then
    echo -e "  ${CYAN}Repairing WeChat plugin dependency (zod)...${NC}"
    mkdir -p "$WECHAT_PLUGIN_DST/node_modules"
    cp -R "$CORE_DIR/node_modules/zod" "$WECHAT_PLUGIN_DST/node_modules/zod" 2>/dev/null
fi

# ---- 7b. Async update check (non-blocking, 5s timeout, silent failure) ----
# Writes data/.openclaw/update-available.json if a newer version is on OSS.
# Welcome.html / Config.html read this file and show a banner.
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

# ---- 8. Find available port ----
PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    echo -e "  ${YELLOW}Port $PORT in use, trying next...${NC}"
    PORT=$((PORT + 1))
    if [ $PORT -gt 18799 ]; then
        echo -e "  ${RED}No available port (18789-18799)${NC}"
        read -p "  Press Enter to exit..."
        exit 1
    fi
done

# ---- 9. Start Config Server in background ----
echo -e "  ${CYAN}Starting Config Center on port 18788...${NC}"
CONFIG_SERVER="$UCLAW_DIR/config-server"
"$NODE_BIN" "$CONFIG_SERVER/server.js" &
CONFIG_PID=$!
sleep 1

# ---- 10. Start gateway ----
echo -e "  ${CYAN}Starting OpenClaw on port $PORT...${NC}"
echo ""

# 清理上次崩溃 / 拔盘残留的 gateway 锁，避免 OpenClaw 报 "gateway already running"。
# 只删持有进程已不在的死锁；活动实例的锁不动。静默、非阻塞。
"$NODE_BIN" "$UCLAW_DIR/lib/clean-stale-lock.mjs" "$CONFIG_FILE" || true

cd "$CORE_DIR"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
GW_PID=$!

# ---- 11. 立刻打开"启动首屏"，给用户即时反馈（移植自 4.0 splash）----
# 首屏 loading.html 自己轮询 /ready，就绪后停在选择页，不再自动冲进 Dashboard。
echo -e "  ${YELLOW}首次启动需准备运行环境，约 30-90 秒，请稍候...${NC}"
# 用 file:// URL 确保 query string（?port=）能传给浏览器；裸路径 open 会把整串当文件名。
open "file://$UCLAW_DIR/lib/loading.html?port=$PORT&token=uclaw" 2>/dev/null || true
# 每次都打开 Config Center，方便改模型、充值/获取 Key、连接微信等渠道。
open "http://127.0.0.1:18788/" 2>/dev/null || true

# ---- 11b. gateway 首轮预热（后台、静默、非阻塞）----
# 就绪后先唤醒 config/model 子系统，用户首次点发送时不再等。移植自 4.0 first-turn-prewarm。
"$NODE_BIN" "$UCLAW_DIR/lib/prewarm.mjs" "$PORT" uclaw >/dev/null 2>&1 &

# ---- 11c. 兜底：万一首屏页的 file:// fetch 被浏览器拦，仍静默轮询端口 ----
# 慢盘首启可达 90s+，轮询上限覆盖这段。最多 ~3 分钟（180×1s）。
(
    for i in $(seq 1 180); do
        if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
            exit 0
        fi
        sleep 1
    done
) &

echo -e "  ${GREEN}════════════════════════════════${NC}"
echo -e "  ${GREEN}🦞 U-Claw is running!${NC}"
echo -e "  ${GREEN}   Dashboard:     http://127.0.0.1:$PORT/#token=uclaw${NC}"
echo -e "  ${GREEN}   Config Center: http://127.0.0.1:18788/${NC}"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop${NC}"
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo ""

# ---- Cleanup on exit ----
cleanup() {
    kill $GW_PID 2>/dev/null
    kill $CONFIG_PID 2>/dev/null
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
fi
kill $CONFIG_PID 2>/dev/null
echo ""
echo -e "  🦞 U-Claw stopped."
