#!/bin/bash
# ============================================================
# M-Claw 远程协助 v3（Mac/Linux）
# 用法: curl -fsSL https://u-claw.org/remote.sh | bash
# 改进: SSH 验证、同局域网直连、安全增强、自动超时
# ============================================================

set -e
GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'

clear
echo ""
echo -e "${CYAN}  ===========================================${NC}"
echo -e "${CYAN}  M-Claw 远程协助 v3${NC}"
echo -e "${CYAN}  ===========================================${NC}"
echo ""

# ---- 安全提示 ----
echo -e "${YELLOW}  ⚠ 本脚本将执行以下操作：${NC}"
echo -e "${DIM}    1. 开启 SSH 远程登录${NC}"
echo -e "${DIM}    2. 建立加密隧道到 M-Claw 中转服务器${NC}"
echo -e "${DIM}    3. 技术支持可通过 SSH 连接你的电脑${NC}"
echo -e "${DIM}    4. 关闭终端或 Ctrl+C 即可断开${NC}"
echo ""
echo -e -n "${YELLOW}  是否继续？(y/N): ${NC}"
read -r CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo -e "${RED}  已取消${NC}"
    exit 0
fi
echo ""

# ---- Step 1: SSH ----
echo -e "  [1/4] 检查 SSH ..."

check_ssh() {
    # macOS: netstat 检查; Linux: ss 或 netstat
    if netstat -an 2>/dev/null | grep -q '\.22 .*LISTEN'; then return 0; fi
    if ss -tlnp 2>/dev/null | grep -q ':22 '; then return 0; fi
    # 备用: 直接连自己
    if nc -z -w 2 127.0.0.1 22 2>/dev/null; then return 0; fi
    return 1
}

