#!/bin/bash
# ============================================================
# U-Claw 虾盘 - 启动菜单 (雨林木风风格)
# macOS 版本
# ============================================================

UCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_DIR="$UCLAW_DIR/openclaw"
PORTABLE_HOME="$UCLAW_DIR/portable-home"
PORTABLE_STATE_DIR="$PORTABLE_HOME/.openclaw"
PORTABLE_CONFIG_PATH="$PORTABLE_STATE_DIR/openclaw.json"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
GRAY='\033[0;37m'
NC='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'

# 检测架构并设置 Node
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_DIR="$UCLAW_DIR/runtime/node-mac-arm64"
else
    NODE_DIR="$UCLAW_DIR/runtime/node-mac-x64"
fi
NODE_BIN="$NODE_DIR/bin/node"
NPM_BIN="$NODE_DIR/bin/npm"
export PATH="$NODE_DIR/bin:$PATH"
export OPENCLAW_HOME="$PORTABLE_HOME"
export OPENCLAW_STATE_DIR="$PORTABLE_STATE_DIR"
export OPENCLAW_CONFIG_PATH="$PORTABLE_CONFIG_PATH"

mkdir -p "$PORTABLE_STATE_DIR"

# 检查安装状态
check_status() {
    HAS_MODULES="no"
    HAS_DIST="no"
    HAS_ENV="no"
    INSTALLED="no"
    PORTABLE_READY="no"

    [ -d "$OPENCLAW_DIR/node_modules" ] && HAS_MODULES="yes"
    [ -d "$OPENCLAW_DIR/dist" ] && HAS_DIST="yes"
    [ -f "$OPENCLAW_DIR/.env" ] && HAS_ENV="yes"
    [ -d "$HOME/.uclaw/openclaw" ] && INSTALLED="yes"
    [ -f "$PORTABLE_CONFIG_PATH" ] && PORTABLE_READY="yes"
}

# 显示主菜单
show_menu() {
    check_status
    clear
    echo ""
    echo -e "${CYAN}${BOLD}"
    echo "  ╔════════════════════════════════════════════════════════╗"
    echo "  ║                                                        ║"
    echo "  ║          🦞  U-Claw 虾盘 v1.0                         ║"
    echo "  ║          OpenClaw AI 助手 一键安装盘                    ║"
    echo "  ║                                                        ║"
    echo "  ║          专为中国用户优化 · 免翻墙 · 离线安装           ║"
    echo "  ║                                                        ║"
    echo "  ╠════════════════════════════════════════════════════════╣"
    echo -e "  ║${NC}                                                        ${CYAN}║"

    # 状态栏
    local STATUS_NODE="${GREEN}v$($NODE_BIN --version 2>/dev/null || echo '未找到')${NC}"
    local STATUS_MOD="${RED}未安装${NC}"
    local STATUS_BUILD="${RED}未构建${NC}"
    local STATUS_INST="${RED}未安装${NC}"

    [ "$HAS_MODULES" = "yes" ] && STATUS_MOD="${GREEN}已安装${NC}"
    [ "$HAS_DIST" = "yes" ] && STATUS_BUILD="${GREEN}已构建${NC}"
    [ "$INSTALLED" = "yes" ] && STATUS_INST="${GREEN}已安装${NC}"

    local STATUS_PORTABLE="${RED}未配置${NC}"
    [ "$PORTABLE_READY" = "yes" ] && STATUS_PORTABLE="${GREEN}已配置${NC}"
    echo -e "  ${CYAN}║${NC}  系统: $(uname -m)                                      ${CYAN}║${NC}"
    echo -e "  ${CYAN}║${NC}  Node: $STATUS_NODE                                     ${CYAN}║${NC}"
    echo -e "  ${CYAN}║${NC}  依赖: $STATUS_MOD   构建: $STATUS_BUILD                      ${CYAN}║${NC}"
    echo -e "  ${CYAN}║${NC}  便携配置: $STATUS_PORTABLE   电脑安装: $STATUS_INST                ${CYAN}║${NC}"
    echo -e "  ${CYAN}║${NC}                                                        ${CYAN}║${NC}"
    echo -e "  ${CYAN}╠════════════════════════════════════════════════════════╣${NC}"
    echo ""
    echo -e "  ${WHITE}${BOLD}  ━━━━ 安装 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GREEN}  [1]${NC}  🚀 安装 OpenClaw 到本机（仅限你自己的电脑）"
    echo -e "  ${GREEN}  [2]${NC}  📦 仅安装依赖（npm install）"
    echo -e "  ${GREEN}  [3]${NC}  🔨 仅构建项目（npm build）"
    echo -e "  ${GREEN}  [4]${NC}  ▶️  直接从 U 盘运行（配置也保存在 U 盘里）"
    echo ""
    echo -e "  ${WHITE}${BOLD}  ━━━━ 中国优化 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${YELLOW}  [5]${NC}  🇨🇳 配置国产 AI 模型（DeepSeek/Kimi/通义千问）"
    echo -e "  ${YELLOW}  [6]${NC}  💬 配置中国聊天平台（飞书/钉钉）"
    echo -e "  ${YELLOW}  [7]${NC}  🪞 设置国内镜像源"
    echo ""
    echo -e "  ${WHITE}${BOLD}  ━━━━ 维护工具 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${CYAN}  [8]${NC}  🔧 诊断修复（openclaw doctor）"
    echo -e "  ${CYAN}  [9]${NC}  💾 备份当前状态"
    echo -e "  ${CYAN}  [10]${NC} 📂 恢复备份"
    echo -e "  ${CYAN}  [11]${NC} 🔄 重置 OpenClaw（恢复出厂）"
    echo -e "  ${CYAN}  [12]${NC} 🧹 清理缓存和临时文件"
    echo ""
    echo -e "  ${WHITE}${BOLD}  ━━━━ 技能 & 使用 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${BLUE}  [13]${NC} 🎯 浏览预装技能（52个，已离线可用）"
    echo -e "  ${BLUE}  [14]${NC} 📖 中国用户快速上手指南"
    echo ""
    echo -e "  ${WHITE}${BOLD}  ━━━━ 其他 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${MAGENTA}  [15]${NC} 📋 查看使用说明"
    echo -e "  ${MAGENTA}  [16]${NC} ℹ️  系统信息"
    echo -e "  ${MAGENTA}  [17]${NC} 🌐 打开本地网页控制台"
    echo -e "  ${DIM}  [0]${NC}  退出"
    echo ""
    echo -e "  ${CYAN}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 确保依赖已安装
ensure_deps() {
    if [ ! -d "$OPENCLAW_DIR/node_modules" ]; then
        echo -e "  ${YELLOW}正在安装依赖（淘宝镜像）...${NC}"
        cd "$OPENCLAW_DIR"
        "$NODE_BIN" "$NPM_BIN" install --registry=https://registry.npmmirror.com 2>&1
        echo -e "  ${GREEN}依赖安装完成${NC}"
    fi
    if [ ! -d "$OPENCLAW_DIR/dist" ]; then
        echo -e "  ${YELLOW}正在构建...${NC}"
        cd "$OPENCLAW_DIR"
        "$NODE_BIN" "$NPM_BIN" run build 2>&1 || true
        echo -e "  ${GREEN}构建完成${NC}"
    fi
}

# [1] 一键安装到电脑
do_install() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 一键安装 OpenClaw 到电脑 ━━━${NC}"
    echo ""
    echo -e "  ${YELLOW}提醒：如果这是老电脑、临时电脑、公司电脑或别人的电脑，${NC}"
    echo -e "  ${YELLOW}更推荐返回主菜单选择 [4] 从 U 盘运行，不要安装到本机。${NC}"
    echo ""
    bash "$UCLAW_DIR/安装到电脑.command"
}

