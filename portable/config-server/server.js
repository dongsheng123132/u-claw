#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { deflateSync } = require('zlib');
const crypto = require('crypto');

const PORT_RANGE_START = 18788;
const PORT_RANGE_END = 18798;

// ── WeChat Login State ──────────────────────────────────────────────────────
const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_BOT_TYPE = '3';
const ACTIVE_LOGIN_TTL_MS = 5 * 60000;
const QR_POLL_TIMEOUT_MS = 35000;
const MAX_QR_REFRESH_COUNT = 3;

// ── 路径 ────────────────────────────────────────────────────────────────────
//
// 全部来自动作核心的 resolvePaths()，本文件不再自己算。
// 改造前这里是 `path.join(__dirname,'../data/.openclaw/openclaw.json')` 写死，
// 完全不认 OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR——而同一个文件里的
// /api/update-status 又认，一个进程内两套算法。装到 ~/.uclaw 之后配置中心
// 写的和网关读的就不是同一个文件了。宪法 #8。
//
// 在 startup() 里赋值（动作核心是 ESM，CJS 只能异步 import）。
let PATHS = null;
const P = () => {
  if (!PATHS) throw new Error('paths not initialised yet');
  return PATHS;
};

const activeLogins = new Map();

// ── 影核动作核心桥接 ────────────────────────────────────────────────────────
// server.js 是 CJS，动作核心是 ESM，用动态 import() 搭桥（只加载一次）。
// 关键点：这个文件从此**不再自己实现任何业务**，只做 HTTP 适配 —— 解析请求、
// 调动作、回结果。业务对不对由 lib/core 负责，CLI 走的是同一批代码。
let corePromise = null;
function loadCore() {
  if (!corePromise) corePromise = import('../lib/core/index.mjs');
  return corePromise;
}

async function runAction(id, input, ctxExtra = {}) {
  const core = await loadCore();
  const action = core.getAction(id);
  if (!action) throw new Error(`unknown action: ${id}`);
  return core.execute(action, input, { paths: core.resolvePaths(), surface: 'gui', ...ctxExtra });
}

/** 动作结果直出。成功 200，业务失败 400（区别于 5xx 的进程级异常）。 */
function sendResult(res, result) {
  res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

function sendError(res, err) {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, data: null, error: { code: 'INTERNAL_ERROR', message: err?.message || String(err) } }));
}

/** 读 JSON 请求体，带大小上限（宪法 #9：凡会卡的都要有界）。 */
function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      body += chunk;
      if (body.length > limitBytes) {
        over = true;
        reject(new Error(`request body too large (> ${limitBytes} bytes)`));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

// ── QR Code PNG Renderer (pure Node.js, no external deps) ───────────────────

function getQrRenderDeps() {
  // Try to load QR lib from openclaw's bundled qrcode-terminal
  const corePath = path.join(__dirname, '../app/core/node_modules');
  const candidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/index.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/index.js'),
  ];
  const errCandidates = [
    path.join(corePath, 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
    path.join(corePath, 'openclaw/node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'),
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return { QRCode: require(candidates[i]), QRErrorCorrectLevel: require(errCandidates[i]) };
    }
  }
  // Fallback: try WeChat plugin's own node_modules
  const pluginQr = path.join(P().bundledExtensionsDir, 'openclaw-weixin', 'node_modules/qrcode-terminal/vendor/QRCode/index.js');
  const pluginQrErr = path.join(P().bundledExtensionsDir, 'openclaw-weixin', 'node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');
  if (fs.existsSync(pluginQr)) {
    return { QRCode: require(pluginQr), QRErrorCorrectLevel: require(pluginQrErr) };
  }
  throw new Error('QR code library not found');
}

