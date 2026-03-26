#!/bin/bash
# ============================================================
# M-Claw 远程协助 (Mac/Linux)
# 用法: curl -fsSL https://u-claw.org/remote-help.sh | bash
# ============================================================

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

clear
echo ""
echo -e "${CYAN}  ============================================${NC}"
echo -e "${CYAN}  M-Claw 远程协助 - 一键开启${NC}"
echo -e "${CYAN}  技术支持将通过 SSH 帮你安装/调试${NC}"
echo -e "${CYAN}  ============================================${NC}"
echo ""

# ---- Step 1: 检查 SSH ----
echo -e "  [1/3] 检查 SSH 服务 ..."

if [[ "$(uname)" == "Darwin" ]]; then
    # macOS: 开启远程登录
    SSHD_STATUS=$(sudo systemsetup -getremotelogin 2>/dev/null | grep -i "on" || true)
    if [ -z "$SSHD_STATUS" ]; then
        echo -e "${YELLOW}  正在开启远程登录（需要输入密码）...${NC}"
        sudo systemsetup -setremotelogin on
    fi
    echo -e "${GREEN}  [OK] SSH 服务已启动${NC}"
else
    # Linux
    if command -v systemctl &>/dev/null; then
        if ! systemctl is-active --quiet sshd 2>/dev/null && ! systemctl is-active --quiet ssh 2>/dev/null; then
            echo -e "${YELLOW}  正在启动 SSH...${NC}"
            sudo systemctl start sshd 2>/dev/null || sudo systemctl start ssh 2>/dev/null || {
                echo -e "${YELLOW}  正在安装 OpenSSH...${NC}"
                sudo apt-get install -y openssh-server 2>/dev/null || sudo yum install -y openssh-server 2>/dev/null
                sudo systemctl start sshd 2>/dev/null || sudo systemctl start ssh
            }
        fi
    fi
    echo -e "${GREEN}  [OK] SSH 服务已启动${NC}"
fi

echo ""

# ---- Step 2: 防火墙 ----
echo -e "  [2/3] 配置防火墙 ..."
if [[ "$(uname)" == "Darwin" ]]; then
    echo -e "${GREEN}  [OK] macOS 无需额外配置${NC}"
else
    sudo ufw allow 22 2>/dev/null || true
    echo -e "${GREEN}  [OK] 防火墙已放行${NC}"
fi

echo ""

# ---- Step 3: 开启隧道 ----
echo -e "  [3/3] 开启远程通道 ..."

BORE_DIR="/tmp/uclaw-remote"
mkdir -p "$BORE_DIR"

ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

if [[ "$OS" == "darwin" ]]; then
    if [[ "$ARCH" == "arm64" ]]; then
        BORE_URL="https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-aarch64-apple-darwin.tar.gz"
    else
        BORE_URL="https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-apple-darwin.tar.gz"
    fi
else
    BORE_URL="https://github.com/ekzhang/bore/releases/download/v0.5.2/bore-v0.5.2-x86_64-unknown-linux-musl.tar.gz"
fi

BORE_EXE="$BORE_DIR/bore"

if [ ! -f "$BORE_EXE" ]; then
    echo -e "${YELLOW}  下载隧道工具...${NC}"
    curl -sL "$BORE_URL" | tar xz -C "$BORE_DIR"
fi

if [ ! -f "$BORE_EXE" ]; then
    echo -e "${RED}  [!] 下载失败，请检查网络（需要能访问 GitHub）${NC}"
    exit 1
fi

chmod +x "$BORE_EXE"

USERNAME=$(whoami)
HOSTNAME=$(hostname)

echo ""
echo -e "${GREEN}  ============================================${NC}"
echo -e "${GREEN}  远程协助已就绪！${NC}"
echo -e "${GREEN}  ============================================${NC}"
echo ""
echo -e "  你的用户名: ${CYAN}$USERNAME${NC}"
echo -e "  你的电脑名: ${CYAN}$HOSTNAME${NC}"
echo ""
echo -e "${YELLOW}  正在开启远程通道...${NC}"
echo -e "${YELLOW}  开启后，把下面显示的连接信息发给技术支持${NC}"
echo ""
echo -e "${CYAN}  ============================================${NC}"
echo -e "  提示: 按 Ctrl+C 即可断开远程连接"
echo -e "${CYAN}  ============================================${NC}"
echo ""

# 启动 bore 隧道
"$BORE_EXE" local 22 --to bore.pub
