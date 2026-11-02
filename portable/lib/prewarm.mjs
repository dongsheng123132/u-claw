// prewarm.mjs — gateway 首轮预热（移植自 v2 u-clawx 4.0 的 first-turn-prewarm 思路）
//
// 问题：用户首次点"发送"时，gateway 才去加载配置、解析 provider 鉴权、拉模型列表，
//       慢 U 盘 + 冷启动下这一下要等好几秒。
// 方案：gateway 端口 LISTENING 后，后台静默地把这些"首轮才会触发"的子系统先唤醒一遍：
//       轮询 /ready → 命中后依次 GET /status、/models（带 token），让 config/model
//       缓存在 runtime 内存里热起来。用户真正发第一条消息时就不再等。
//
// 设计原则（与 lib/ 其它脚本一致）：
//   - 纯 Node、零依赖（只用 fetch）
//   - 静默失败：任何错误都不抛、不影响 gateway
//   - 后台 detach 跑（启动脚本用 start /B 或 &），绝不阻塞
//   - 短超时、有上限，不会挂着不退
//
// CLI 用法（启动脚本后台调用）：
//   node prewarm.mjs <PORT> [TOKEN]
//   默认 PORT=18789, TOKEN=uclaw

const READY_TIMEOUT_MS = 90_000;   // 最多等 gateway 就绪 90s（慢 U 盘首启可能要这么久）
const POLL_INTERVAL_MS = 1_000;
const STEP_TIMEOUT_MS = 8_000;

function log(msg) {
  // 写 stderr，不污染可能被采集的 stdout；启动脚本一般 >nul 丢弃
  try { process.stderr.write(`[prewarm] ${msg}\n`); } catch { /* 静默 */ }
}

async function httpGet(url, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token ? { 'x-openclaw-token': token } : {},
    });
    // 读掉 body 让对端真正干完活（否则可能短路）
    await res.text().catch(() => {});
    return res.ok || res.status === 401; // 401 也算"服务在"，说明端口活了
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(base, token, deadline) {
  while (Date.now() < deadline) {
    if (await httpGet(`${base}/ready`, token, 3_000)) return true;
    if (await httpGet(`${base}/healthz`, token, 3_000)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// 冷启动耗时埋点：写进 data/.openclaw/boot-timing.jsonl（见 lib/boot-timing.mjs）。
// 静默失败——埋点永远不能拖慢或拖死预热流程。
async function markBoot(phase) {
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) return;
    const { mark } = await import('./boot-timing.mjs');
    mark(stateDir, phase);
  } catch { /* 埋点失败无所谓 */ }
}

export async function prewarm({ port = 18789, token = 'uclaw' } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;

  const ready = await waitReady(base, token, deadline);
  if (!ready) {
    log(`gateway not ready within ${READY_TIMEOUT_MS}ms, skip`);
    return { ok: false, reason: 'not-ready' };
  }
  await markBoot('gateway-ready');

  // 依次唤醒：status（gateway/config）→ models（provider 鉴权 + 模型目录）
  const steps = ['/status', '/models'];
  const failed = [];
  const started = Date.now();
  for (const path of steps) {
    const t0 = Date.now();
    const ok = await httpGet(`${base}${path}`, token, STEP_TIMEOUT_MS);
    log(`step ${path} ${ok ? 'ok' : 'failed'} ${Date.now() - t0}ms`);
    if (!ok) failed.push(path);
  }
  await markBoot('prewarm-done');
  log(`done ${Date.now() - started}ms failed=${failed.length ? failed.join(',') : 'none'}`);
  return { ok: true, failed };
}

import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  const port = parseInt(process.argv[2], 10) || parseInt(process.env.UCLAW_GATEWAY_PORT, 10) || 18789;
  const token = process.argv[3] || process.env.UCLAW_GATEWAY_TOKEN || 'uclaw';
  prewarm({ port, token })
    .then(() => process.exit(0))
    .catch((err) => { log(`fatal ${err && err.message}`); process.exit(0); });
}