# [2] 安装依赖
do_npm_install() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 安装 npm 依赖 ━━━${NC}"
    echo ""
    cd "$OPENCLAW_DIR"
    echo -e "  ${YELLOW}使用淘宝镜像安装...${NC}"
    "$NODE_BIN" "$NPM_BIN" install --registry=https://registry.npmmirror.com 2>&1
    echo ""
    echo -e "  ${GREEN}依赖安装完成!${NC}"
}

# [3] 构建
do_build() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 构建 OpenClaw ━━━${NC}"
    echo ""
    ensure_deps
    cd "$OPENCLAW_DIR"
    "$NODE_BIN" "$NPM_BIN" run build 2>&1
    echo ""
    echo -e "  ${GREEN}构建完成!${NC}"
}

# [4] 直接运行
do_run() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 从 U 盘启动 OpenClaw ━━━${NC}"
    echo ""
    echo -e "  ${GREEN}便携模式说明：配置、状态、记忆都会写在这只 U 盘里。${NC}"
    echo -e "  ${GREEN}拔掉 U 盘后当前会话会结束，但换一台电脑再插上还能继续用。${NC}"
    echo ""
    ensure_deps
    cd "$OPENCLAW_DIR"
    if [ ! -f "$PORTABLE_CONFIG_PATH" ]; then
        echo -e "  ${YELLOW}检测到你还没有完成首次配置。${NC}"
        echo "  首次配置会保存在 U 盘中，不会默认写进这台电脑。"
        echo ""
        read -p "  现在开始首次配置? (y/n) " -n 1 -r
        echo ""
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            "$NODE_BIN" openclaw.mjs onboard
            echo ""
            echo -e "  ${GREEN}首次配置完成，已保存到 U 盘。${NC}"
            echo "  接下来可以选 [17] 打开网页控制台。"
        fi
    else
        "$NODE_BIN" openclaw.mjs dashboard
    fi
}

do_dashboard() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 打开本地网页控制台 ━━━${NC}"
    echo ""
    ensure_deps
    cd "$OPENCLAW_DIR"
    if [ ! -f "$PORTABLE_CONFIG_PATH" ]; then
        echo -e "  ${YELLOW}你还没有完成 U 盘便携配置。请先选 [4] 从 U 盘运行。${NC}"
        return
    fi
    "$NODE_BIN" openclaw.mjs dashboard
}

