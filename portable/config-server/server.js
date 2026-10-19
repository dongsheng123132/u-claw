#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createHash } = require('crypto');

// config-server 段与 gateway 段（18789-18799，见 Windows-Start.bat / Mac-Start.command）
// 曾经重叠（18788-18798 向上顺延会撞进 gateway 的地盘）。v2.2.1 起改为向下顺延，
// 两段各自独占，谁也不会抢走对方的候选口。
const PORT_RANGE_PREFERRED = 18788;
const PORT_RANGE_FLOOR = 18778;
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(__dirname, '../data');
const OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR || path.join(OPENCLAW_HOME, '.openclaw');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || path.join(OPENCLAW_STATE_DIR, 'openclaw.json');
const OPENCLAW_MJS = path.join(__dirname, '../app/core/node_modules/openclaw/openclaw.mjs');
const CONFIG_PATH = OPENCLAW_CONFIG_PATH;
// PicoClaw (Lite) 数据域：data/picoclaw/（与 .openclaw 分离）。钱包路由统一从这里注入双写目标。
// OPENCLAW_HOME 沙箱隔离（测试/多实例）：env 指哪 picoHome 就落哪，绝不默认写仓库源码 data/。
const PICOCLAW_HOME = path.join(OPENCLAW_HOME, 'picoclaw');
const RUNTIME_PATH = path.join(OPENCLAW_STATE_DIR, 'runtime.json');

// 钱包路由统一注入的依赖：configPath（OpenClaw 消费者落点）、store（钱包状态
// uclaw-device.json 的落点）、picoHome（Lite 消费者落点）。三者全部由 env 推导——
// 测试把 OPENCLAW_HOME / OPENCLAW_STATE_DIR 指进临时目录后，钱包数据域整体落沙箱，
// 绝不默认写仓库源码 data/。walletClient() 只 import 一次（模块级缓存），每次路由
// 调用重新构造 deps（env 不变，成本可忽略）。
let walletClientModule = null;
async function walletClient() {
  if (!walletClientModule) {
    walletClientModule = await import('../lib/wallet-client.mjs');
  }
  return {
    mod: walletClientModule,
    deps: {
      configPath: CONFIG_PATH,
      picoHome: PICOCLAW_HOME,
      store: walletClientModule.createFileWalletStore(path.join(OPENCLAW_STATE_DIR, 'uclaw-device.json')),
    },
  };
}

// OpenClaw 2026.8.1 会把配置文件里的敏感值改写成掩码；模型 Key 只能保存为
// SecretRef，明文仅通过 secrets CLI 的 stdin 进入本机 secret store。
function isMaskedKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,12}\.\.\.[A-Za-z0-9_-]{3,8}$/.test(value);
}

function isSecretRefPlaceholder(value) {
  return value === '（已加密保存，无需重填）';
}

function isSecretRef(value) {
  return value && typeof value === 'object' && value.source === 'store' && typeof value.id === 'string';
}

function secretStoreEnv() {
  return {
    ...process.env,
    OPENCLAW_HOME,
    OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH,
  };
}

function runSecretsStoreSet(name, value) {
  if (!fs.existsSync(OPENCLAW_MJS)) return Promise.resolve({ ok: false, reason: 'cli-missing' });
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [
      OPENCLAW_MJS, 'secrets', 'store', 'set', name, '--kind', 'secret', '--value-file', '-',
    ], {
      env: secretStoreEnv(),
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error) => {
      if (error) {
        resolve({ ok: false, reason: error.killed ? 'timeout' : (error.code || 'store-failed') });
        return;
      }
      resolve({ ok: true });
    });
    // execFile 默认 stdio 为 pipe；Key 只写 stdin，绝不能放到 argv 或日志中。
    child.stdin.on('error', () => {});
    child.stdin.end(value, 'utf8');
  });
}

