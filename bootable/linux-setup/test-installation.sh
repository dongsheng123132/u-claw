#!/usr/bin/env bash
# ============================================================
#  M-Claw Installation Test Script
#  测试OpenClaw安装是否成功
# ============================================================

set -euo pipefail

echo "============================================"
echo "  M-Claw Installation Test"
echo "============================================"
echo ""

INSTALL_DIR="/opt/u-claw"
ERRORS=0
WARNINGS=0

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check() {
    local name="$1"
    local command="$2"
    local expected="$3"
    
    echo -n "✓ $name: "
    if eval "$command" 2>/dev/null; then
        echo -e "${GREEN}PASS${NC}"
        return 0
    else
        echo -e "${RED}FAIL${NC}"
        echo "  Expected: $expected"
        ((ERRORS++))
        return 1
    fi
}

warn() {
    local name="$1"
    local message="$2"
    
    echo -e "⚠ $name: ${YELLOW}$message${NC}"
    ((WARNINGS++))
}

echo "1. 检查基本目录结构..."
check "安装目录存在" "[ -d '$INSTALL_DIR' ]" "Directory $INSTALL_DIR"
check "runtime目录" "[ -d '$INSTALL_DIR/runtime' ]" "Runtime directory"
check "core目录" "[ -d '$INSTALL_DIR/core' ]" "Core directory"
check "data目录" "[ -d '$INSTALL_DIR/data' ]" "Data directory"

echo ""
echo "2. 检查Node.js安装..."
NODE_BIN="$INSTALL_DIR/runtime/node-linux-x64/bin/node"
if [ -x "$NODE_BIN" ]; then
    NODE_VERSION=$("$NODE_BIN" --version 2>/dev/null || echo "")
    echo -e "✓ Node.js版本: ${GREEN}$NODE_VERSION${NC}"
    
    if [ "$NODE_VERSION" != "v22.14.0" ]; then
        warn "Node.js版本" "Expected v22.14.0, found $NODE_VERSION"
    fi
else
    echo -e "${RED}✗ Node.js未找到或不可执行${NC}"
    ((ERRORS++))
fi

echo ""
echo "3. 检查OpenClaw安装..."
if [ -d "$INSTALL_DIR/core/node_modules/openclaw" ]; then
    echo -e "✓ OpenClaw已安装"
    
    # 检查主要文件
    OPENCLAW_ENTRY=$(find "$INSTALL_DIR/core/node_modules/openclaw" -name "openclaw.mjs" -maxdepth 2 2>/dev/null | head -1)
    if [ -n "$OPENCLAW_ENTRY" ]; then
        echo -e "✓ OpenClaw入口文件: ${GREEN}$OPENCLAW_ENTRY${NC}"
    else
        echo -e "${RED}✗ 未找到openclaw.mjs${NC}"
        ((ERRORS++))
    fi
else
    echo -e "${RED}✗ OpenClaw未安装${NC}"
    ((ERRORS++))
fi

echo ""
echo "4. 检查配置文件..."
CONFIG_FILE="$INSTALL_DIR/data/.openclaw/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
    echo -e "✓ 配置文件存在"
    
    # 检查配置格式
    if python3 -m json.tool "$CONFIG_FILE" >/dev/null 2>&1; then
        echo -e "✓ 配置文件格式正确"
    else
        warn "配置文件" "JSON格式可能有问题"
    fi
else
    echo -e "${YELLOW}⚠ 配置文件不存在（首次运行正常）${NC}"
    ((WARNINGS++))
fi

echo ""
echo "5. 检查启动脚本..."
START_SCRIPT="$INSTALL_DIR/start-openclaw.sh"
if [ -x "$START_SCRIPT" ]; then
    echo -e "✓ 启动脚本存在且可执行"
else
    if [ -f "$START_SCRIPT" ]; then
        echo -e "${YELLOW}⚠ 启动脚本存在但不可执行${NC}"
        chmod +x "$START_SCRIPT" 2>/dev/null && echo "  已添加执行权限"
    else
        echo -e "${RED}✗ 启动脚本未找到${NC}"
        ((ERRORS++))
    fi
fi

echo ""
echo "6. 检查端口可用性..."
PORT_FOUND=false
for port in $(seq 18789 18799); do
    if ! ss -tlnp 2>/dev/null | grep -q ":$port "; then
        echo -e "✓ 端口 $port 可用"
        PORT_FOUND=true
        break
    fi
done

if [ "$PORT_FOUND" = false ]; then
    warn "端口" "所有端口18789-18799都被占用"
fi

echo ""
echo "7. 检查桌面快捷方式..."
if [ -f "$HOME/Desktop/openclaw.desktop" ] || [ -f "$HOME/.local/share/applications/openclaw.desktop" ]; then
    echo -e "✓ 桌面快捷方式已创建"
else
    warn "桌面快捷方式" "未找到桌面快捷方式"
fi

echo ""
echo "============================================"
echo "  测试结果汇总"
echo "============================================"
echo ""

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ 所有关键检查通过！${NC}"
    echo "  安装看起来是成功的。"
    echo ""
    echo "  启动命令:"
    echo "    bash /opt/u-claw/start-openclaw.sh"
    echo ""
    echo "  或双击桌面上的 'M-Claw AI Assistant' 图标"
else
    echo -e "${RED}❌ 发现 $ERRORS 个错误${NC}"
    echo "  请检查上述失败的项目。"
    echo ""
    echo "  常见解决方案:"
    echo "  1. 重新运行安装脚本:"
    echo "     sudo bash /opt/u-claw/setup-openclaw.sh"
    echo "  2. 检查网络连接"
    echo "  3. 查看详细日志"
fi

if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠ 有 $WARNINGS 个警告${NC}"
    echo "  这些可能不会影响基本功能，但建议修复。"
fi

echo ""
echo "============================================"

# 提供快速修复选项
if [ $ERRORS -gt 0 ]; then
    echo ""
    read -rp "是否尝试自动修复问题？ (y/N): " FIX
    if [[ "$FIX" =~ ^[Yy]$ ]]; then
        echo ""
        echo "尝试修复..."
        
        # 修复启动脚本权限
        if [ -f "$START_SCRIPT" ] && [ ! -x "$START_SCRIPT" ]; then
            echo "  修复启动脚本权限..."
            sudo chmod +x "$START_SCRIPT"
        fi
        
        # 重新安装OpenClaw
        if [ ! -d "$INSTALL_DIR/core/node_modules/openclaw" ]; then
            echo "  重新安装OpenClaw..."
            cd "$INSTALL_DIR/core"
            sudo npm install --registry=https://registry.npmmirror.com openclaw@latest 2>/dev/null || true
        fi
        
        echo ""
        echo "修复完成。请重新运行此测试脚本。"
    fi
fi