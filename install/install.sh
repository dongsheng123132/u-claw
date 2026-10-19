#!/bin/bash
# ============================================================
# U-Claw 一键安装脚本 (Mac/Linux)
# 用法: curl -fsSL https://u-claw.org/install.sh | bash
#       或: bash install.sh
# ============================================================

set -e
set -o pipefail
# 注意：未启用 `set -u` —— 第 5 步交互式分支会有意把 API_KEY/BASE_URL/KEY_LABEL 等未赋值的变量
# 用 [-z "$X"] 检测后再写配置；启用 -u 会破坏这条降级路径。改用显式 `: "${VAR:=}"` 默认值过于侵入。

# ---- 颜色定义 ----
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ---- 常量 ----
UCLAW_DIR="$HOME/.uclaw"
RUNTIME_DIR="$UCLAW_DIR/runtime"
CORE_DIR="$UCLAW_DIR/core"
DATA_DIR="$UCLAW_DIR/data"
CONFIG_PATH="$DATA_DIR/.openclaw/openclaw.json"
NODE_VERSION="v24.16.0"
MIRROR="https://registry.npmmirror.com"
NODE_MIRROR="https://npmmirror.com/mirrors/node"

# ============================================================
# Step 1: Banner + 系统检测
# ============================================================
clear 2>/dev/null || true
echo ""
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'
  ╔══════════════════════════════════════════╗
  ║  🦞 U-Claw 一键安装                      ║
  ║  让 AI 助手一行命令装好                    ║
  ╚══════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# 系统检测
OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
        PLATFORM="darwin-arm64"
        NODE_DIR="node-mac-arm64"
        echo -e "  系统: ${GREEN}macOS Apple Silicon (M 系列) ✓${NC}"
    else
        PLATFORM="darwin-x64"
        NODE_DIR="node-mac-x64"
        echo -e "  系统: ${GREEN}macOS Intel ✓${NC}"
    fi
elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "x86_64" ]; then
        PLATFORM="linux-x64"
        NODE_DIR="node-linux-x64"
        echo -e "  系统: ${GREEN}Linux x64 ✓${NC}"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        PLATFORM="linux-arm64"
        NODE_DIR="node-linux-arm64"
        echo -e "  系统: ${GREEN}Linux ARM64 ✓${NC}"
    else
        echo -e "  ${RED}不支持的架构: $ARCH${NC}"
        exit 1
    fi
else
    echo -e "  ${RED}不支持的系统: $OS${NC}"
    echo -e "  ${YELLOW}Windows 请使用 PowerShell: irm https://u-claw.org/install.ps1 | iex${NC}"
    exit 1
fi

echo -e "  安装目录: ${CYAN}$UCLAW_DIR${NC}"
echo ""

# 检查已有安装
if [ -d "$UCLAW_DIR/core/node_modules/openclaw" ]; then
    echo -e "  ${YELLOW}检测到已有安装: $UCLAW_DIR${NC}"
    if [ -t 0 ]; then
        read -p "  覆盖安装？(y/n) [y]: " -n 1 OVERWRITE
        echo ""
        if [ "$OVERWRITE" = "n" ] || [ "$OVERWRITE" = "N" ]; then
            echo -e "  ${DIM}已取消${NC}"
            exit 0
        fi
    else
        echo -e "  ${CYAN}管道模式，自动覆盖安装${NC}"
    fi
    echo ""
fi

# 创建目录结构
mkdir -p "$RUNTIME_DIR" "$CORE_DIR" "$DATA_DIR/.openclaw" "$DATA_DIR/memory" "$DATA_DIR/backups"

# ============================================================
# Step 2: Node.js v22 安装
# ============================================================
echo -e "  ${BOLD}[1/6] 安装 Node.js $NODE_VERSION ...${NC}"

NODE_INSTALL_DIR="$RUNTIME_DIR/$NODE_DIR"
INSTALL_NODE=""
INSTALL_NPM=""

