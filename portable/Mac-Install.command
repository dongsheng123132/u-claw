#!/bin/bash
# Install the same portable structure locally; Mac-Start.command remains the
# single startup path for USB and local installs. Existing user data is kept.
set -e

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$UCLAW_DIR/app"
INSTALL_TARGET="$HOME/.uclaw"
NODE_VER="v24.16.0"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}🦞 U-Claw 安装到 Mac${NC}"
echo ""

ARCH=$(uname -m)
case "$ARCH" in
    arm64) NODE_PLATFORM="node-mac-arm64" ;;
    x86_64) NODE_PLATFORM="node-mac-x64" ;;
    *) echo -e "${RED}不支持的架构: $ARCH${NC}"; exit 1 ;;
esac

if [ "$UCLAW_DIR" = "$INSTALL_TARGET" ]; then
    echo "已经位于本机安装目录，请运行 start.command。"
    exit 0
fi
if [ -d "$INSTALL_TARGET" ]; then
    echo -e "${YELLOW}检测到已有安装: $INSTALL_TARGET${NC}"
    read -r -p "更新程序并保留现有数据？(y/n): " OVERWRITE
    case "$OVERWRITE" in y|Y) ;; *) echo "已取消"; exit 0 ;; esac
fi

USB_NODE="$APP_DIR/runtime/$NODE_PLATFORM/bin/node"
VERSION_FILE="$UCLAW_DIR/OPENCLAW_VERSION"
[ -f "$VERSION_FILE" ] || VERSION_FILE="$UCLAW_DIR/../OPENCLAW_VERSION"
REQUIRED_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
echo -e "${CYAN}准备 Node.js $NODE_VER 和 OpenClaw $REQUIRED_VERSION...${NC}"
bash "$UCLAW_DIR/setup.sh"
REQUIREMENTS="$("$USB_NODE" "$UCLAW_DIR/lib/runtime-requirements.mjs" "$UCLAW_DIR" 2>/dev/null)"
if [ "$REQUIREMENTS" != "UCLAW_SETUP_NEEDED=0" ]; then
    echo -e "${RED}Node.js 或 OpenClaw 版本不符合要求，安装中止。${NC}"
    exit 1
fi

# Save the previous program before replacing files. User data is never copied
# from this USB drive and never overwritten by installation.
mkdir -p "$INSTALL_TARGET/data/backups"
BACKUP_DIR="$INSTALL_TARGET/data/backups/program-$(date +%Y%m%d-%H%M%S)-$$"
if [ -d "$INSTALL_TARGET/app" ] || [ -f "$INSTALL_TARGET/Mac-Start.command" ] || [ -f "$INSTALL_TARGET/start.command" ]; then
    mkdir -p "$BACKUP_DIR"
    [ ! -d "$INSTALL_TARGET/app" ] || mv "$INSTALL_TARGET/app" "$BACKUP_DIR/app"
    [ ! -f "$INSTALL_TARGET/start.command" ] || cp "$INSTALL_TARGET/start.command" "$BACKUP_DIR/"
    for source in "$UCLAW_DIR"/*; do
        name="${source##*/}"
        case "$name" in app|data) continue ;; esac
        [ ! -e "$INSTALL_TARGET/$name" ] || cp -R "$INSTALL_TARGET/$name" "$BACKUP_DIR/"
    done
    echo "旧程序备份: $BACKUP_DIR"
fi

echo -e "${CYAN}复制程序到 $INSTALL_TARGET ...${NC}"
mkdir -p "$INSTALL_TARGET/app/runtime" "$INSTALL_TARGET/data/.openclaw"
cp -R "$APP_DIR/core" "$INSTALL_TARGET/app/core"
cp -R "$APP_DIR/runtime/$NODE_PLATFORM" "$INSTALL_TARGET/app/runtime/$NODE_PLATFORM"
for source in "$UCLAW_DIR"/*; do
    [ -e "$source" ] || continue
    name="${source##*/}"
    case "$name" in app|data) continue ;; esac
    cp -R "$source" "$INSTALL_TARGET/"
done

cat > "$INSTALL_TARGET/start.command" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$DIR/Mac-Start.command"
STARTEOF
chmod +x "$INSTALL_TARGET/"*.command "$INSTALL_TARGET/app/runtime/$NODE_PLATFORM/bin/node"

echo ""
echo -e "${GREEN}安装完成: $INSTALL_TARGET${NC}"
echo "双击 $INSTALL_TARGET/start.command 启动，在网页侧栏打开虾盘云钱包配置模型。"
read -r -p "按回车关闭..."