function createQrMatrix(input) {
  const { QRCode, QRErrorCorrectLevel } = getQrRenderDeps();
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

function fillPixel(buf, x, y, width, r, g, b, a) {
  const idx = (y * width + x) * 4;
  buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = (a === undefined ? 255 : a);
}

const CRC_TABLE = (function() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const offset = row * (stride + 1);
    raw[offset] = 0;
    buffer.copy(raw, offset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function renderQrPngDataUrl(input) {
  const scale = 6, margin = 4;
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
  const size = (modules + margin * 2) * scale;
  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      const sx = (col + margin) * scale, sy = (row + margin) * scale;
      for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++)
        fillPixel(buf, sx + x, sy + y, size, 0, 0, 0, 255);
    }
  }
  return 'data:image/png;base64,' + encodePngRgba(buf, size, size).toString('base64');
}

// ── WeChat API helpers ──────────────────────────────────────────────────────

async function fetchWeChatQrCode(apiBaseUrl) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(DEFAULT_ILINK_BOT_TYPE);
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Failed to fetch QR: ' + response.status + ' ' + body);
  }
  return await response.json();
}

async function pollWeChatQrStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  const url = base + 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) throw new Error('Poll failed: ' + response.status + ' ' + text);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { status: 'wait' };
    throw err;
  }
}