# 检查系统 Node.js
USE_SYSTEM_NODE=false
if command -v node >/dev/null 2>&1; then
    SYS_VER=$(node --version)
    MAJOR=$(echo "$SYS_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -ge 20 ] 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} 系统已有 Node.js $SYS_VER，复用"
        INSTALL_NODE="$(which node)"
        INSTALL_NPM="$(which npm)"
        USE_SYSTEM_NODE=true
    fi
fi

if [ "$USE_SYSTEM_NODE" = "false" ]; then
    if [ -f "$NODE_INSTALL_DIR/bin/node" ]; then
        echo -e "  ${GREEN}✓${NC} Node.js 已存在，跳过下载"
        INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
        INSTALL_NPM="$NODE_INSTALL_DIR/bin/npm-cli.js"
    else
        echo -e "  ${CYAN}↓${NC} 从国内镜像下载 Node.js $NODE_VERSION ($PLATFORM)..."
        TARBALL="node-${NODE_VERSION}-${PLATFORM}.tar.gz"
        URL="${NODE_MIRROR}/${NODE_VERSION}/${TARBALL}"

        mkdir -p "$NODE_INSTALL_DIR"
        if command -v curl >/dev/null 2>&1; then
            curl -# -L "$URL" -o "/tmp/$TARBALL"
        elif command -v wget >/dev/null 2>&1; then
            wget -q --show-progress "$URL" -O "/tmp/$TARBALL"
        else
            echo -e "  ${RED}✗ 未找到 curl 或 wget，请先安装${NC}"
            exit 1
        fi

        tar -xzf "/tmp/$TARBALL" -C "$NODE_INSTALL_DIR" --strip-components=1
        rm -f "/tmp/$TARBALL"
        chmod +x "$NODE_INSTALL_DIR/bin/node"

        if [ -f "$NODE_INSTALL_DIR/bin/node" ]; then
            echo -e "  ${GREEN}✓${NC} Node.js 安装完成"
            INSTALL_NODE="$NODE_INSTALL_DIR/bin/node"
            INSTALL_NPM="$NODE_INSTALL_DIR/lib/node_modules/npm/bin/npm-cli.js"
        else
            echo -e "  ${RED}✗ Node.js 下载失败${NC}"
            exit 1
        fi
    fi
fi

# Helper: invoke npm. For bundled Node we have npm-cli.js (run via node).
# For system Node, INSTALL_NPM is the npm shell wrapper (executable).
run_npm() {
    if [ "$USE_SYSTEM_NODE" = "true" ]; then
        "$INSTALL_NPM" "$@"
    else
        "$INSTALL_NODE" "$INSTALL_NPM" "$@"
    fi
}

echo ""

# ============================================================
# Step 3: OpenClaw 安装
# ============================================================
echo -e "  ${BOLD}[2/6] 安装 OpenClaw ...${NC}"

if [ -d "$CORE_DIR/node_modules/openclaw" ]; then
    echo -e "  ${GREEN}✓${NC} OpenClaw 已安装，跳过"
else
    if [ ! -f "$CORE_DIR/package.json" ]; then
        OPENCLAW_VERSION="2026.4.29"
        cat > "$CORE_DIR/package.json" << PKGJSON
{
  "name": "u-claw-core",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "openclaw": "$OPENCLAW_VERSION"
  }
}
PKGJSON
    fi

    echo -e "  ${CYAN}↓${NC} 从国内镜像安装..."
    NPM_LOG=$(mktemp /tmp/uclaw-npm.XXXXXX.log)
    if run_npm install --prefix "$CORE_DIR" --registry="$MIRROR" >"$NPM_LOG" 2>&1; then
        tail -5 "$NPM_LOG"
        rm -f "$NPM_LOG"
        echo -e "  ${GREEN}✓${NC} OpenClaw 安装完成"
    else
        echo -e "  ${RED}✗ OpenClaw 安装失败,完整日志见 $NPM_LOG${NC}"
        tail -20 "$NPM_LOG"
        exit 1
    fi
fi

echo ""

# ============================================================
# Step 4: QQ 插件（非致命）
# ============================================================
echo -e "  ${BOLD}[3/6] 安装 QQ 插件 ...${NC}"

if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}✓${NC} QQ 插件已安装，跳过"
else
    echo -e "  ${CYAN}↓${NC} 安装 QQ 插件..."
    run_npm install @sliverp/qqbot@latest --prefix "$CORE_DIR" --registry="$MIRROR" 2>/dev/null || {
        echo -e "  ${YELLOW}⚠${NC}  QQ 插件安装失败（不影响主功能）"
    }
    if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
        echo -e "  ${GREEN}✓${NC} QQ 插件安装完成"
    fi
fi