# [5] 配置国产模型
do_china_models() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 配置国产 AI 模型 ━━━${NC}"
    echo ""
    echo -e "  OpenClaw 已内置以下国产模型支持:"
    echo ""
    echo -e "  ${GREEN}[a]${NC} DeepSeek（深度求索）    — 性价比最高，推荐首选"
    echo -e "  ${GREEN}[b]${NC} Kimi / 月之暗面         — 256K 超长上下文"
    echo -e "  ${GREEN}[c]${NC} 通义千问 Qwen           — 阿里云，免费额度大"
    echo -e "  ${GREEN}[d]${NC} 智谱 GLM                — 清华系，学术场景强"
    echo -e "  ${GREEN}[e]${NC} MiniMax                  — 语音和多模态"
    echo -e "  ${GREEN}[f]${NC} 豆包 Doubao（字节跳动）  — 火山引擎平台"
    echo -e "  ${GREEN}[g]${NC} 百度千帆                  — 百度智能云"
    echo -e "  ${GREEN}[h]${NC} 小米 Mimo                — 小米 AI"
    echo ""
    echo -e "  ${YELLOW}请选择要配置的模型 (a-h):${NC} "
    read -n 1 MODEL_CHOICE
    echo ""
    echo ""

    ENV_FILE="$OPENCLAW_DIR/.env"
    touch "$ENV_FILE"

    case $MODEL_CHOICE in
        a)
            echo -e "  ${CYAN}配置 DeepSeek${NC}"
            echo "  获取 API Key: https://platform.deepseek.com/"
            echo ""
            read -p "  请输入 DeepSeek API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                grep -v "OPENAI_API_KEY\|OPENAI_BASE_URL" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                echo "OPENAI_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo "OPENAI_BASE_URL=https://api.deepseek.com/v1" >> "$ENV_FILE"
                echo -e "  ${GREEN}DeepSeek 已配置!${NC}"
            fi
            ;;
        b)
            echo -e "  ${CYAN}配置 Kimi (月之暗面)${NC}"
            echo "  获取 API Key: https://platform.moonshot.cn/"
            echo ""
            read -p "  请输入 Moonshot API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                grep -v "OPENAI_API_KEY\|OPENAI_BASE_URL" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                echo "OPENAI_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo "OPENAI_BASE_URL=https://api.moonshot.cn/v1" >> "$ENV_FILE"
                echo -e "  ${GREEN}Kimi 已配置!${NC}"
            fi
            ;;
        c)
            echo -e "  ${CYAN}配置通义千问 Qwen${NC}"
            echo "  获取 API Key: https://dashscope.console.aliyun.com/"
            echo ""
            read -p "  请输入 Qwen API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                grep -v "ZAI_API_KEY" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                echo "ZAI_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}通义千问已配置!${NC}"
            fi
            ;;
        d)
            echo -e "  ${CYAN}配置智谱 GLM${NC}"
            echo "  获取 API Key: https://open.bigmodel.cn/"
            echo "  注意: 通过火山引擎(Volcano Engine)接入"
            echo ""
            read -p "  请输入 API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                echo "# 智谱GLM (via Volcano Engine)" >> "$ENV_FILE"
                echo "VOLCENGINE_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}智谱 GLM 已配置!${NC}"
            fi
            ;;
        e)
            echo -e "  ${CYAN}配置 MiniMax${NC}"
            echo "  获取 API Key: https://platform.minimaxi.com/"
            echo ""
            read -p "  请输入 MiniMax API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                grep -v "MINIMAX_API_KEY" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                echo "MINIMAX_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}MiniMax 已配置!${NC}"
            fi
            ;;
        f)
            echo -e "  ${CYAN}配置豆包 Doubao (字节跳动)${NC}"
            echo "  获取 API Key: https://console.volcengine.com/ark"
            echo ""
            read -p "  请输入火山引擎 API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                grep -v "VOLCENGINE_API_KEY" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
                mv "$ENV_FILE.tmp" "$ENV_FILE"
                echo "VOLCENGINE_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}豆包已配置!${NC}"
            fi
            ;;
        g)
            echo -e "  ${CYAN}配置百度千帆${NC}"
            echo "  获取 API Key: https://console.bce.baidu.com/qianfan/"
            echo ""
            read -p "  请输入千帆 API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                echo "QIANFAN_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}百度千帆已配置!${NC}"
            fi
            ;;
        h)
            echo -e "  ${CYAN}配置小米 Mimo${NC}"
            echo "  获取 API Key: https://dev.mi.com/mimo"
            echo ""
            read -p "  请输入 Mimo API Key: " API_KEY
            if [ -n "$API_KEY" ]; then
                echo "MIMO_API_KEY=$API_KEY" >> "$ENV_FILE"
                echo -e "  ${GREEN}小米 Mimo 已配置!${NC}"
            fi
            ;;
        *)
            echo -e "  ${YELLOW}无效选择${NC}"
            ;;
    esac
}