function secretName(prefix, id) {
  return prefix + String(id).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

class SecretSaveError extends Error {}

async function storeSecretRef(name, value) {
  if (isSecretRefPlaceholder(value)) {
    throw new SecretSaveError('请重新输入 API Key');
  }
  if (isMaskedKey(value)) {
    throw new SecretSaveError('检测到已脱敏的密钥串，请重新输入完整 API Key');
  }
  if (isSecretRef(value) || typeof value !== 'string' || !value) return value;

  const result = await runSecretsStoreSet(name, value);
  if (!result.ok) {
    throw new SecretSaveError('无法安全保存 API Key（' + result.reason + '）');
  }
  return { source: 'store', provider: 'default', id: name };
}

function isSecretEnvName(name) {
  return /(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD)$/i.test(name);
}

async function moveIncomingSecretsToStore(incoming) {
  const providers = incoming && incoming.models && incoming.models.providers;
  if (providers && typeof providers === 'object') {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object' || !Object.prototype.hasOwnProperty.call(provider, 'apiKey')) continue;
      provider.apiKey = await storeSecretRef(secretName('UCLAW_MODEL_', providerId), provider.apiKey);
    }
  }

  if (incoming && incoming.env && typeof incoming.env === 'object') {
    for (const [envName, value] of Object.entries(incoming.env)) {
      if (!isSecretEnvName(envName)) continue;
      incoming.env[envName] = await storeSecretRef(secretName('UCLAW_MODEL_', envName), value);
    }
  }
}

// v2.2.1：不再把 gateway 端口"猜"成 configServerPort + 1。干净机上两者恰好差 1，
// 但客户机上一旦 18789 被别的程序占住，gateway 会顺延到 18790——猜出来的端口
// 打中的是客户机上别家程序，密钥保存后 gateway 永远收不到，前端却显示"保存成功"。
// 三级回退，只认权威来源，找不到就返回 null（让调用方走 CLI 自己发现端口，
// 猜错比不猜更糟）：
//   1) runtime.json 的 gatewayPort —— 启动脚本选定端口后立刻写入的真相源
//   2) launcher-instance.lock/owner.json 的 .port —— 启动器的第二手证据
//   3) 都没有 → null
async function gatewayPortFromRuntime() {
  try {
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    const gatewayPort = Number(runtime.gatewayPort);
    if (Number.isInteger(gatewayPort) && gatewayPort > 0) return gatewayPort;
  } catch (_) { /* runtime.json 缺失/损坏，继续找下一级 */ }

  try {
    const { lockDir, readOwner } = await import('../lib/portable-instance-lock.mjs');
    const owner = readOwner(lockDir(OPENCLAW_STATE_DIR));
    const ownerPort = owner ? Number(owner.port) : NaN;
    if (Number.isInteger(ownerPort) && ownerPort > 0) return ownerPort;
  } catch (_) { /* 锁目录不存在等，继续找下一级 */ }

  return null;
}

function isConnectionError(error, stderr) {
  if (error && (error.killed || error.code === 'ETIMEDOUT')) return true;
  const detail = [error && error.code, error && error.message, stderr].filter(Boolean).join(' ');
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|connect(?:ion)?|gateway.*(?:unreachable|unavailable|not running)|timed?\s*out/i.test(detail);
}

async function runSecretsReload() {
  if (!fs.existsSync(OPENCLAW_MJS)) return Promise.resolve({ reloadError: 'cli-missing' });
  const args = [OPENCLAW_MJS, 'secrets', 'reload', '--json'];
  const gatewayPort = await gatewayPortFromRuntime();
  if (gatewayPort) args.push('--port', String(gatewayPort));
  args.push('--token', 'uclaw', '--timeout', '8000');

  return new Promise((resolve) => {
    execFile(process.execPath, args, {
      env: secretStoreEnv(),
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) return resolve({ mode: 'live' });
      if (isConnectionError(error, stderr)) return resolve({ pendingRestart: true });
      resolve({ reloadError: String((stderr || error.message || error.code || 'reload-failed')).trim().slice(0, 500) });
    });
  });
}