echo ""
# ============================================================
# Step 5: 交互式模型配置
# ============================================================
echo -e "  ${BOLD}[4/6] 配置 AI 模型 ...${NC}"
echo ""

# 如果已有配置且包含 apiKey，跳过
if [ -f "$CONFIG_PATH" ] && grep -q '"apiKey"' "$CONFIG_PATH" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} 已有模型配置，跳过"
else
    # 检测是否可交互
    if [ -t 0 ]; then
        echo -e "  请选择 AI 模型:"
        echo ""
        echo -e "  ${BOLD}── 国内推荐（无需翻墙）──${NC}"
        echo -e "  ${GREEN}1)${NC} DeepSeek      ⭐ 推荐，性价比最高"
        echo -e "  ${NC}2)${NC} Kimi/月之暗面"
        echo -e "  ${NC}3)${NC} 通义千问/阿里"
        echo -e "  ${NC}4)${NC} 智谱GLM"
        echo -e "  ${NC}5)${NC} MiniMax"
        echo -e "  ${NC}6)${NC} 豆包/火山引擎"
        echo -e "  ${NC}7)${NC} 硅基流动"
        echo ""
        echo -e "  ${BOLD}── 海外模型 ──${NC}"
        echo -e "  ${NC}8)${NC} Claude    ${NC}9)${NC} GPT"
        echo ""
        echo -e "  ${BOLD}── 本地 ──${NC}"
        echo -e "  ${NC}10)${NC} Ollama 本地模型"
        echo ""
        read -p "  请输入编号 [1]: " MODEL_CHOICE
        MODEL_CHOICE=${MODEL_CHOICE:-1}

        # 模型配置映射
        case $MODEL_CHOICE in
            1)
                MODEL_NAME="deepseek-v4-flash"
                BASE_URL="https://api.deepseek.com/v1"
                PROVIDER="custom"
                KEY_LABEL="DeepSeek API Key"
                KEY_HINT="获取地址: https://platform.deepseek.com/api_keys"
                NEED_KEY=true
                ;;
            2)
                MODEL_NAME="kimi-k2.6"
                BASE_URL="https://api.moonshot.cn/v1"
                PROVIDER="custom"
                KEY_LABEL="Moonshot API Key"
                KEY_HINT="获取地址: https://platform.moonshot.cn/console/api-keys"
                NEED_KEY=true
                ;;
            3)
                MODEL_NAME="qwen-plus"
                BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
                PROVIDER="custom"
                KEY_LABEL="通义千问 API Key"
                KEY_HINT="获取地址: https://dashscope.console.aliyun.com/apiKey（有免费额度）"
                NEED_KEY=true
                ;;
            4)
                MODEL_NAME="glm-5"
                BASE_URL="https://open.bigmodel.cn/api/paas/v4"
                PROVIDER="custom"
                KEY_LABEL="智谱 API Key"
                KEY_HINT="获取地址: https://open.bigmodel.cn/usercenter/apikeys"
                NEED_KEY=true
                ;;
            5)
                MODEL_NAME="MiniMax-M3"
                BASE_URL="https://api.minimaxi.com/v1"
                PROVIDER="custom"
                KEY_LABEL="MiniMax API Key"
                KEY_HINT="获取地址: https://platform.minimaxi.com/"
                NEED_KEY=true
                ;;
            6)
                MODEL_NAME="doubao-seed-1-6-250615"
                BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
                PROVIDER="custom"
                KEY_LABEL="火山引擎 API Key"
                KEY_HINT="获取地址: https://console.volcengine.com/ark"
                NEED_KEY=true
                ;;
            7)
                MODEL_NAME="deepseek-ai/DeepSeek-V3"
                BASE_URL="https://api.siliconflow.cn/v1"
                PROVIDER="custom"
                KEY_LABEL="硅基流动 API Key"
                KEY_HINT="获取地址: https://cloud.siliconflow.cn/account/ak"
                NEED_KEY=true
                ;;
            8)
                MODEL_NAME="claude-sonnet-5"
                BASE_URL=""
                PROVIDER="anthropic"
                KEY_LABEL="Anthropic API Key"
                KEY_HINT="获取地址: https://console.anthropic.com/settings/keys（需翻墙）"
                NEED_KEY=true
                ;;
            9)
                MODEL_NAME="gpt-5.4"
                BASE_URL=""
                PROVIDER="openai"
                KEY_LABEL="OpenAI API Key"
                KEY_HINT="获取地址: https://platform.openai.com/api-keys（需翻墙）"
                NEED_KEY=true
                ;;
            10)
                MODEL_NAME="llama3.2"
                BASE_URL="http://127.0.0.1:11434/v1"
                PROVIDER="custom"
                KEY_LABEL=""
                KEY_HINT="先安装 Ollama (https://ollama.com)，然后运行: ollama run llama3.2"
                NEED_KEY=false
                ;;
            *)
                echo -e "  ${YELLOW}未知选项，使用默认 DeepSeek${NC}"
                MODEL_NAME="deepseek-v4-flash"
                BASE_URL="https://api.deepseek.com/v1"
                PROVIDER="custom"
                KEY_LABEL="DeepSeek API Key"
                KEY_HINT="获取地址: https://platform.deepseek.com/api_keys"
                NEED_KEY=true
                ;;
        esac

        echo ""

        # 输入 API Key
        API_KEY=""
        if [ "$NEED_KEY" = "true" ]; then
            echo -e "  ${CYAN}$KEY_HINT${NC}"
            echo ""
            read -p "  请输入 $KEY_LABEL: " API_KEY
            if [ -z "$API_KEY" ]; then
                echo -e "  ${YELLOW}⚠ 未输入 API Key，稍后可编辑 $CONFIG_PATH 配置${NC}"
            fi
        else
            echo -e "  ${CYAN}$KEY_HINT${NC}"
        fi

        # 转义 API_KEY 中可能破坏 JSON 的字符 (反斜杠和双引号)。这里只处理这两个，
        # 因为合法的 API key 极少包含控制字符。如果用户粘贴了奇怪的内容,至少 JSON 仍然可解析。
        API_KEY_JSON=${API_KEY//\\/\\\\}
        API_KEY_JSON=${API_KEY_JSON//\"/\\\"}

        # 写配置文件
        if [ "$PROVIDER" = "custom" ] && [ -n "$BASE_URL" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "custom": {
        "baseUrl": "$BASE_URL",
        "apiKey": "$API_KEY_JSON",
        "api": "openai-completions",
        "models": [{ "id": "$MODEL_NAME" }]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "custom/$MODEL_NAME" } } }
}
CFGEOF
        elif [ "$PROVIDER" = "anthropic" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "anthropic": {
        "apiKey": "$API_KEY_JSON",
        "api": "anthropic",
        "models": [{ "id": "$MODEL_NAME" }]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "anthropic/$MODEL_NAME" } } }
}
CFGEOF
        elif [ "$PROVIDER" = "openai" ]; then
            cat > "$CONFIG_PATH" << CFGEOF
{
  "gateway": {
    "mode": "local",
    "auth": { "token": "uclaw" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "openai": {
        "apiKey": "$API_KEY_JSON",
        "api": "openai-completions",
        "models": [{ "id": "$MODEL_NAME" }]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "openai/$MODEL_NAME" } } }
}
CFGEOF
        fi

        echo -e "  ${GREEN}✓${NC} 模型配置完成: $MODEL_NAME"
    else
        # 非交互模式，写默认配置
        echo -e "  ${YELLOW}⚠${NC}  管道模式，跳过模型选择"
        echo -e "  ${DIM}稍后编辑 $CONFIG_PATH 配置模型${NC}"
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
    fi