# [6] 配置中国聊天平台
do_china_channels() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 配置中国聊天平台 ━━━${NC}"
    echo ""
    echo -e "  OpenClaw 支持的聊天平台:"
    echo ""
    echo -e "  ${WHITE}${BOLD}  -- 国内平台 --${NC}"
    echo -e "  ${GREEN}[a]${NC} 飞书 Feishu/Lark       — 已内置，企业首选"
    echo -e "  ${GREEN}[b]${NC} QQ（腾讯官方）${RED}★推荐${NC}   — 3条命令，1分钟，免费免翻墙"
    echo -e "  ${GREEN}[c]${NC} 微信（社区插件）         — iPad协议，文字/图片/文件"
    echo -e "  ${GRAY}[d]${NC} 企业微信 WeCom          — 后续集成"
    echo -e "  ${GRAY}[e]${NC} 钉钉 DingTalk           — 后续集成"
    echo ""
    echo -e "  ${WHITE}${BOLD}  -- 国际平台 --${NC}"
    echo -e "  ${GREEN}[f]${NC} Telegram                — 推荐，简单好用"
    echo -e "  ${GREEN}[g]${NC} Discord                 — 游戏/社区"
    echo -e "  ${GREEN}[h]${NC} WhatsApp                — 海外用户"
    echo -e "  ${GREEN}[i]${NC} Slack                   — 外企用户"
    echo ""
    read -p "  请选择 (a-i): " -n 1 CH_CHOICE
    echo ""
    echo ""

    case $CH_CHOICE in
        a)
            echo -e "  ${CYAN}配置飞书 Feishu${NC}"
            echo ""
            echo "  飞书机器人配置步骤:"
            echo "  1. 访问 https://open.feishu.cn/app 创建应用"
            echo "  2. 获取 App ID 和 App Secret"
            echo "  3. 配置事件订阅和权限"
            echo ""
            echo "  详细文档: openclaw/docs/channels/feishu.md"
            echo ""
            ensure_deps
            cd "$OPENCLAW_DIR"
            echo -e "  ${YELLOW}启动 OpenClaw 配置向导...${NC}"
            "$NODE_BIN" openclaw.mjs onboard 2>&1 || true
            ;;
        b)
            echo -e "  ${CYAN}${BOLD}配置 QQ（腾讯官方接入）${NC}"
            echo ""
            echo -e "  ${GREEN}${BOLD}这是国内最简单的 AI 助手接入方式！${NC}"
            echo -e "  ${GREEN}全程 1 分钟，完全免费，无需翻墙。${NC}"
            echo ""
            echo -e "  ${WHITE}${BOLD}步骤:${NC}"
            echo ""
            echo "  1. 扫码注册 QQ 机器人:"
            echo -e "     ${CYAN}http://q.qq.com/qqbot/openclaw/login.html${NC}"
            echo ""
            echo "  2. 点击「创建机器人」，获取 AppID 和 AppSecret"
            echo ""
            echo "  3. 运行以下 3 条命令:"
            echo ""
            echo -e "     ${GREEN}openclaw plugins install @sliverp/qqbot@latest${NC}"
            echo -e "     ${GREEN}openclaw channels add --channel qqbot --token \"AppID:AppSecret\"${NC}"
            echo -e "     ${GREEN}openclaw gateway restart${NC}"
            echo ""
            echo -e "  ${RED}⚠️ 安全提醒:${NC}"
            echo "  默认任何人都能访问你的机器人！接入后请设置白名单:"
            echo -e "  ${YELLOW}openclaw config set channels.qqbot.allowFrom \"你的QQ号\"${NC}"
            echo ""
            echo -e "  ${DIM}备选方案: 也可以用 NapCatQQ (OneBot v11) 接入${NC}"
            echo -e "  ${DIM}https://github.com/NapNeko/NapCatQQ/releases${NC}"
            echo ""

            # 如果已安装 OpenClaw，直接帮用户执行
            if [ -d "$OPENCLAW_DIR/dist" ]; then
                read -p "  是否现在安装 QQ 插件? (y/n) " -n 1 DO_QQ
                echo ""
                if [[ "$DO_QQ" =~ ^[Yy]$ ]]; then
                    cd "$OPENCLAW_DIR"
                    echo ""
                    echo -e "  ${YELLOW}正在安装 QQ 插件...${NC}"
                    "$NODE_BIN" openclaw.mjs plugins install @sliverp/qqbot@latest 2>&1 || true
                    echo ""
                    read -p "  请输入你的 AppID:AppSecret: " QQ_TOKEN
                    if [ -n "$QQ_TOKEN" ]; then
                        "$NODE_BIN" openclaw.mjs channels add --channel qqbot --token "$QQ_TOKEN" 2>&1 || true
                        "$NODE_BIN" openclaw.mjs gateway restart 2>&1 || true
                        echo ""
                        echo -e "  ${GREEN}QQ 机器人配置完成！${NC}"
                        echo -e "  ${YELLOW}记得设置白名单!${NC}"
                    fi
                fi
            fi
            ;;
        c)
            echo -e "  ${CYAN}配置微信（社区插件）${NC}"
            echo ""
            echo "  安装微信插件:"
            echo "  openclaw plugins install @icesword760/openclaw-wechat"
            echo ""
            echo "  基于 iPad 协议，支持:"
            echo "  - 文字消息"
            echo "  - 图片发送"
            echo "  - 文件传输"
            echo "  - 关键词触发对话"
            echo ""
            echo "  仓库: https://github.com/icesword0760/openclaw-wechat"
            echo ""
            ensure_deps
            cd "$OPENCLAW_DIR"
            echo -e "  ${YELLOW}正在安装微信插件...${NC}"
            "$NODE_BIN" openclaw.mjs plugins install @icesword760/openclaw-wechat 2>&1 || \
            echo -e "  ${YELLOW}安装失败，请手动安装${NC}"
            ;;
        d|e)
            echo -e "  ${YELLOW}该平台正在开发中，敬请期待${NC}"
            echo "  可关注 u-claw.org 获取最新进展"
            ;;
        f)
            echo -e "  ${CYAN}配置 Telegram${NC}"
            echo ""
            echo "  步骤:"
            echo "  1. 在 Telegram 中找 @BotFather"
            echo "  2. 发送 /newbot 创建机器人"
            echo "  3. 获取 Bot Token"
            echo ""
            ensure_deps
            cd "$OPENCLAW_DIR"
            "$NODE_BIN" openclaw.mjs onboard 2>&1 || true
            ;;
        g)
            echo -e "  ${CYAN}配置 Discord${NC}"
            echo ""
            echo "  步骤:"
            echo "  1. 访问 https://discord.com/developers/applications"
            echo "  2. 创建 Application -> Bot"
            echo "  3. 获取 Bot Token"
            echo ""
            ensure_deps
            cd "$OPENCLAW_DIR"
            "$NODE_BIN" openclaw.mjs onboard 2>&1 || true
            ;;
        h|i)
            ensure_deps
            cd "$OPENCLAW_DIR"
            "$NODE_BIN" openclaw.mjs onboard 2>&1 || true
            ;;
        *)
            echo -e "  ${YELLOW}无效选择${NC}"
            ;;
    esac
}