const server = http.createServer((req, res) => {
  // CORS：只允许同源访问（本服务只服务 127.0.0.1 上的配置中心页面）。
  // 旧版 `*` 让任意网页都能跨域读 /api/config（明文 Key）并调用敏感接口——已收紧。
  // loading.html 等 file:// 页面不发带凭据的跨域请求，无需放行 Origin。
  const origin = req.headers.origin || '';
  if (origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: Runtime ports — 前端不再自己盲扫 18789-18799 猜 gateway 端口，改问权威来源。
  // 见 gatewayPortFromRuntime() 的三级回退注释。
  if (req.url === '/api/runtime' && req.method === 'GET') {
    (async () => {
      // runtime.json 损坏（比如两个进程写入时被截断）不该让这个端点整个 500——
      // gatewayPortFromRuntime() 已经对同一份文件做了"解析失败就当没有"的处理，这里的
      // configServerPort 读取也要同样宽容，否则前端连"权威来源暂时不可用"都问不到，
      // 直接连 findGatewayPort() 的第一步都失败，退化回旧的盲扫路径。
      let configServerPort = null;
      try {
        const runtime = fs.existsSync(RUNTIME_PATH) ? JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')) : {};
        configServerPort = Number.isInteger(runtime.configServerPort) ? runtime.configServerPort : null;
      } catch (_) { /* 损坏的 runtime.json：当作没有 configServerPort，继续走 gatewayPort 的三级回退 */ }
      const gatewayPort = await gatewayPortFromRuntime();
      // instanceId：本实例身份指纹 = sha256(path.resolve(OPENCLAW_STATE_DIR))。
      // 与 lib/portable-maintenance.mjs 的 instanceIdOf() 同一算法——维护入口用它
      // 核对"runtime.json 里的端口是不是当前这支 U 盘的 config server"，foreign/stale 不给 URL。
      const instanceId = createHash('sha256').update(path.resolve(OPENCLAW_STATE_DIR)).digest('hex');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ configServerPort, gatewayPort, instanceId }));
    })();
    return;
  }

  // API: Gateway identity check — 代前端做跨端口探活。
  // 浏览器直接 fetch 网关端口是跨源请求，读不到网关是否真发了 CORS 头（打包进 OpenClaw 的
  // cors 中间件默认行为未经验证，贸然假设 res.ok 可读会比原来的 no-cors 盲扫更脆）。这里在
  // Node 侧发请求——Node fetch 不受 CORS 限制。
  //
  // 2026-09-02 实测更正：/ready 是不鉴权的公开健康检查——真实 gateway 对错 token / 无 token /
  // 对 token 一律 200，`x-openclaw-token` 在这条路由上完全不起识别作用（之前的注释和
  // `isOurGateway()` 里"带 token 确认身份"的说法是错的，已用真跑起来的 gateway 验证过）。
  // 光看 HTTP 状态码==2xx 认不出"是不是我们的 gateway"——客户机上随便一个在这个端口监听、
  // 对任何路径都回 200 的东西（很多本地开发服务器、反代默认页都这样）都会被误认。
  // 改成校验 /ready 响应体的形状：真实 OpenClaw 网关固定返回
  // `{ ready: boolean, failing: array, uptimeMs: number, eventLoop: {...} }`——这几个字段
  // 同时出现，比状态码更难被无关服务偶然撞上。仍不是防"蓄意伪造"的安全边界，只是不再被
  // "碰巧占了端口的别家服务"糊弄。
  if (req.url.startsWith('/api/gateway-check') && req.method === 'GET') {
    (async () => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const port = Number(url.searchParams.get('port'));
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad port' }));
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        let ok = false;
        let ready = false;
        try {
          const r = await fetch(`http://127.0.0.1:${port}/ready`, { signal: controller.signal });
          if (r.ok) {
            const body = await r.json();
            ok = typeof body.ready === 'boolean'
              && Array.isArray(body.failing)
              && typeof body.uptimeMs === 'number'
              && body.eventLoop && typeof body.eventLoop === 'object';
            ready = Boolean(ok && body.ready === true && body.failing.length === 0);
          }
        } catch (_) {
          ok = false;
        } finally {
          clearTimeout(timer);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: Boolean(ok), ready }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // API: Get config
  if (req.url === '/api/config' && req.method === 'GET') {
    try {
      const config = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 已退役的更新接口：兼容旧调用方，不读旧清单、不联网；升级走稳定整包发行页。
  if ((req.url === '/api/update-status' && req.method === 'GET')
      || (req.url === '/api/update-check' && req.method === 'POST')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      available: false,
      supported: false,
      releasePageUrl: 'https://github.com/dongsheng123132/u-claw/releases',
    }));
    return;
  }

  // API: Save config
  // 合并写入而非整体覆盖（issue #58）：磁盘上可能有 UI 不认识的字段（最典型是微信登录写入的
  // config.plugins.entries），整体覆盖会把它们静默冲掉。合并 + 原子写逻辑见 lib/merge-config.mjs。
  if (req.url === '/api/provider-models' && req.method === 'POST') {
    // 动态模型发现：带上用户的 Key 去问该平台的 /v1/models，返回实时模型 id 列表。
    // Key 只在本次请求内使用，不落盘、不打日志。
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { provider, base, apiKey } = JSON.parse(body || '{}');
        if (!apiKey) throw new Error('请先填写 API Key 再拉取');
        let target = (base || '').trim();
        if (!target && provider === 'zai') target = 'https://open.bigmodel.cn/api/paas/v4';
        if (!target) throw new Error('该提供商不支持在线拉取，可直接手填模型名');
        // 只放行标准 http(s) 绝对地址；拒绝带凭据/fragment 的怪 URL，防 Key 被导向意外目标
        let u;
        try { u = new URL(target); } catch { throw new Error('API 地址格式不正确'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('仅支持 http(s) 地址');
        if (u.username || u.password || u.hash) throw new Error('API 地址含不支持的部分');
        const url = u.origin + u.pathname.replace(/\/+$/, '') + '/models';
        const headers = { Authorization: 'Bearer ' + apiKey };
        if (/anthropic\.com/.test(u.hostname)) {
          headers['x-api-key'] = apiKey;
          headers['anthropic-version'] = '2023-06-01';
          delete headers.Authorization;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let json;
        try {
          // redirect:'error'：Key 不跟随重定向，防止被 30x 导到第三方
          const r = await fetch(url, { headers, signal: controller.signal, redirect: 'error' });
          if (!r.ok) throw new Error(r.status === 401 ? 'Key 校验失败(401)，检查是否填对' : '平台返回 HTTP ' + r.status);
          json = await r.json();
        } finally { clearTimeout(timer); }
        const seen = new Set();
        const ids = ((json && json.data) || [])
          .map(m => String(m && m.id || ''))
          .filter(id => id && id.length <= 128 && !seen.has(id) && seen.add(id))
          .sort();
        if (!ids.length) throw new Error('平台返回了空列表');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, models: ids.slice(0, 500) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.name === 'AbortError' ? '平台响应超时' : String(err.message || err) }));
      }
    });
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      (async () => {
        try {
          const incoming = JSON.parse(body);
              try {
                await moveIncomingSecretsToStore(incoming);
          } catch (err) {
            if (err instanceof SecretSaveError) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
              return;
            }
                throw err;
              }
              const { readConfigSafe, mergeConfig, writeConfigAtomic } = await import('../lib/merge-config.mjs');
          // 配置中心只提交选中的 provider；保留钱包条目，但主模型仍以请求为准。
          // 补回的磁盘条目不经 moveIncomingSecretsToStore；请求点名时则以请求为准。
          // preserveAdvanced：保存模型时保留原生高级设置（agents.list/defaults.workspace、
          // gateway.auth/remote 未知子字段、commands 未知项、未提交的 meta/env 等），
          // 只更新请求明确带的字段；钱包 removeKey 不走本选项，默认删除语义不变。
          const { CLOUD_PROVIDER_ID } = await import('../lib/wallet-client.mjs');
          const merged = mergeConfig(readConfigSafe(CONFIG_PATH), incoming, {
            keepProviders: [CLOUD_PROVIDER_ID],
            preserveAdvanced: true,
          });
          try {
            const { guardOfficialProvidersInMemory } = await import('../lib/official-provider-guard.mjs');
            guardOfficialProvidersInMemory(merged, {
              stateDir: path.dirname(CONFIG_PATH),
              quarantinePath: path.join(path.dirname(CONFIG_PATH), 'uclaw-provider-guard-quarantine.json'),
            });
          } catch (guardErr) {
            // Provider guard is advisory: never make a user config save fail.
            console.error('[provider-guard] save-path guard failed:', guardErr && guardErr.message);
          }
          writeConfigAtomic(CONFIG_PATH, merged);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...await runSecretsReload() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      })();
    });
    return;
  }

  // ── 内核模式切换（Lite/Full） ───────────────────────────────────────────────
  // 只决定启动器下次起哪个内核（lite=秒开 PicoClaw CLI；openclaw=完整网关）。
  // **与钱包解耦**：绝不被钱包逻辑读取，钱包 applyKey/removeKey 无条件双写两核。
  // 写完返回 restartRequired:true，由前端提示用户重启生效——本路由不杀进程、不自动重启。

  // API: 读当前内核模式（读失败按默认 lite，不抛）
  if (req.url === '/api/core-mode' && req.method === 'GET') {
    (async () => {
      try {
        const { readCoreMode } = await import('../lib/core-mode.mjs');
        const mode = readCoreMode(OPENCLAW_STATE_DIR);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode, liteSupported: process.platform === 'win32' && process.arch === 'x64', runningMode: process.env.UCLAW_RUNNING_CORE === 'lite' ? 'lite' : process.env.UCLAW_RUNNING_CORE === 'openclaw' ? 'openclaw' : null }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message, mode: 'lite' }));
      }
    })();
    return;
  }

  // API: 写内核模式（只收两个枚举值，非法直接拒）
  if (req.url === '/api/core-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      (async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const { isValidCoreMode, writeCoreMode, CORE_MODE_LITE, CORE_MODE_OPENCLAW } = await import('../lib/core-mode.mjs');
          const mode = data && data.mode;
          if (mode !== CORE_MODE_LITE && mode !== CORE_MODE_OPENCLAW) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `core-mode 只能是 "lite" 或 "openclaw"，收到: ${JSON.stringify(mode)}` }));
            return;
          }
          writeCoreMode(OPENCLAW_STATE_DIR, mode);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode, restartRequired: true }));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      })();
    });
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
        const { mod, deps } = await walletClient();
        const result = await mod.getStatus(deps);
        if (result.hasWallet && result.apiKey) {
          result.rechargeUrl = mod.payBaseUrl() + '/recharge?key=' + encodeURIComponent(result.apiKey);
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
        const { mod, deps } = await walletClient();
        const result = await mod.claimWallet(deps);
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
        const { mod, deps } = await walletClient();
        const result = await mod.getBalance(deps);
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
        const { mod, deps } = await walletClient();
        const result = await mod.rotateWallet(deps);
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
          const { mod, deps } = await walletClient();
          const result = await mod.adoptWallet(data.key, deps);
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
        const { mod, deps } = await walletClient();
        const result = await mod.resetLocalWallet(deps);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  // Serve static files. 保留原始路径的 ..，不能先让 URL 解析器消掉它再检查边界。
  let requestPath;
  try {
    if (!req.url.startsWith('/') || req.url.startsWith('//')
        || /[#\x00-\x20\x7f]/.test(req.url) || /%(?![0-9a-f]{2})/i.test(req.url)) {
      throw new Error('bad URL');
    }
    requestPath = decodeURIComponent(req.url.split('?')[0]);
    if (requestPath.includes('\0')) throw new Error('bad path');
  } catch (_) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const publicDir = path.resolve(__dirname, 'public');
  const filePath = requestPath === '/startup'
    ? path.resolve(__dirname, '../lib/loading.html')
    : path.resolve(publicDir, '.' + (requestPath === '/' ? '/index.html' : requestPath.replace(/\\/g, '/')));
  if (requestPath !== '/startup' && !filePath.startsWith(publicDir + path.sep)) {
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

function listenWithFallback(port) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && port > PORT_RANGE_FLOOR) {
      console.log(`   Port ${port} busy, trying ${port - 1}…`);
      setImmediate(() => listenWithFallback(port - 1));
      return;
    }
    console.error(`Config server failed to bind: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    // Windows 双绑怪癖：本进程 bind 已被占的端口时，成功回调会先打出来，
    // EADDRINUSE 错误随后才异步到达（实测 2026-08-31，两把U盘同插时复现）。
    // 横幅/runtime.json 只在「错误没有到达」之后才算数。
    setTimeout(() => {
      if (server.listening !== true) return;
      console.log(`\n🦞 U-Claw Config Center`);
      console.log(`   http://127.0.0.1:${port}`);
      console.log(`\n   Config file: ${CONFIG_PATH}\n`);
      // Persist the live port so the desktop shell / launchers can discover it after restarts.
      try {
        fs.mkdirSync(path.dirname(RUNTIME_PATH), { recursive: true });
        const existing = fs.existsSync(RUNTIME_PATH) ? JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8')) : {};
        existing.configServerPort = port;
        existing.configServerUpdatedAt = new Date().toISOString();
        fs.writeFileSync(RUNTIME_PATH, JSON.stringify(existing, null, 2));
      } catch (err) {
        console.warn(`   Warning: could not write ${RUNTIME_PATH}: ${err.message}`);
      }
    }, 250);
  });
}

// 测试/多实例隔离口：允许调用方指定起始端口（如 tests 传 18901，避开 18778-18788 产品段）。
listenWithFallback(Number(process.env.UCLAW_CONFIG_PORT) || PORT_RANGE_PREFERRED);