fi

echo ""

# ============================================================
# Step 6: 生成启动脚本 + 验证 + 摘要
# ============================================================
echo -e "  ${BOLD}[5/6] 生成启动脚本 ...${NC}"

# Mac 启动脚本
cat > "$UCLAW_DIR/start.command" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)

# Find Node.js
if [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$DIR/runtime/node-mac-arm64/bin/node"
else
    NODE_BIN="$DIR/runtime/node-mac-x64/bin/node"
fi
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node 2>/dev/null)"

if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
    echo "错误: 未找到 Node.js"
    exit 1
fi

OPENCLAW_MJS="$DIR/core/node_modules/openclaw/openclaw.mjs"
if [ ! -f "$OPENCLAW_MJS" ]; then
    echo "错误: 未找到 OpenClaw"
    exit 1
fi

export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$DIR/data/.openclaw/openclaw.json"

# Find available port
PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo "没有可用端口 (18789-18799)" && exit 1
done

cd "$DIR/core"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
PID=$!

# Wait for gateway to start, then open browser
for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        open "http://127.0.0.1:$PORT/#token=uclaw" 2>/dev/null || true
        break
    fi
done

echo ""
echo "  🦞 U-Claw 正在运行: http://127.0.0.1:$PORT/#token=uclaw"
echo "  按 Ctrl+C 停止"
echo ""