# [7] 设置国内镜像
do_mirror() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 设置国内镜像源 ━━━${NC}"
    echo ""

    # npm 镜像
    echo -e "  ${YELLOW}设置 npm 淘宝镜像...${NC}"
    "$NODE_BIN" "$NPM_BIN" config set registry https://registry.npmmirror.com --location=project 2>/dev/null
    cd "$OPENCLAW_DIR" 2>/dev/null
    "$NODE_BIN" "$NPM_BIN" config set registry https://registry.npmmirror.com --location=project 2>/dev/null
    echo -e "  ${GREEN}npm 镜像已设置: registry.npmmirror.com${NC}"

    # 创建 .npmrc
    NPMRC="$OPENCLAW_DIR/.npmrc"
    if ! grep -q "npmmirror" "$NPMRC" 2>/dev/null; then
        echo "" >> "$NPMRC"
        echo "registry=https://registry.npmmirror.com" >> "$NPMRC"
    fi

    echo ""
    echo -e "  ${GREEN}国内镜像配置完成!${NC}"
    echo "  后续 npm install 将自动使用淘宝镜像"
}

# [8] 诊断修复
do_doctor() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 诊断修复 ━━━${NC}"
    echo ""
    ensure_deps
    cd "$OPENCLAW_DIR"
    "$NODE_BIN" openclaw.mjs doctor --repair 2>&1 || \
    echo -e "  ${YELLOW}如果 doctor 无法运行，请先完成安装步骤${NC}"
}

# [9] 备份
do_backup() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 备份当前状态 ━━━${NC}"
    echo ""

    BACKUP_DIR="$UCLAW_DIR/backups"
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_NAME="backup_${TIMESTAMP}"
    BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"

    mkdir -p "$BACKUP_PATH"

    echo -e "  ${YELLOW}备份中...${NC}"

    # 备份配置
    if [ -f "$OPENCLAW_DIR/.env" ]; then
        cp "$OPENCLAW_DIR/.env" "$BACKUP_PATH/.env"
        echo -e "  ${GREEN}  ✓ .env 配置${NC}"
    fi

    # 备份 OpenClaw 状态
    if [ -d "$HOME/.openclaw" ]; then
        mkdir -p "$BACKUP_PATH/openclaw-state"
        cp -R "$HOME/.openclaw/openclaw.json" "$BACKUP_PATH/openclaw-state/" 2>/dev/null || true
        cp -R "$HOME/.openclaw/credentials" "$BACKUP_PATH/openclaw-state/" 2>/dev/null || true
        echo -e "  ${GREEN}  ✓ OpenClaw 状态和凭据${NC}"
    fi

    # 备份 U-Claw 用户数据
    if [ -d "$UCLAW_DIR/memory" ] && [ "$(ls -A "$UCLAW_DIR/memory" 2>/dev/null)" ]; then
        cp -R "$UCLAW_DIR/memory" "$BACKUP_PATH/"
        echo -e "  ${GREEN}  ✓ 记忆文件${NC}"
    fi
    if [ -d "$UCLAW_DIR/persona" ] && [ "$(ls -A "$UCLAW_DIR/persona" 2>/dev/null)" ]; then
        cp -R "$UCLAW_DIR/persona" "$BACKUP_PATH/"
        echo -e "  ${GREEN}  ✓ 人格配置${NC}"
    fi

    # 备份已安装的版本
    if [ -d "$HOME/.uclaw/openclaw" ]; then
        cp "$HOME/.uclaw/openclaw/.env" "$BACKUP_PATH/installed-env" 2>/dev/null || true
        echo -e "  ${GREEN}  ✓ 已安装版本配置${NC}"
    fi

    BACKUP_SIZE=$(du -sh "$BACKUP_PATH" | cut -f1)
    echo ""
    echo -e "  ${GREEN}备份完成!${NC}"
    echo "  位置: $BACKUP_PATH"
    echo "  大小: $BACKUP_SIZE"
    echo ""

    # 显示所有备份
    echo "  所有备份:"
    ls -1 "$BACKUP_DIR" 2>/dev/null | while read -r b; do
        echo "    - $b"
    done
}

