#!/bin/bash
# ============================================================
#  M-Claw — 便携版启动器 (macOS)
#  双击此文件即可启动 OpenClaw
# ============================================================
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCH=$(uname -m)

# --- Colors ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo ""
echo -e "${CYAN}  🦞 M-Claw — 便携版${NC}"
echo -e "  ════════════════════════════════"
echo ""

# --- Find Node.js ---
if [ "$ARCH" = "arm64" ]; then
    NODE_BIN="$DIR/runtime/node-mac-arm64/bin/node"
else
    NODE_BIN="$DIR/runtime/node-mac-x64/bin/node"
fi
[ ! -f "$NODE_BIN" ] && NODE_BIN="$(which node 2>/dev/null)"

if [ -z "$NODE_BIN" ] || [ ! -f "$NODE_BIN" ]; then
    echo -e "${RED}  ✗ 未找到 Node.js，请确保 runtime/ 目录完整${NC}"
    echo "  按回车退出..."; read; exit 1
fi
NODE_VER=$("$NODE_BIN" --version 2>/dev/null)
echo -e "  ${GREEN}✓${NC} Node.js: $NODE_VER ($ARCH)"

# --- Remove macOS quarantine ---
if xattr -l "$NODE_BIN" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo -e "  ${YELLOW}移除 macOS 安全限制...${NC}"
    xattr -rd com.apple.quarantine "$DIR" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} 已移除"
fi

# --- Find OpenClaw ---
CORE_DIR="$DIR/core"
OPENCLAW_MJS="$CORE_DIR/node_modules/openclaw/openclaw.mjs"
if [ ! -f "$OPENCLAW_MJS" ]; then
    echo -e "${RED}  ✗ 未找到 OpenClaw，请确保 core/ 目录完整${NC}"
    echo "  按回车退出..."; read; exit 1
fi
echo -e "  ${GREEN}✓${NC} OpenClaw: 已就绪"

# --- Setup portable data dir ---
DATA_DIR="$DIR/data"
export OPENCLAW_HOME="$DATA_DIR"
export OPENCLAW_STATE_DIR="$DATA_DIR/.openclaw"
export OPENCLAW_CONFIG_PATH="$DATA_DIR/.openclaw/openclaw.json"
mkdir -p "$DATA_DIR/.openclaw" "$DATA_DIR/memory" "$DATA_DIR/backups" "$DATA_DIR/logs"

# --- Check if config needs setup (first run) ---
CONFIG_FILE="$DATA_DIR/.openclaw/openclaw.json"
NEEDS_CONFIG=false
if [ ! -f "$CONFIG_FILE" ]; then
    NEEDS_CONFIG=true
else
    if ! grep -qE '"apiKey"|"ZAI_API_KEY"|"providers"' "$CONFIG_FILE" 2>/dev/null; then
        NEEDS_CONFIG=true
    fi
fi

# --- If first run, open Config GUI first ---
if [ "$NEEDS_CONFIG" = "true" ]; then
    echo ""
    echo -e "  ${YELLOW}⚡ 首次运行，请先配置模型和 API Key${NC}"
    echo -e "  ${YELLOW}   正在打开配置页面...${NC}"
    echo ""

    CONFIG_PORT=18780
    while lsof -i :$CONFIG_PORT >/dev/null 2>&1; do
        CONFIG_PORT=$((CONFIG_PORT + 1))
        [ $CONFIG_PORT -gt 18785 ] && break
    done

    "$NODE_BIN" -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const configPath = '$CONFIG_FILE';
const htmlPath = path.join('$DIR', 'Config.html');

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(fs.readFileSync(htmlPath, 'utf-8'));
    } else if (req.method === 'GET' && req.url === '/api/config') {
        try {
            const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify(cfg));
        } catch(e) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end('{}');
        }
    } else if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const cfg = JSON.parse(body);
                fs.mkdirSync(path.dirname(configPath), {recursive: true});
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end('{\"ok\":true}');
            } catch(e) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end('{\"error\":\"' + e.message + '\"}');
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/done') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end('{\"ok\":true}');
        setTimeout(() => { server.close(); process.exit(0); }, 300);
    } else {
        res.writeHead(404); res.end('Not Found');
    }
});
server.listen($CONFIG_PORT, '127.0.0.1', () => {
    console.log('Config server: http://127.0.0.1:$CONFIG_PORT');
});
" &
    CONFIG_PID=$!
    sleep 1
    open "http://127.0.0.1:$CONFIG_PORT/"

    echo -e "  ${CYAN}等待配置完成...${NC}"
    echo -e "  （在浏览器中选择模型、填写 API Key，点击「保存并启动」）"
    echo ""
    wait $CONFIG_PID 2>/dev/null
    echo -e "  ${GREEN}✓${NC} 配置已保存"
    echo ""
fi

# --- Check dependencies ---
if [ ! -d "$CORE_DIR/node_modules" ]; then
    echo -e "  ${YELLOW}首次运行，安装依赖...${NC}"
    NODE_DIR="$(dirname "$(dirname "$NODE_BIN")")"
    cd "$CORE_DIR"
    "$NODE_BIN" "$NODE_DIR/bin/npm" install --registry=https://registry.npmmirror.com 2>&1
    echo -e "  ${GREEN}✓${NC} 依赖安装完成"
    echo ""
fi

# --- Find available port ---
PORT=18789
while lsof -i :$PORT >/dev/null 2>&1; do
    PORT=$((PORT + 1))
    [ $PORT -gt 18799 ] && echo -e "${RED}  ✗ 没有可用端口 (18789-18799)${NC}" && exit 1
done

echo -e "  ${CYAN}🚀 正在启动 OpenClaw...${NC}"
echo ""

# --- Start OpenClaw gateway ---
cd "$CORE_DIR"
"$NODE_BIN" "$OPENCLAW_MJS" gateway run --allow-unconfigured --force --port $PORT &
GW_PID=$!

# --- Wait for gateway, then open browser ---
for i in $(seq 1 30); do
    sleep 0.5
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        TOKEN=$("$NODE_BIN" -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));console.log(c.gateway?.auth?.token||'uclaw')}catch(e){console.log('uclaw')}" 2>/dev/null)
        open "http://127.0.0.1:$PORT/#token=$TOKEN" 2>/dev/null || true
        break
    fi
done

TOKEN=$("$NODE_BIN" -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));console.log(c.gateway?.auth?.token||'uclaw')}catch(e){console.log('uclaw')}" 2>/dev/null)
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo -e "  ${GREEN}🦞 M-Claw 正在运行！${NC}"
echo -e "  ${GREEN}   地址: http://127.0.0.1:$PORT/#token=$TOKEN${NC}"
echo ""
echo -e "  ${YELLOW}按 Ctrl+C 停止服务${NC}"
echo -e "  ${GREEN}════════════════════════════════${NC}"
echo ""

trap "kill $GW_PID 2>/dev/null; echo ''; echo '  🦞 M-Claw 已停止'; exit 0" INT TERM
wait $GW_PID
