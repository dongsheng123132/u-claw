#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 18788;
const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_TOKEN = 'uclaw';
const CONFIG_PATH = path.join(__dirname, '../data/.openclaw/openclaw.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function isLLMConfigured(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  // New format
  if (cfg.agents?.defaults?.model?.primary) return true;
  // New format for zai / env keys (ex: ZAI_API_KEY)
  if (cfg.env && typeof cfg.env === 'object') {
    const keys = Object.keys(cfg.env);
    if (keys.some(k => k.toUpperCase().includes('API_KEY'))) return true;
  }
  // OpenAI compatible provider
  if (cfg.models?.providers && typeof cfg.models.providers === 'object') {
    if (Object.keys(cfg.models.providers).length > 0) return true;
  }
  // Legacy format
  if (cfg.agent?.model) return true;
  return false;
}

function getToken(cfg) {
  return (cfg?.gateway?.auth?.token) || DEFAULT_TOKEN;
}

function getGatewayPort(reqUrl) {
  const u = new URL(reqUrl, `http://127.0.0.1:${PORT}`);
  const fromQuery = u.searchParams.get('gatewayPort');
  const raw = process.env.GATEWAY_PORT || fromQuery || String(DEFAULT_GATEWAY_PORT);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_GATEWAY_PORT;
}

function serveFile(res, absPath) {
  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(absPath);
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  }[ext] || 'text/plain; charset=utf-8';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(absPath).pipe(res);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = u.pathname;
  const gatewayPort = getGatewayPort(req.url);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Ensure gatewayPort exists in query so the UI can build correct links.
  // (UI reads gatewayPort from `?gatewayPort=...`.)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/config')) {
    if (!u.searchParams.get('gatewayPort')) {
      res.writeHead(302, { Location: `${pathname}?gatewayPort=${gatewayPort}` });
      res.end();
      return;
    }
  }

  // API: Get config
  if (pathname === '/api/config' && req.method === 'GET') {
    const config = readConfig() || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  // API: Save config
  if (pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // API: Compatibility endpoint (some UIs may call it)
  if (pathname === '/api/done' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Routing decision:
  // - "/" : always serve config UI; front-end decides whether to auto-skip to chat
  // - "/config" : always serve config UI for reconfiguration
  if (req.method === 'GET' && (pathname === '/' || pathname === '/config')) {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  // Serve static files from public/ for everything else
  // (also supports direct asset loads used by the config UI)
  const rel = pathname.replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  serveFile(res, abs);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🦞 M-Claw Config Center`);
  console.log(`   http://127.0.0.1:${PORT}`);
  console.log(`\n   Config file: ${CONFIG_PATH}\n`);
});