# [10] 恢复备份
do_restore() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 恢复备份 ━━━${NC}"
    echo ""

    BACKUP_DIR="$UCLAW_DIR/backups"
    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
        echo -e "  ${YELLOW}没有找到任何备份${NC}"
        echo "  请先使用 [9] 创建备份"
        return
    fi

    echo "  可用备份:"
    echo ""
    local i=1
    for b in "$BACKUP_DIR"/*/; do
        local bname=$(basename "$b")
        local bsize=$(du -sh "$b" | cut -f1)
        echo -e "  ${GREEN}[$i]${NC} $bname ($bsize)"
        i=$((i+1))
    done
    echo ""
    read -p "  选择要恢复的备份编号: " RESTORE_NUM

    local j=1
    local RESTORE_PATH=""
    for b in "$BACKUP_DIR"/*/; do
        if [ "$j" = "$RESTORE_NUM" ]; then
            RESTORE_PATH="$b"
            break
        fi
        j=$((j+1))
    done

    if [ -z "$RESTORE_PATH" ]; then
        echo -e "  ${RED}无效选择${NC}"
        return
    fi

    echo ""
    echo -e "  ${YELLOW}正在恢复 $(basename "$RESTORE_PATH")...${NC}"

    # 恢复 .env
    if [ -f "$RESTORE_PATH/.env" ]; then
        cp "$RESTORE_PATH/.env" "$OPENCLAW_DIR/.env"
        echo -e "  ${GREEN}  ✓ .env 已恢复${NC}"
    fi

    # 恢复 OpenClaw 状态
    if [ -d "$RESTORE_PATH/openclaw-state" ]; then
        mkdir -p "$HOME/.openclaw"
        cp -R "$RESTORE_PATH/openclaw-state/"* "$HOME/.openclaw/" 2>/dev/null || true
        echo -e "  ${GREEN}  ✓ OpenClaw 状态已恢复${NC}"
    fi

    # 恢复用户数据
    if [ -d "$RESTORE_PATH/memory" ]; then
        cp -R "$RESTORE_PATH/memory" "$UCLAW_DIR/"
        echo -e "  ${GREEN}  ✓ 记忆文件已恢复${NC}"
    fi
    if [ -d "$RESTORE_PATH/persona" ]; then
        cp -R "$RESTORE_PATH/persona" "$UCLAW_DIR/"
        echo -e "  ${GREEN}  ✓ 人格配置已恢复${NC}"
    fi

    echo ""
    echo -e "  ${GREEN}恢复完成!${NC}"
}

# [11] 重置
do_reset() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 重置 OpenClaw ━━━${NC}"
    echo ""
    echo -e "  ${RED}警告: 重置将清除配置和状态数据${NC}"
    echo ""
    echo -e "  ${GREEN}[1]${NC} 仅重置配置（保留凭据和会话）"
    echo -e "  ${YELLOW}[2]${NC} 重置配置 + 凭据 + 会话（保留工作区）"
    echo -e "  ${RED}[3]${NC} 完全重置（恢复出厂状态）"
    echo -e "  ${DIM}[0]${NC} 取消"
    echo ""
    read -p "  选择重置级别: " -n 1 RESET_CHOICE
    echo ""

    case $RESET_CHOICE in
        1)
            echo ""
            echo -e "  ${YELLOW}建议先备份! 是否先创建备份? (y/n)${NC}"
            read -n 1 DO_BACKUP
            echo ""
            [ "$DO_BACKUP" = "y" ] && do_backup
            ensure_deps
            cd "$OPENCLAW_DIR"
            "$NODE_BIN" openclaw.mjs reset --scope config 2>&1 || true
            ;;
        2)
            echo ""
            echo -e "  ${YELLOW}建议先备份! 是否先创建备份? (y/n)${NC}"
            read -n 1 DO_BACKUP
            echo ""
            [ "$DO_BACKUP" = "y" ] && do_backup
            ensure_deps
            cd "$OPENCLAW_DIR"
            "$NODE_BIN" openclaw.mjs reset --scope config+creds+sessions 2>&1 || true
            ;;
        3)
            echo ""
            echo -e "  ${RED}确定要完全重置吗? 输入 YES 确认:${NC} "
            read CONFIRM
            if [ "$CONFIRM" = "YES" ]; then
                do_backup
                ensure_deps
                cd "$OPENCLAW_DIR"
                "$NODE_BIN" openclaw.mjs reset --scope full 2>&1 || true
                echo -e "  ${GREEN}已恢复出厂状态${NC}"
            else
                echo "  已取消"
            fi
            ;;
        *)
            echo "  已取消"
            ;;
    esac
}

