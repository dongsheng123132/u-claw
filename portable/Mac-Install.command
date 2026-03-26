#!/bin/bash
# ============================================================
# M-Claw - Install to Mac (从 U 盘安装到电脑)
# 优先使用 U 盘内的离线资源，缺失时从国内镜像下载
# ============================================================

set -e

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
INSTALL_TARGET="$HOME/.uclaw"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

NODE_VER="v22.14.0"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"

clear
echo ""
echo -e "${CYAN}${BOLD}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║   M-Claw 安装到 Mac                  ║"
echo "  ║   从 U 盘离线安装                     ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# ---- Check CPU ----
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    echo -e "  ${GREEN}Apple Silicon (M 系列) ✓${NC}"
    NODE_PLATFORM="node-mac-arm64"
else
    echo -e "  ${YELLOW}Intel Mac${NC}"
    NODE_PLATFORM="node-mac-x64"
fi
echo ""

# ---- Check existing installation ----
if [ -d "$INSTALL_TARGET" ]; then
    echo -e "  ${YELLOW}检测到已有安装: $INSTALL_TARGET${NC}"
    read -p "  覆盖安装？(y/n): " -n 1 OVERWRITE
    echo ""
    if [ "$OVERWRITE" != "y" ] && [ "$OVERWRITE" != "Y" ]; then
        echo -e "  ${DIM}已取消${NC}"
        exit 0
    fi
    echo ""
fi

# ---- Step 1: Check environment ----
echo -e "  ${BOLD}[1/4] 检查环境...${NC}"

NEED_DOWNLOAD_NODE=false
NEED_DOWNLOAD_OPENCLAW=false

# Check Node.js - prefer USB, then system, then download
USB_NODE="$APP_DIR/runtime/$NODE_PLATFORM/bin/node"
USB_NPM="$APP_DIR/runtime/$NODE_PLATFORM/bin/npm"

if [ -f "$USB_NODE" ]; then
    echo -e "  ${GREEN}Node.js: 使用 U 盘内的 ($("$USB_NODE" --version))${NC}"
    USE_NODE="usb"
elif command -v node >/dev/null 2>&1; then
    SYS_VER=$(node --version)
    MAJOR=$(echo "$SYS_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
        echo -e "  ${GREEN}Node.js: 使用系统的 ($SYS_VER)${NC}"
        USE_NODE="system"
    else
        echo -e "  ${YELLOW}Node.js: 系统版本太低 ($SYS_VER)，需要 v20+${NC}"
        NEED_DOWNLOAD_NODE=true
        USE_NODE="download"
    fi
else
    echo -e "  ${YELLOW}Node.js: 未安装${NC}"
    NEED_DOWNLOAD_NODE=true
    USE_NODE="download"
fi

# Check OpenClaw
USB_OPENCLAW="$APP_DIR/core/node_modules/openclaw/openclaw.mjs"
if [ -f "$USB_OPENCLAW" ]; then
    echo -e "  ${GREEN}OpenClaw: 使用 U 盘内的${NC}"
    USE_OPENCLAW="usb"
else
    echo -e "  ${YELLOW}OpenClaw: U 盘内未找到，需要在线下载${NC}"
    NEED_DOWNLOAD_OPENCLAW=true
    USE_OPENCLAW="download"
fi

echo ""

# ---- Step 2: Create install directory ----
echo -e "  ${BOLD}[2/4] 安装到 $INSTALL_TARGET ...${NC}"

mkdir -p "$INSTALL_TARGET"
mkdir -p "$INSTALL_TARGET/data/.openclaw"
mkdir -p "$INSTALL_TARGET/data/memory"
mkdir -p "$INSTALL_TARGET/data/backups"

# ---- Step 3: Copy/Download Node.js ----
echo -e "  ${BOLD}[3/4] 安装 Node.js...${NC}"

NODE_INSTALL_DIR="$INSTALL_TARGET/runtime/$NODE_PLATFORM"

case $USE_NODE in
    usb)
        echo -e "  ${CYAN}从 U 盘复制 Node.js...${NC}"
        mkdir -p "$NODE_INSTALL_DIR"
        cp -R "$APP_DIR/runtime/$NODE_PLATFORM/"* "$NODE_INSTALL_DIR/"
        chmod +x "$NODE_INSTALL_DIR/bin/node"
        INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
        INSTALL_NPM="$NODE_INSTALL_DIR/bin/npm"
        echo -e "  ${GREEN}Node.js 安装完成 ✓${NC}"
        ;;
    system)
        INSTALL_NODE="$(which node)"
        INSTALL_NPM="$(which npm)"
        echo -e "  ${GREEN}使用系统 Node.js ✓${NC}"
        ;;
    download)
        echo -e "  ${CYAN}从国内镜像下载 Node.js $NODE_VER...${NC}"
        PLATFORM_NAME="darwin-$ARCH"
        TARBALL="node-${NODE_VER}-${PLATFORM_NAME}.tar.gz"
        URL="${NODE_MIRROR}/${NODE_VER}/${TARBALL}"

        mkdir -p "$NODE_INSTALL_DIR"
        curl -# -L "$URL" -o "/tmp/$TARBALL"
        tar -xzf "/tmp/$TARBALL" -C "$NODE_INSTALL_DIR" --strip-components=1
        rm -f "/tmp/$TARBALL"
        chmod +x "$NODE_INSTALL_DIR/bin/node"
        INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
        INSTALL_NPM="$NODE_INSTALL_DIR/bin/npm"
        echo -e "  ${GREEN}Node.js 下载安装完成 ✓${NC}"
        ;;