wait $PID
STARTEOF
chmod +x "$UCLAW_DIR/start.command"

# Linux 启动脚本
if [ "$OS" = "Linux" ]; then
cat > "$UCLAW_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)

if [ "$ARCH" = "x86_64" ]; then
    NODE_BIN="$DIR/runtime/node-linux-x64/bin/node"
elif [ "$ARCH" = "aarch64" ]; then
    NODE_BIN="$DIR/runtime/node-linux-arm64/bin/node"
fi
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node 2>/dev/null)"

OPENCLAW_MJS="$DIR/core/node_modules/openclaw/openclaw.mjs"

export OPENCLAW_HOME="$DIR/data"
export OPENCLAW_STATE_DIR="$DIR/data/.openclaw"
export OPENCLAW_CONFIG_PATH="$DIR/data/.openclaw/openclaw.json"

PORT=18789
while ss -tln | grep -q ":$PORT "; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo "没有可用端口" && exit 1
done

cd "$DIR/core"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
PID=$!

sleep 2
echo ""
echo "  🦞 U-Claw 正在运行: http://127.0.0.1:$PORT/#token=uclaw"
echo "  按 Ctrl+C 停止"
echo ""

xdg-open "http://127.0.0.1:$PORT/#token=uclaw" 2>/dev/null || true
wait $PID
STARTEOF
chmod +x "$UCLAW_DIR/start.sh"
fi

echo -e "  ${GREEN}✓${NC} 启动脚本已生成"
echo ""

# ============================================================
# 验证
# ============================================================
echo -e "  ${BOLD}[6/6] 验证安装 ...${NC}"
echo ""

# Node.js
if [ -n "$INSTALL_NODE" ] && "$INSTALL_NODE" --version >/dev/null 2>&1; then
    NODE_VER_STR=$("$INSTALL_NODE" --version)
    echo -e "  ${GREEN}[✓]${NC} Node.js $NODE_VER_STR"
else
    echo -e "  ${RED}[✗]${NC} Node.js"
fi

# OpenClaw
if [ -f "$CORE_DIR/node_modules/openclaw/openclaw.mjs" ]; then
    echo -e "  ${GREEN}[✓]${NC} OpenClaw 已安装"
else
    echo -e "  ${RED}[✗]${NC} OpenClaw"
fi

# QQ 插件
if [ -d "$CORE_DIR/node_modules/@sliverp/qqbot" ]; then
    echo -e "  ${GREEN}[✓]${NC} QQ 插件"
else
    echo -e "  ${YELLOW}[⚠]${NC} QQ 插件（未安装，不影响主功能）"
fi


# 配置文件
if [ -f "$CONFIG_PATH" ]; then
    echo -e "  ${GREEN}[✓]${NC} 配置文件"
else
    echo -e "  ${YELLOW}[⚠]${NC} 配置文件（需启动后配置）"
fi

echo ""

# ============================================================
# 摘要
# ============================================================
INSTALL_SIZE=$(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)

echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   ✅ U-Claw 安装成功！                    ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}安装位置:${NC} $UCLAW_DIR"
echo -e "  ${BOLD}大小:${NC}     $INSTALL_SIZE"
echo ""
echo -e "  ${BOLD}启动方式:${NC}"
if [ "$OS" = "Darwin" ]; then
    echo -e "    双击 ${CYAN}~/.uclaw/start.command${NC}"
    echo -e "    或终端: ${CYAN}bash ~/.uclaw/start.command${NC}"
else
    echo -e "    终端: ${CYAN}bash ~/.uclaw/start.sh${NC}"
fi
echo ""
echo -e "  ${BOLD}打开后:${NC}"
echo -e "    浏览器自动打开 → 开始和 AI 对话"
echo ""
echo -e "  ${DIM}如需重新配置模型，编辑 ~/.uclaw/data/.openclaw/openclaw.json${NC}"
echo -e "  ${DIM}卸载: rm -rf ~/.uclaw${NC}"
echo ""