# [12] 清理
do_cleanup() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 清理缓存和临时文件 ━━━${NC}"
    echo ""

    FREED=0

    # 清理 npm 缓存
    echo -e "  ${YELLOW}清理 npm 缓存...${NC}"
    CACHE_SIZE=$("$NODE_BIN" "$NPM_BIN" cache ls 2>/dev/null | wc -l || echo 0)
    "$NODE_BIN" "$NPM_BIN" cache clean --force 2>/dev/null || true
    echo -e "  ${GREEN}  ✓ npm 缓存已清理${NC}"

    # 清理 Node.js 编译缓存
    if [ -d "$HOME/.cache/node" ]; then
        NSIZE=$(du -sm "$HOME/.cache/node" 2>/dev/null | cut -f1)
        rm -rf "$HOME/.cache/node"
        echo -e "  ${GREEN}  ✓ Node 编译缓存已清理 (${NSIZE}MB)${NC}"
    fi

    # 清理 OpenClaw 日志
    if [ -d "$HOME/.openclaw/logs" ]; then
        LSIZE=$(du -sm "$HOME/.openclaw/logs" 2>/dev/null | cut -f1)
        rm -rf "$HOME/.openclaw/logs"
        echo -e "  ${GREEN}  ✓ 日志已清理 (${LSIZE:-0}MB)${NC}"
    fi

    echo ""
    echo -e "  ${GREEN}清理完成!${NC}"
}

# [13] 技能浏览器
do_skills_browser() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 预装技能浏览器（52个，已离线可用）━━━${NC}"
    echo ""
    echo -e "  ${WHITE}${BOLD}  效率 & 编程${NC}"
    echo -e "  ${GREEN}  github${NC}           GitHub 操作（Issues/PR/代码审查/CI）"
    echo -e "  ${GREEN}  gh-issues${NC}        获取 Issues 并分配 Agent 修复"
    echo -e "  ${GREEN}  coding-agent${NC}     委派编程任务给 Codex/Claude/Pi"
    echo -e "  ${GREEN}  summarize${NC}        总结文本/网页/播客/视频"
    echo -e "  ${GREEN}  nano-pdf${NC}         自然语言编辑 PDF"
    echo -e "  ${GREEN}  clawhub${NC}          搜索安装更多社区技能"
    echo -e "  ${GREEN}  skill-creator${NC}    创建自定义技能"
    echo ""
    echo -e "  ${WHITE}${BOLD}  笔记 & 任务管理${NC}"
    echo -e "  ${GREEN}  apple-notes${NC}      Apple 备忘录（创建/搜索/编辑）"
    echo -e "  ${GREEN}  apple-reminders${NC}  Apple 提醒事项"
    echo -e "  ${GREEN}  obsidian${NC}         Obsidian 笔记操作"
    echo -e "  ${GREEN}  notion${NC}           Notion 页面和数据库"
    echo -e "  ${GREEN}  things-mac${NC}       Things 3 任务管理 (macOS)"
    echo -e "  ${GREEN}  trello${NC}           Trello 看板操作"
    echo -e "  ${GREEN}  bear-notes${NC}       Bear 笔记"
    echo ""
    echo -e "  ${WHITE}${BOLD}  AI & 创作${NC}"
    echo -e "  ${GREEN}  openai-image-gen${NC} AI 图片生成"
    echo -e "  ${GREEN}  openai-whisper${NC}   语音转文字（本地）"
    echo -e "  ${GREEN}  openai-whisper-api${NC} 语音转文字（API）"
    echo -e "  ${GREEN}  gemini${NC}           Gemini 一键问答"
    echo -e "  ${GREEN}  sag${NC}              ElevenLabs 文字转语音"
    echo -e "  ${GREEN}  sherpa-onnx-tts${NC}  本地离线文字转语音"
    echo -e "  ${GREEN}  nano-banana-pro${NC}  Gemini 3 图片生成"
    echo ""
    echo -e "  ${WHITE}${BOLD}  通讯 & 社交${NC}"
    echo -e "  ${GREEN}  himalaya${NC}         邮件收发（IMAP/SMTP）"
    echo -e "  ${GREEN}  discord${NC}          Discord 消息操作"
    echo -e "  ${GREEN}  slack${NC}            Slack 消息操作"
    echo -e "  ${GREEN}  wacli${NC}            WhatsApp 消息和历史"
    echo -e "  ${GREEN}  imsg${NC}             iMessage/SMS"
    echo -e "  ${GREEN}  xurl${NC}             X (Twitter) API"
    echo ""
    echo -e "  ${WHITE}${BOLD}  系统 & 工具${NC}"
    echo -e "  ${GREEN}  weather${NC}          天气查询"
    echo -e "  ${GREEN}  peekaboo${NC}         macOS 屏幕截图和 UI 自动化"
    echo -e "  ${GREEN}  tmux${NC}             远程终端管理"
    echo -e "  ${GREEN}  healthcheck${NC}      系统安全检查"
    echo -e "  ${GREEN}  1password${NC}        1Password 密码管理"
    echo -e "  ${GREEN}  video-frames${NC}     视频截帧 (ffmpeg)"
    echo -e "  ${GREEN}  session-logs${NC}     会话日志搜索分析"
    echo -e "  ${GREEN}  mcporter${NC}         MCP 服务管理"
    echo ""
    echo -e "  ${WHITE}${BOLD}  智能家居 & IoT${NC}"
    echo -e "  ${GREEN}  openhue${NC}          Philips Hue 灯光控制"
    echo -e "  ${GREEN}  sonoscli${NC}         Sonos 音箱控制"
    echo -e "  ${GREEN}  eightctl${NC}         Eight Sleep 智能床垫"
    echo -e "  ${GREEN}  camsnap${NC}          摄像头截图/录像"
    echo ""
    echo -e "  ${DIM}  提示: 这些技能已全部预装在 U 盘中，无需联网下载${NC}"
    echo -e "  ${DIM}  使用: 在 OpenClaw 中直接说 \"帮我查天气\" 或 \"帮我发邮件\" 即可${NC}"
    echo -e "  ${DIM}  更多: 运行 openclaw 后输入 /skills 查看详情${NC}"
}