function normalizeAccountId(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

async function saveWeChatAccount(rawAccountId, payload) {
  const accountId = normalizeAccountId(rawAccountId);
  const WECHAT_ACCOUNTS_DIR = path.join(P().stateDir, 'openclaw-weixin', 'accounts');
  fs.mkdirSync(WECHAT_ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(WECHAT_ACCOUNTS_DIR, accountId + '.json');
  const data = {
    token: payload.token.trim(),
    savedAt: new Date().toISOString(),
  };
  if (payload.baseUrl) data.baseUrl = payload.baseUrl.trim();
  if (payload.userId) data.userId = payload.userId.trim();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // Update account index
  let accounts = [];
  const WECHAT_ACCOUNT_INDEX_FILE = path.join(P().stateDir, 'openclaw-weixin', 'accounts.json');
  try { accounts = JSON.parse(fs.readFileSync(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8')); } catch {}
  if (!Array.isArray(accounts)) accounts = [];
  if (!accounts.includes(accountId)) {
    accounts.push(accountId);
    fs.mkdirSync(path.join(P().stateDir, 'openclaw-weixin'), { recursive: true });
    fs.writeFileSync(WECHAT_ACCOUNT_INDEX_FILE, JSON.stringify(accounts, null, 2));
  }
  return accountId;
}

/**
 * 铺设微信插件 —— 直通 plugin.wechat.install 动作。
 *
 * 原来这里是该动作的第 5 份实现（另外 4 份在 Windows/Mac 的 Start/Install 脚本里），
 * 而且是唯一一份不补 zod 的，所以从配置中心扫码接入的用户拿到的是个加载不了的插件。
 * 现在和启动器走同一份代码，不可能再出现"这条路修了那条路没修"。
 *
 * 容错：铺设失败不中断整个 confirmed 流程（账号已保存，配置也会写好）。
 */
async function ensureWeChatPluginInstalled() {
  try {
    const r = await runAction('plugin.wechat.install', {}, {});
    if (!r.ok) return { installed: false, warning: `${r.error.code}: ${r.error.message}` };
    return { installed: r.data.installed, action: r.data.action, version: r.data.installed_version };
  } catch (e) {
    console.error('WeChat plugin install failed:', e.message);
    return { installed: false, warning: e.message };
  }
}

// ── WeChat login session management ─────────────────────────────────────────

async function handleWeChatStart() {
  const sessionKey = crypto.randomUUID();
  const apiBaseUrl = DEFAULT_WECHAT_BASE_URL;
  const qrResponse = await fetchWeChatQrCode(apiBaseUrl);
  const qrDataUrl = renderQrPngDataUrl(qrResponse.qrcode_img_content);

  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrDataUrl,
    startedAt: Date.now(),
    apiBaseUrl,
  });

  return { sessionKey, qrcodeUrl: qrDataUrl };
}

async function handleWeChatStatus(sessionKey) {
  const login = activeLogins.get(sessionKey);
  if (!login) return { status: 'expired', message: 'No active session' };
  if (Date.now() - login.startedAt > ACTIVE_LOGIN_TTL_MS) {
    activeLogins.delete(sessionKey);
    return { status: 'expired', message: 'Session expired' };
  }

  // 状态轮询用 pollBaseUrl（IDC 重定向后会指向新主机）；二维码获取/刷新始终用原始
  // apiBaseUrl（与官方插件一致：refresh 回到固定主机，只有 status 轮询跟随重定向）。
  const result = await pollWeChatQrStatus(login.pollBaseUrl || login.apiBaseUrl, login.qrcode);
  // 微信登录状态流转日志（跳过高频的 wait，便于排查"扫码卡死"类问题）。
  if (result.status && result.status !== 'wait') {
    console.log(`[wechat] status=${result.status}` + (result.redirect_host ? ` redirect_host=${result.redirect_host}` : ''));
  }

  if (result.status === 'expired') {
    // Try to refresh QR code
    if (!login.refreshCount) login.refreshCount = 1;
    login.refreshCount++;
    if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
      activeLogins.delete(sessionKey);
      return { status: 'expired', message: 'QR expired too many times' };
    }
    const refreshed = await fetchWeChatQrCode(login.apiBaseUrl);
    const newQr = renderQrPngDataUrl(refreshed.qrcode_img_content);
    login.qrcode = refreshed.qrcode;
    login.qrcodeUrl = newQr;
    login.startedAt = Date.now();
    // 新二维码来自原始主机，重置轮询主机，避免拿新码去轮询旧的重定向主机。
    login.pollBaseUrl = null;
    return { status: 'refreshed', qrcodeUrl: newQr };
  }

  if (result.status === 'confirmed') {
    activeLogins.delete(sessionKey);
    if (!result.ilink_bot_id || !result.bot_token) {
      return { status: 'error', message: 'Server did not return credentials' };
    }

    // 1. Install plugin
    const pluginResult = await ensureWeChatPluginInstalled();

    // 2. Save account
    const accountId = await saveWeChatAccount(result.ilink_bot_id, {
      token: result.bot_token,
      baseUrl: result.baseurl,
      userId: result.ilink_user_id,
    });

    // 3. 启用插件 —— 走 config.set 动作，不再自己 writeFileSync。
    //    原来这里是第三份写配置的实现（另外两份在 Config.html），
    //    三份各写各的正是"接完微信再改模型就掉线"的根因。
    try {
      const r = await runAction(
        'config.set',
        { patch: { plugins: { entries: { 'openclaw-weixin': { enabled: true } } } } },
        { confirmed: true },
      );
      if (!r.ok) console.error('启用微信插件失败:', r.error.code, r.error.message);
    } catch (e) {
      console.error('Failed to update config:', e.message);
    }

    return {
      status: 'confirmed',
      accountId,
      pluginInstalled: pluginResult.installed,
      message: 'WeChat connected! Restart Gateway to activate.',
    };
  }

  // IDC 重定向：用户扫码后，ilink 服务端可能要求把后续轮询切换到另一个数据中心主机
  // (status=scaned_but_redirect + redirect_host)。必须跟着切，否则一直轮询旧主机，
  // 扫码后永远等不到 confirmed——表现为「扫了码却卡死不前进」。
  // 同款逻辑见官方插件 openclaw-weixin/src/auth/login-qr.ts 的 scaned_but_redirect 分支。
  if (result.status === 'scaned_but_redirect') {
    if (result.redirect_host) {
      login.pollBaseUrl = 'https://' + result.redirect_host;
    }
    // 对前端按「已扫码」处理：显示提示并继续轮询，下一轮已指向新主机。
    return { status: 'scaned' };
  }

  return { status: result.status };
}

function handleWeChatCancel(sessionKey) {
  if (sessionKey) activeLogins.delete(sessionKey);
  else activeLogins.clear();
}

// ── 同源闸门 ────────────────────────────────────────────────────────────────
//
// 改造前这里是 `Access-Control-Allow-Origin: *`，配合 /api/config 直接把整份
// openclaw.json（含全部 API Key 和 gateway token）交出去——用户浏览器里打开的
// **任何一个网页**都能 fetch 走；POST 同样没有来源校验，任意网页都能把模型
// baseUrl 改成攻击者的服务器。两条都实测复现过。
//
// 现在：只认本机来源。浏览器无法伪造 Origin，跨站请求一律 403。
// 同时校验 Host，堵住 DNS rebinding（把恶意域名解析到 127.0.0.1 那一手）。
const LOCAL_HOST_RE = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

function isLocalRequest(req) {
  const host = req.headers.host || '';
  if (!LOCAL_HOST_RE.test(host)) return false;

  const origin = req.headers.origin;
  // 无 Origin：来自 file:// 页面、curl、启动器等非跨站场景，放行。
  // 跨站 fetch 一定带 Origin，所以这里漏不掉真正的攻击面。
  if (!origin || origin === 'null') return true;
  try {
    return LOCAL_HOST_RE.test(new URL(origin).host);
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  if (!isLocalRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: cross-origin requests are not allowed' }));
    return;
  }
  // 只回显本机来源，绝不用 *
  const origin = req.headers.origin;
  if (origin && origin !== 'null') res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: WeChat start login
  if (req.url === '/api/wechat/start' && req.method === 'POST') {
    handleWeChatStart()
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat poll status
  if (req.url && req.url.startsWith('/api/wechat/status') && req.method === 'GET') {
    const urlObj = new URL(req.url, 'http://localhost');
    const session = urlObj.searchParams.get('session');
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session parameter' }));
      return;
    }
    handleWeChatStatus(session)
      .then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // API: WeChat cancel
  if (req.url === '/api/wechat/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        handleWeChatCancel(data.session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: WeChat plugin status
  if (req.url === '/api/wechat/plugin-status' && req.method === 'GET') {
    const hasPlugin = fs.existsSync(path.join(P().bundledExtensionsDir, 'openclaw-weixin', 'openclaw.plugin.json'));
    const installed = fs.existsSync(path.join(P().extensionsDir, 'openclaw-weixin', 'openclaw.plugin.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasPlugin, installed }));
    return;
  }

  // ── 影核动作端点 ──────────────────────────────────────────────────────────
  // 这些不再自己实现业务，一律直通 lib/core 的同一个动作。
  // GUI 和 CLI 因此永远不会漂移（ActionParity §5 架构不变量）。

  // API: Get config —— 绑定 config.get
  if (req.url === '/api/config' && req.method === 'GET') {
    runAction('config.get', {}, {})
      .then((r) => sendResult(res, r))
      .catch((err) => sendError(res, err));
    return;
  }

  // API: 健康诊断 —— 绑定 doctor.diagnose
  if (req.url === '/api/doctor' && req.method === 'GET') {
    runAction('doctor.diagnose', {}, {})
      .then((r) => sendResult(res, r))
      .catch((err) => sendError(res, err));
    return;
  }

  // API: 读执行日志 —— 绑定 log.tail
  if (req.url && req.url.startsWith('/api/logs') && req.method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const input = {};
    if (q.get('limit')) input.limit = Number(q.get('limit'));
    if (q.get('action_id')) input.action_id = q.get('action_id');
    if (q.get('failed_only') === 'true') input.failed_only = true;
    runAction('log.tail', input, {})
      .then((r) => sendResult(res, r))
      .catch((err) => sendError(res, err));
    return;
  }

  // API: 生成 bug 报告 —— 绑定 bug.collect
  if (req.url === '/api/bug-report' && req.method === 'POST') {
    readBody(req)
      .then((body) => runAction('bug.collect', body.note ? { note: String(body.note) } : {}, {}))
      .then((r) => sendResult(res, r))
      .catch((err) => sendError(res, err));
    return;
  }

  // API: Update status — read update-available.json written by check-update.mjs
  // Returns { available: false } if no info or stale; otherwise the manifest payload.
  if (req.url === '/api/update-status' && req.method === 'GET') {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR
        || path.join(__dirname, '../data/.openclaw');
      const updateFile = path.join(stateDir, 'update-available.json');
      if (!fs.existsSync(updateFile)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: 'no-check-yet' }));
        return;
      }
      const payload = JSON.parse(fs.readFileSync(updateFile, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, reason: 'read-failed', error: err.message }));
    }
    return;
  }

  // API: Trigger update check on demand (so users can press a "Check now" button)
  if (req.url === '/api/update-check' && req.method === 'POST') {
    (async () => {
      try {
        const mod = await import('../lib/check-update.mjs');
        const portableRoot = path.join(__dirname, '..');
        const versionFilePath = fs.existsSync(path.join(portableRoot, 'OPENCLAW_VERSION'))
          ? path.join(portableRoot, 'OPENCLAW_VERSION')
          : path.join(portableRoot, '..', 'OPENCLAW_VERSION');
        const stateDir = process.env.OPENCLAW_STATE_DIR
          || path.join(portableRoot, 'data/.openclaw');
        const result = await mod.checkUpdate({ versionFilePath, stateDir });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // API: Discover local models (Ollama / LM Studio)
  // 借鉴 RealShocky/openclaw-windows：自动探测本机已装的本地模型，
  // 用户无需手填 baseUrl/模型名，直接点选即可（便携版纯离线推理卖点）。
  // 静默失败：探测不到就返回空数组，不影响 Config 页面。
  if (req.url === '/api/local-models' && req.method === 'GET') {
    (async () => {
      const probes = [
        { provider: 'ollama',   label: 'Ollama',    base: 'http://127.0.0.1:11434/v1', api: 'http://127.0.0.1:11434/api/tags' },
        { provider: 'lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234/v1',  api: 'http://127.0.0.1:1234/v1/models' },
      ];
      const found = [];
      await Promise.all(probes.map(async (p) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1200);
          const r = await fetch(p.api, { signal: ctrl.signal });
          clearTimeout(t);
          if (!r.ok) return;
          const data = await r.json();
          // Ollama: { models:[{name}] } | LM Studio (OpenAI-style): { data:[{id}] }
          const models = Array.isArray(data.models)
            ? data.models.map(m => m.name).filter(Boolean)
            : Array.isArray(data.data)
              ? data.data.map(m => m.id).filter(Boolean)
              : [];
          if (models.length) found.push({ provider: p.provider, label: p.label, base: p.base, models });
        } catch { /* 探测失败：该 provider 未运行，跳过 */ }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ providers: found }));
    })();
    return;
  }

  // API: Save config —— 绑定 config.set
  //
  // 语义从"整份覆盖"改成"深合并"。这一条就是那个 bug 的修法：
  // 原来 Config.html 存模型时 POST 一份从零构造的配置，把用户已接好的
  // channels / plugins 整份冲掉（接完微信再改模型 → 微信掉线）。
  // 现在少传的字段一律保留，要删必须走 unset 显式声明。
  if (req.url === '/api/config' && req.method === 'POST') {
    readBody(req)
      .then((patch) => {
        // 清除旧版废弃键，防止 OpenClaw 报 "agent.* was moved" 错误。
        // 深合并表达不了删除，所以走 unset。
        const unset = [];
        if (patch && typeof patch === 'object' && 'agent' in patch) delete patch.agent;
        unset.push('agent');
        return runAction('config.set', { patch: patch || {}, unset }, { confirmed: true });
      })
      .then((r) => sendResult(res, r))
      .catch((err) => sendError(res, err));
    return;
  }

  // ── 虾盘云 · 设备钱包 ───────────────────────────────────────────────────
  // 六个接口全部只在被调用时才碰网络（claim/rotate/adopt 内部才发 fetch）——绝不能挂在
  // 服务器启动或任何计时器上，否则等于变相恢复本仓 CLAUDE.md 删掉的自动开户
  // （bootstrap-xiapan.mjs，2026-06-17 已移除）。真正联网只发生在用户点了配置页按钮之后，
  // 这条路由本身只是把浏览器的点击转发给 lib/wallet-client.mjs。

  // API: 本地钱包状态（不联网，配置页首屏用）
  if (req.url === '/api/wallet/status' && req.method === 'GET') {
    (async () => {
      try {
        const { getStatus, payBaseUrl } = await import('../lib/wallet-client.mjs');
        const result = await getStatus();
        if (result.hasWallet && result.apiKey) {
          result.rechargeUrl = payBaseUrl() + '/recharge?key=' + encodeURIComponent(result.apiKey);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, hasWallet: false }));
      }
    })();
    return;
  }

  // API: 一键领取额度
  if (req.url === '/api/wallet/claim' && req.method === 'POST') {
    (async () => {
      try {
        const { claimWallet } = await import('../lib/wallet-client.mjs');
        const result = await claimWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 查询余额
  if (req.url === '/api/wallet/balance' && req.method === 'GET') {
    (async () => {
      try {
        const { getBalance } = await import('../lib/wallet-client.mjs');
        const result = await getBalance();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 换一把（两阶段提交：mint → 只读验证 → commit）
  if (req.url === '/api/wallet/rotate' && req.method === 'POST') {
    (async () => {
      try {
        const { rotateWallet } = await import('../lib/wallet-client.mjs');
        const result = await rotateWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: 填入已有密钥
  if (req.url === '/api/wallet/adopt' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      (async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const { adoptWallet } = await import('../lib/wallet-client.mjs');
          const result = await adoptWallet(data.key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      })();
    });
    return;
  }

  // API: 移除本机钱包（危险区；只清本地 + 清实际消费者，绝不调服务端删钱包/清余额）
  if (req.url === '/api/wallet/reset-local' && req.method === 'POST') {
    (async () => {
      try {
        const { resetLocalWallet } = await import('../lib/wallet-client.mjs');
        const result = await resetLocalWallet();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // ── 静态文件 ──────────────────────────────────────────────────────────────
  // 改造前这里是 path.join(__dirname,'public', req.url)，req.url 未经净化，
  // `GET /../../data/.openclaw/openclaw.json` 直接把配置文件（含 Key）吐出来，
  // 实测复现过。现在：先剥查询串、解码、再 resolve，最后强制校验结果仍在 public/ 内。
  const PUBLIC_DIR = path.resolve(__dirname, 'public');
  let rawPath;
  try {
    rawPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const filePath = rawPath === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rawPath));

  // 归一化后必须仍在 public/ 之内，否则一律 403（含 .. 和符号链接逃逸）
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    }[ext] || 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

/**
 * 端口占用时顺延重试。
 *
 * 注意这里**只注册一次** 'listening' 处理器，端口从 server.address() 读。
 * 原来写的是 server.listen(port, host, cb) —— Node 会把 cb 挂成一次性
 * 'listening' 监听器，而绑定失败时它不会被消费；重试三次就积了三个回调，
 * 真正绑上之后**全部一起触发**，于是控制台打印的是最早那个（错的）端口，
 * runtime.json 也被连写三遍。用户照着提示打开 18788，其实服务在 18790。
 */
function listenWithFallback(startPort) {
  let port = startPort;

  server.on('listening', () => {
    const actual = server.address()?.port ?? port;
    console.log(`\n🦞 U-Claw Config Center`);
    console.log(`   http://127.0.0.1:${actual}`);
    console.log(`\n   Config file: ${P().configPath}\n`);

    // 落盘实际端口，供 Config.html / 启动器发现
    let runtimePath = '(unresolved)';
    try {
      runtimePath = P().runtimeJson;
      fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
      const existing = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, 'utf8')) : {};
      existing.configServerPort = actual;
      existing.configServerUpdatedAt = new Date().toISOString();
      fs.writeFileSync(runtimePath, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.warn(`   Warning: could not write ${runtimePath}: ${err.message}`);
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && port < PORT_RANGE_END) {
      console.log(`   Port ${port} busy, trying ${port + 1}…`);
      port += 1;
      setImmediate(() => server.listen(port, '127.0.0.1'));
      return;
    }
    console.error(`Config server failed to bind: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1');
}

/**
 * 启动：先把动作核心加载起来拿到路径，再开始监听。
 * 顺序不能反——路径没就绪时任何请求进来 P() 都会抛。
 */
async function startup() {
  try {
    const core = await loadCore();
    PATHS = core.resolvePaths();
  } catch (err) {
    console.error(`无法加载动作核心 (lib/core)：${err.message}`);
    process.exit(1);
  }
  listenWithFallback(PORT_RANGE_START);
}

startup();