esac

echo ""

# ---- Step 4: Copy/Download OpenClaw ----
echo -e "  ${BOLD}[4/4] 安装 OpenClaw...${NC}"

CORE_INSTALL_DIR="$INSTALL_TARGET/core"

case $USE_OPENCLAW in
    usb)
        echo -e "  ${CYAN}从 U 盘复制 OpenClaw + 插件...${NC}"
        mkdir -p "$CORE_INSTALL_DIR"
        cp -R "$APP_DIR/core/"* "$CORE_INSTALL_DIR/"
        echo -e "  ${GREEN}OpenClaw 安装完成 ✓${NC}"
        ;;
    download)
        echo -e "  ${CYAN}从国内镜像下载 OpenClaw...${NC}"
        mkdir -p "$CORE_INSTALL_DIR"
        cat > "$CORE_INSTALL_DIR/package.json" << 'PKGEOF'
{
  "name": "u-claw-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "openclaw": "latest"
  }
}
PKGEOF
        cd "$CORE_INSTALL_DIR"
        "$INSTALL_NODE" "$INSTALL_NPM" install --registry="$MIRROR" 2>&1 | tail -3
        "$INSTALL_NODE" "$INSTALL_NPM" install @sliverp/qqbot@latest --registry="$MIRROR" 2>&1 | tail -2
        echo -e "  ${GREEN}OpenClaw 下载安装完成 ✓${NC}"
        ;;
esac

# ---- Default config ----
CONFIG_PATH="$INSTALL_TARGET/data/.openclaw/openclaw.json"
if [ ! -f "$CONFIG_PATH" ]; then
    cat > "$CONFIG_PATH" << 'CFGEOF'
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  }
}
CFGEOF
fi

# ---- Copy launch scripts ----
for f in Config.html M-Claw.html; do
    [ -f "$UCLAW_DIR/$f" ] && cp "$UCLAW_DIR/$f" "$INSTALL_TARGET/"
done

# ---- Create launch script ----
cat > "$INSTALL_TARGET/start.command" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)
NODE_PLATFORM="node-mac-$( [ "$ARCH" = "arm64" ] && echo "arm64" || echo "x64" )"

NODE_BIN="$DIR/runtime/$NODE_PLATFORM/bin/node"
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node)"

CORE_DIR="$DIR/core"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"

export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$DIR/data/.openclaw/openclaw.json"

PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo "No available port" && exit 1
done

cd "$CORE_DIR"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
PID=$!

for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        open "http://127.0.0.1:$PORT/#token=uclaw"
        break
    fi
done

wait $PID
STARTEOF
chmod +x "$INSTALL_TARGET/start.command"

echo ""

# ---- Summary ----
INSTALL_SIZE=$(du -sh "$INSTALL_TARGET" | cut -f1)

echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════╗"
echo -e "  ║   ✅ 安装成功！                       ║"
echo -e "  ╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}安装位置:${NC} $INSTALL_TARGET"
echo -e "  ${BOLD}大小:${NC}     $INSTALL_SIZE"
echo ""
echo -e "  ${BOLD}启动方式:${NC}"
echo -e "    双击 ${CYAN}$INSTALL_TARGET/start.command${NC}"
echo -e "    或终端运行: ${CYAN}bash ~/.uclaw/start.command${NC}"
echo ""
echo -e "  ${BOLD}首次使用:${NC}"
echo -e "    启动后浏览器自动打开配置页面"
echo -e "    选择 AI 模型 → 填写 API Key → 开始用"
echo ""
read -p "  按回车关闭..."