# [14] 中国用户指南
do_china_guide() {
    echo ""
    if [ -f "$UCLAW_DIR/中国用户指南.txt" ]; then
        cat "$UCLAW_DIR/中国用户指南.txt"
    else
        echo "  指南文件不存在"
    fi
}

# [15] 使用说明
do_readme() {
    echo ""
    if [ -f "$UCLAW_DIR/使用说明.txt" ]; then
        cat "$UCLAW_DIR/使用说明.txt"
    else
        echo "  使用说明文件不存在"
    fi
}

# [16] 系统信息
do_sysinfo() {
    echo ""
    echo -e "  ${CYAN}${BOLD}━━━ 系统信息 ━━━${NC}"
    echo ""
    echo "  操作系统:    $(sw_vers -productName 2>/dev/null || uname -s) $(sw_vers -productVersion 2>/dev/null || uname -r)"
    echo "  CPU架构:     $(uname -m)"
    echo "  内存:        $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.1f GB", $1/1024/1024/1024}' || echo '未知')"
    echo "  Node.js:     $($NODE_BIN --version 2>/dev/null || echo '未找到')"
    echo "  npm:         $($NODE_BIN $NPM_BIN --version 2>/dev/null || echo '未找到')"
    echo ""
    echo "  U-Claw 路径: $UCLAW_DIR"
    echo "  U-Claw 大小: $(du -sh "$UCLAW_DIR" 2>/dev/null | cut -f1)"
    echo ""
    if [ -d "$HOME/.uclaw" ]; then
        echo "  已安装路径: $HOME/.uclaw"
        echo "  已安装大小: $(du -sh "$HOME/.uclaw" 2>/dev/null | cut -f1)"
    else
        echo "  电脑安装:   未安装"
    fi
    echo ""
    if [ -d "$HOME/.openclaw" ]; then
        echo "  OpenClaw 状态: $HOME/.openclaw"
        echo "  状态大小:      $(du -sh "$HOME/.openclaw" 2>/dev/null | cut -f1)"
    fi
    echo ""
    echo "  磁盘空间:    $(df -h "$UCLAW_DIR" 2>/dev/null | tail -1 | awk '{print $4 " 可用 / " $2 " 总计"}')"
}

# 主循环
while true; do
    show_menu
    read -p "  请选择 [0-16]: " CHOICE
    echo ""

    case $CHOICE in
        1)  do_install ;;
        2)  do_npm_install ;;
        3)  do_build ;;
        4)  do_run ;;
        5)  do_china_models ;;
        6)  do_china_channels ;;
        7)  do_mirror ;;
        8)  do_doctor ;;
        9)  do_backup ;;
        10) do_restore ;;
        11) do_reset ;;
        12) do_cleanup ;;
        13) do_skills_browser ;;
        14) do_china_guide ;;
        15) do_readme ;;
        16) do_sysinfo ;;
        17) do_dashboard ;;
        0)
            echo -e "  ${CYAN}再见! 🦞${NC}"
            echo ""
            exit 0
            ;;
        *)
            echo -e "  ${RED}无效选择，请输入 0-17${NC}"
            ;;
    esac

    echo ""
    read -p "  按回车键返回主菜单..."
done
