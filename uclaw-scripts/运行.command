#!/bin/bash
# ============================================================
# U-Claw 虾盘 - macOS 一键启动
# 双击此文件即可启动 OpenClaw
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="$UCLAW_DIR/openclaw"
PORTABLE_HOME="$UCLAW_DIR/portable-home"
PORTABLE_STATE_DIR="$PORTABLE_HOME/.openclaw"
PORTABLE_CONFIG_PATH="$PORTABLE_STATE_DIR/openclaw.json"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

run_with_spinner() {
    local message="$1"
    shift
    local tmp_log
    tmp_log="$(mktemp -t uclaw-run.XXXXXX)"
    "$@" >"$tmp_log" 2>&1 &
    local cmd_pid=$!
    local frames='|/-\'
    local i=0

    while kill -0 "$cmd_pid" 2>/dev/null; do
        local frame="${frames:i%4:1}"
        printf "\r  %b[%s]%b %s" "$CYAN" "$frame" "$NC" "$message"
        i=$((i + 1))
        sleep 0.2
    done

    wait "$cmd_pid"
    local status=$?
    printf "\r"

    if [ $status -ne 0 ]; then
        echo -e "  ${RED}启动步骤失败：${message}${NC}"
        sed -n '1,120p' "$tmp_log"
        rm -f "$tmp_log"
        read -p "  按回车键退出..."
        exit $status
    fi

    echo -e "  ${GREEN}完成${NC} ${message}"
    rm -f "$tmp_log"
}

clear
echo ""
echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║     U-Claw 虾盘 v1.0                ║"
echo "  ║     OpenClaw 一键启动                ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${GREEN}推荐场景：老电脑 / 临时电脑 / 不想改本机环境${NC}"
echo ""

# 检测 CPU 架构
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$UCLAW_DIR/runtime/node-mac-arm64"
    echo -e "  ${GREEN}检测到 Apple Silicon (M系列芯片)${NC}"
else
    NODE_DIR="$UCLAW_DIR/runtime/node-mac-x64"
    echo -e "  ${GREEN}检测到 Intel Mac${NC}"
fi

NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"

if [ ! -f "$NODE_BIN" ]; then
    echo -e "  ${RED}错误: 找不到 Node.js 运行环境${NC}"
    echo "  请确保 runtime/ 目录完整"
    echo ""
    read -p "  按回车键退出..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
echo -e "  Node.js 版本: ${GREEN}${NODE_VER}${NC}"
echo ""

export PATH="$NODE_DIR/bin:$PATH"
export OPENCLAW_HOME="$PORTABLE_HOME"
export OPENCLAW_STATE_DIR="$PORTABLE_STATE_DIR"
export OPENCLAW_CONFIG_PATH="$PORTABLE_CONFIG_PATH"

mkdir -p "$PORTABLE_STATE_DIR"

# 检查依赖
if [ ! -d "$OPENCLAW_DIR/node_modules" ]; then
    echo -e "  ${YELLOW}首次运行，正在安装依赖...${NC}"
    echo "  （使用淘宝镜像，请稍等）"
    echo ""
    cd "$OPENCLAW_DIR"
    run_with_spinner "安装 npm 依赖..." "$NODE_BIN" "$NPM_BIN" install --registry=https://registry.npmmirror.com
    echo ""
    echo -e "  ${GREEN}依赖安装完成!${NC}"
    echo ""
fi

# 检查构建
if [ ! -d "$OPENCLAW_DIR/dist" ]; then
    echo -e "  ${YELLOW}首次运行，正在构建...${NC}"
    cd "$OPENCLAW_DIR"
    run_with_spinner "构建 OpenClaw..." "$NODE_BIN" "$NPM_BIN" run build
    echo ""
fi

# 启动 OpenClaw
echo -e "  ${CYAN}正在启动 OpenClaw...${NC}"
echo ""
cd "$OPENCLAW_DIR"
if [ ! -f "$PORTABLE_CONFIG_PATH" ]; then
    echo -e "  ${YELLOW}检测到你还没有完成首次配置。${NC}"
    echo "  首次配置会直接保存到 U 盘里，换电脑插上后还能继续用。"
    echo ""
    read -p "  现在开始首次配置? (y/n) " -n 1 -r
    echo ""
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        "$NODE_BIN" openclaw.mjs onboard
        echo ""
        echo -e "  ${GREEN}首次配置完成，已保存到 U 盘。${NC}"
        echo "  下次插到别的电脑，也会继续使用这套配置。"
    else
        echo "  已跳过首次配置。"
    fi
else
    "$NODE_BIN" openclaw.mjs dashboard
fi

echo ""
echo -e "  ${YELLOW}OpenClaw 已退出。拔掉 U 盘后，本次便携运行就会结束。${NC}"
read -p "  按回车键关闭窗口..."