if [[ "$(uname)" == "Darwin" ]]; then
    # ---- macOS SSH 多种方式尝试 ----

    if ! check_ssh; then
        echo -e "${DIM}    尝试方式 1: systemsetup ...${NC}"
        sudo systemsetup -setremotelogin on 2>/dev/null || true
        sleep 1
    fi

    if ! check_ssh; then
        echo -e "${DIM}    尝试方式 2: launchctl load ...${NC}"
        sudo launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
        sleep 1
    fi

    if ! check_ssh; then
        echo -e "${DIM}    尝试方式 3: launchctl enable + kickstart ...${NC}"
        sudo launchctl enable system/com.openssh.sshd 2>/dev/null || true
        sudo launchctl kickstart -k system/com.openssh.sshd 2>/dev/null || true
        sleep 1
    fi

    # 确保密码认证开启（macOS Ventura+ 可能默认关闭）
    SSHD_CONFIG="/etc/ssh/sshd_config"
    if grep -q "^PasswordAuthentication no" "$SSHD_CONFIG" 2>/dev/null; then
        echo -e "${YELLOW}    检测到 SSH 密码登录被禁用，正在开启...${NC}"
        sudo sed -i '' 's/^PasswordAuthentication no/PasswordAuthentication yes/' "$SSHD_CONFIG"
        sudo launchctl kickstart -k system/com.openssh.sshd 2>/dev/null || true
        sleep 1
    fi
    # 同时检查 /etc/ssh/sshd_config.d/ 下的覆盖文件
    for f in /etc/ssh/sshd_config.d/*.conf; do
        if [ -f "$f" ] && grep -q "^PasswordAuthentication no" "$f" 2>/dev/null; then
            echo -e "${YELLOW}    修复 $f 中的密码认证设置...${NC}"
            sudo sed -i '' 's/^PasswordAuthentication no/PasswordAuthentication yes/' "$f"
        fi
    done

    # 如果还是不行，引导用户手动操作（不退出，等待重试）
    if ! check_ssh; then
        echo ""
        echo -e "${RED}  ╔══════════════════════════════════════════╗${NC}"
        echo -e "${RED}  ║  SSH 未能自动开启，需要你手动操作（30秒）║${NC}"
        echo -e "${RED}  ╚══════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${CYAN}  👉 操作步骤：${NC}"
        echo -e "${BOLD}     1. 点左上角  → 系统设置${NC}"
        echo -e "${BOLD}     2. 点「通用」→「共享」${NC}"
        echo -e "${BOLD}     3. 找到「远程登录」→ 打开开关${NC}"
        echo -e "${BOLD}     4. 回到这里按回车${NC}"
        echo ""
        echo -e -n "${YELLOW}  操作完成后按回车继续...${NC}"
        read -r

        # 再检查一次
        sleep 1
        if ! check_ssh; then
            echo -e "${RED}  [!] SSH 仍未启动，请确认「远程登录」已打开${NC}"
            echo -e -n "${YELLOW}  再试一次？按回车重新检测，输入 q 退出: ${NC}"
            read -r RETRY
            if [[ "$RETRY" == "q" ]]; then exit 1; fi
            sleep 1
            if ! check_ssh; then
                echo -e "${RED}  [!] SSH 确实无法启动，请联系技术支持排查${NC}"
                exit 1
            fi
        fi
    fi
else
    # ---- Linux ----
    sudo systemctl start sshd 2>/dev/null || sudo systemctl start ssh 2>/dev/null || {
        sudo apt-get install -y openssh-server 2>/dev/null || sudo yum install -y openssh-server 2>/dev/null
        sudo systemctl start sshd 2>/dev/null || sudo systemctl start ssh
    }
    if ! check_ssh; then
        echo -e "${RED}  [!] SSH 未能启动，请检查 sshd 服务${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}  [OK] SSH 已启动并在监听端口 22${NC}"

# ---- Step 2: 检测本地 IP（局域网直连用）----
echo ""
echo -e "  [2/4] 检测网络环境 ..."

LOCAL_IP=""
if [[ "$(uname)" == "Darwin" ]]; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")
else
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
fi

if [ -n "$LOCAL_IP" ]; then
    echo -e "${GREEN}  [OK] 本机局域网 IP: ${CYAN}${LOCAL_IP}${NC}"
else
    echo -e "${DIM}  未检测到局域网 IP${NC}"
fi

# ---- 检测代理/VPN（macOS）----
if [[ "$(uname)" == "Darwin" ]]; then
    PROXY_ON=false
    PROXY_APP=""
    # 检测系统代理
    if scutil --proxy 2>/dev/null | grep -q "HTTPEnable : 1"; then
        PROXY_ON=true
    fi
    # 检测 TUN 模式（utun 接口数量异常多说明有代理）
    if ifconfig 2>/dev/null | grep -q "utun[2-9]"; then
        PROXY_ON=true
    fi
    # 检测常见代理软件
    for app in Shadowrocket Surge Clash ClashX clash-meta V2rayU Quantumult sing-box; do
        if pgrep -fi "$app" >/dev/null 2>&1; then
            PROXY_APP="$app"
            PROXY_ON=true
            break
        fi
    done

    if $PROXY_ON; then
        echo ""
        echo -e "${RED}  ╔══════════════════════════════════════════╗${NC}"
        echo -e "${RED}  ║  检测到代理/VPN 正在运行！               ║${NC}"
        echo -e "${RED}  ╚══════════════════════════════════════════╝${NC}"
        if [ -n "$PROXY_APP" ]; then
            echo -e "${YELLOW}    检测到: ${BOLD}${PROXY_APP}${NC}"
        fi
        echo ""
        echo -e "${CYAN}  代理会拦截远程通道连接，导致连不上。${NC}"
        echo -e "${CYAN}  请暂时关闭代理软件，远程结束后再开。${NC}"
        echo ""
        echo -e "${BOLD}  👉 操作：${NC}"
        echo -e "${BOLD}     1. 在菜单栏找到代理图标，点击关闭/断开${NC}"
        echo -e "${BOLD}     2. 或直接退出代理软件${NC}"
        echo -e "${BOLD}     3. 回到这里按回车${NC}"
        echo ""
        echo -e -n "${YELLOW}  关闭代理后按回车继续...${NC}"
        read -r

        # 再次检测
        sleep 1
        if scutil --proxy 2>/dev/null | grep -q "HTTPEnable : 1"; then
            echo -e "${YELLOW}  ⚠ 代理可能还在运行，将尝试继续...${NC}"
        else
            echo -e "${GREEN}  [OK] 代理已关闭${NC}"
        fi
    fi
fi

# ---- Step 3: frpc ----
echo ""
echo -e "  [3/4] 准备远程通道 ..."

FRP_DIR="/tmp/uclaw-frp"
mkdir -p "$FRP_DIR"
FRPC="$FRP_DIR/frpc"

if [ ! -f "$FRPC" ]; then
    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    if [[ "$OS" == "darwin" ]]; then
        if [[ "$ARCH" == "arm64" ]]; then
            FRP_URL="https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_darwin_arm64.tar.gz"
        else
            FRP_URL="https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_darwin_amd64.tar.gz"
        fi
    else
        if [[ "$ARCH" == "aarch64" ]]; then
            FRP_URL="https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_arm64.tar.gz"
        else
            FRP_URL="https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_linux_amd64.tar.gz"
        fi
    fi

    echo -e "${DIM}    下载: $FRP_URL${NC}"
    curl -sL "https://ghfast.top/$FRP_URL" -o "$FRP_DIR/frp.tar.gz" 2>/dev/null || \
    curl -sL "$FRP_URL" -o "$FRP_DIR/frp.tar.gz"
    tar xzf "$FRP_DIR/frp.tar.gz" -C "$FRP_DIR" --strip-components=1
    rm -f "$FRP_DIR/frp.tar.gz"
fi

chmod +x "$FRPC"
echo -e "${GREEN}  [OK] 远程通道工具就绪${NC}"

# ---- Step 4: 连接 ----
echo ""
echo -e "  [4/4] 建立连接 ..."

# 更大的端口范围，减少冲突
PORT=$((20000 + RANDOM % 1000))
USERNAME=$(whoami)
HOSTNAME_VAL=$(hostname)

# 会话 ID（用于标识本次连接）
SESSION_ID=$(date +%s | tail -c 5)

cat > "$FRP_DIR/frpc.toml" << EOF
serverAddr = "101.32.254.221"
serverPort = 2222
auth.method = "token"
auth.token = "uclaw-remote-2026"

[[proxies]]
name = "ssh-${USERNAME}-${SESSION_ID}-${PORT}"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = ${PORT}
EOF

echo ""
echo -e "${GREEN}  ===========================================${NC}"
echo -e "${GREEN}  ✅ 远程协助已就绪！${NC}"
echo -e "${GREEN}  ===========================================${NC}"
echo ""
echo -e "${YELLOW}  +------------------------------------------+"
echo -e "  |  把下面这段发给技术支持（微信）：         |"
echo -e "  |                                          |"
printf "  |  ${CYAN}端口: %-36s${YELLOW}|\n" "$PORT"
printf "  |  ${CYAN}用户: %-36s${YELLOW}|\n" "$USERNAME"
printf "  |  ${CYAN}电脑: %-36s${YELLOW}|\n" "$HOSTNAME_VAL"
if [ -n "$LOCAL_IP" ]; then
printf "  |  ${CYAN}局域网: %-34s${YELLOW}|\n" "$LOCAL_IP"
fi
echo -e "  |                                          |"
echo -e "  +------------------------------------------+${NC}"
echo ""

# 局域网直连提示
if [ -n "$LOCAL_IP" ]; then
    echo -e "${CYAN}  💡 同一 WiFi 下可直连（更快）:${NC}"
    echo -e "${BOLD}     ssh ${USERNAME}@${LOCAL_IP}${NC}"
    echo ""
fi

echo -e "${DIM}  * 远程通道连接中，断线自动重连${NC}"
echo -e "${DIM}  * 按 Ctrl+C 或关闭终端即断开${NC}"
echo -e "${DIM}  * 连接将在 2 小时后自动断开${NC}"
echo ""

# 清理函数
cleanup() {
    echo ""
    echo -e "${YELLOW}  正在断开远程连接...${NC}"
    kill $FRPC_PID 2>/dev/null || true
    rm -f "$FRP_DIR/frpc.toml"
    echo -e "${GREEN}  已安全断开${NC}"
    exit 0
}
trap cleanup INT TERM

# 启动 frpc（后台运行，便于超时控制）
"$FRPC" -c "$FRP_DIR/frpc.toml" &
FRPC_PID=$!

# 2 小时超时自动断开
( sleep 7200 && kill $FRPC_PID 2>/dev/null && echo -e "\n${YELLOW}  ⏰ 已达 2 小时，自动断开${NC}" ) &
TIMEOUT_PID=$!

# 等待 frpc 退出
wait $FRPC_PID 2>/dev/null
kill $TIMEOUT_PID 2>/dev/null || true
rm -f "$FRP_DIR/frpc.toml"
