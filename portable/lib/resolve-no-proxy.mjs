// resolve-no-proxy.mjs — 让"内网/自建模型地址"绕开系统代理
//
// 背景（内网环境最大的坑）：
//   很多公司/机房的机器设置了 HTTP_PROXY / HTTPS_PROXY 环境变量（为了上外网）。
//   OpenClaw 启动时若检测到这两个变量，会 setGlobalDispatcher(new EnvHttpProxyAgent())，
//   于是"所有" fetch——包括调用用户自己填的模型 baseUrl——都被塞进公司代理。
//   当模型部署在内网（如 http://10.x / 192.168.x / 某机房 IP）时，代理够不着那台机器，
//   请求直接失败。表现：互联网能连公网模型、reasonix/copilot 也能连内网，唯独本程序连不上。
//   见 openclaw dist/auth-profiles-*.js 的 ensureGlobalUndiciEnvProxyDispatcher()。
//
// 方案：undici 的 EnvHttpProxyAgent 认 NO_PROXY。把配置里**内网**模型 baseUrl 的主机名
//   + 本机回环地址写进 NO_PROXY，让这些地址"直连不走代理"。
//
// ⚠️ 只放内网主机，公网主机一律不动。
//   早期版本对所有 baseUrl 一视同仁，连 api.deepseek.com / api.openai.com 也塞了进去。
//   但公司机器上 HTTP_PROXY 往往是**唯一出网路径**，公网主机进了 NO_PROXY 就变成强制
//   直连 → 模型彻底连不上，正好是本脚本想解决的问题的反面。内外网判定见 isIntranetHost()。
//
// 设计原则：静默失败。任何一步出错就不输出，启动照常（只是少了这层保护）。
//
// CLI 用法（供 .bat / .command source）：
//   node resolve-no-proxy.mjs <CONFIG_PATH>
// 输出（无代理需要保护时不输出任何内容）：
//   UCLAW_NO_PROXY=localhost,127.0.0.1,::1,15.151.114.142,...

import { readFileSync } from 'node:fs';

// 始终直连的本机地址。
const ALWAYS = ['localhost', '127.0.0.1', '::1'];

// 内网后缀。企业/机房常见的私有域，代理够不着，必须直连。
const INTRANET_SUFFIXES = ['.local', '.localdomain', '.internal', '.intranet', '.lan', '.corp', '.home', '.test'];

/**
 * 判断一个主机名是否属于"内网 / 代理够不着"的范畴。
 *
 * 为什么必须判断：本脚本的目的是让**内网模型**绕开公司代理，但改造前它对所有
 * baseUrl 一视同仁，把 api.deepseek.com / api.openai.com 也塞进了 NO_PROXY。
 * 而公司机器上 HTTP_PROXY 往往是唯一出网路径——公网主机一旦进了 NO_PROXY 就变成
 * 强制直连，模型直接连不上。那正好是本脚本想解决的问题的反面。
 *
 * 判定为内网（→ 进 NO_PROXY）：
 *   - 回环：127.0.0.0/8、::1、localhost
 *   - RFC1918 私网：10/8、172.16/12、192.168/16
 *   - 链路本地：169.254/16、fe80::/10
 *   - CGNAT / Tailscale 等覆盖网：100.64/10
 *   - IPv6 ULA：fc00::/7
 *   - 无点主机名（NetBIOS / 内网短名，如 ai-server）
 *   - 内网后缀域名（.local / .internal / .lan / .corp …）
 * 其余一律视为公网 → 不动，让它照常走代理。
 */
export function isIntranetHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  if (!h) return false;

  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;

  // IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false; // 非法 IP
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT / Tailscale
    return false;                                        // 其余公网 IP
  }

  // IPv6：ULA fc00::/7 与链路本地 fe80::/10
  if (h.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    return false;
  }

  // 无点主机名 = 内网短名（公网域名一定带点）
  if (!h.includes('.')) return true;

  return INTRANET_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

// 从一个 baseUrl 字符串里抽出主机名（IP 或域名）。容错：解析不了就忽略。
function hostOf(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    // 补协议，URL() 才能解析 "host:port/v1" 这种缺协议的写法。
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const host = new URL(withScheme).hostname; // 自动去掉 IPv6 的方括号
    return host || null;
  } catch {
    return null;
  }
}

// 递归收集对象里所有 baseUrl 字段的主机名（providers 可能嵌套/命名各异，宽松收集最稳）。
function collectHosts(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectHosts(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'baseUrl' || key === 'baseURL') {
      const h = hostOf(value);
      if (h) out.add(h);
    } else if (value && typeof value === 'object') {
      collectHosts(value, out);
    }
  }
}

/**
 * 从配置算出该写进 NO_PROXY 的主机列表。
 * 导出以便测试直接断言，不必起子进程。
 */
export function resolveNoProxy(config, env = process.env) {
  const all = new Set();
  collectHosts(config?.models, all);

  // 只放内网主机。公网主机（api.deepseek.com 之类）必须留给代理，
  // 否则公司机器上会因为强制直连而彻底连不上模型。
  const intranet = [...all].filter(isIntranetHost);
  const skipped = [...all].filter((h) => !isIntranetHost(h));

  // 合并已有的 NO_PROXY，避免覆盖用户/系统已有设置。
  const existing = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    merged: Array.from(new Set([...existing, ...ALWAYS, ...intranet])),
    intranet,
    skipped,
    existing,
  };
}

function main() {
  const configPath = process.argv[2] || process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) return;

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return; // 配置不存在/坏了：不输出，启动照常
  }

  const { merged, intranet, skipped, existing } = resolveNoProxy(config);

  // 没有内网主机、也没有已有 NO_PROXY 时不输出：本机回环本就不会被代理误伤，
  // 少写一个环境变量少一份意外。
  if (intranet.length === 0 && existing.length === 0) return;

  // 被跳过的公网主机打到 stderr（stdout 只留给 KEY=VALUE，启动脚本要 for /f 解析）。
  // 出问题时这行能立刻说明"为什么我的公网模型没进 NO_PROXY"——那是**故意**的。
  if (skipped.length) {
    process.stderr.write(`[resolve-no-proxy] 公网主机保持走代理: ${skipped.join(', ')}\n`);
  }

  process.stdout.write(`UCLAW_NO_PROXY=${merged.join(',')}\n`);
}

// 被 import 时不执行 main（测试要直接调用导出函数）
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) main();
