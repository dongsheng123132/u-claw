#!/bin/bash
# ============================================================
#  M-Claw — 重新配置 (macOS)
#  备份旧配置，删除后重新触发首次配置流程
# ============================================================
DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  🦞 M-Claw — 重新配置${NC}"
echo -e "  ════════════════════════════════"
echo ""

DATA_DIR="$DIR/data"
CONFIG_FILE="$DATA_DIR/.openclaw/openclaw.json"
BACKUP_DIR="$DATA_DIR/backups"

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "  ${YELLOW}没有找到配置文件，无需重置${NC}"
    echo -e "  直接运行「启动 M-Claw.command」即可进入配置"
    echo ""
    read -p "  按回车退出..."
    exit 0
fi

# Backup old config
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp "$CONFIG_FILE" "$BACKUP_DIR/openclaw_${TIMESTAMP}.json"
echo -e "  ${GREEN}✓${NC} 旧配置已备份: backups/openclaw_${TIMESTAMP}.json"

# Remove config to trigger first-run flow
rm "$CONFIG_FILE"
echo -e "  ${GREEN}✓${NC} 配置已清除"
echo ""
echo -e "  ${CYAN}请双击「启动 M-Claw.command」重新配置${NC}"
echo ""
read -p "  按回车退出..."
