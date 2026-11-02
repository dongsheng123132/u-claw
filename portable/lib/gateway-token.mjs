// gateway-token.mjs — 便携版 gateway 访问 token 的生成 / 迁移 / 读取，以及 gateway
// 网络暴露面的显式收敛（loopback + tailscale off）。
//
// 背景（P1 安全项）：
//   便携版过去把 gateway.auth.token 写死成 "uclaw"，也从不显式声明 gateway.bind /
//   gateway.tailscale。任何知道默认值的人（默认值是公开的），只要 gateway 监听的端口
//   对局域网/公网可达，就能直接用固定 token 接管对话；tailscale 的开或关则完全依赖
//   上游的默认行为，便携版不该把安全边界交给"碰巧是关的"。
//
// 本模块职责（全部静默失败语义——绝不把异常抛回启动脚本）：
//   1) ensureGatewayToken(stateDir)：解析唯一真相 token（token 文件优先），必要时生成
//      32 字节随机 hex → stateDir/gateway-token（POSIX 上 0600），并把 token 写回
//      stateDir/openclaw.json 的 gateway.auth.token（gateway.auth.mode 保持 'token'）；
//      同时把 gateway.bind / gateway.tailscale 显式化（见 normalizeGatewayBinding）。
//      旧版固定值 "uclaw" 视为"未升级"：自动换成随机值，写前把旧配置尽力备份成
//      openclaw.json.bak-gateway-token。用户自己设置过的非 uclaw token 视为显式选择，
//      不轮换（只补落 token 文件）。
//   2) readGatewayToken(stateDir)：token 文件优先 → openclaw.json 兜底 → null，绝不抛。
//   3) normalizeGatewayBinding(config)：纯函数，返回新配置，不改入参。
//
// 原子写盘沿用 lib/merge-config.mjs 的既有约定：同目录临时文件 + rename（同文件系统内
// 原子），写前尽力备份；备份/权限失败都不阻断主流程。
//
// Windows 注意：0600 在 Win32 上没有 POSIX 语义，chmod 会失败/被忽略——这里统一用
// try/catch 包住，权限位只作为 POSIX 上的尽力加固，不是硬依赖。
//
// 零依赖：只用 node: 内置模块。调试 CLI（供启动脚本接线）：
//   node lib/gateway-token.mjs <stateDir>
//   → UCLAW_GATEWAY_TOKEN=<token>
//     UCLAW_GATEWAY_TOKEN_SOURCE=created|migrated|existing
//     UCLAW_GATEWAY_TOKEN_CHANGED=0|1

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** token 文件名（放在 OPENCLAW_STATE_DIR 下）。 */
export const GATEWAY_TOKEN_FILE = 'gateway-token';
/** OpenClaw 配置文件名。 */
export const OPENCLAW_CONFIG_FILE = 'openclaw.json';
/** 迁移 token 前的配置备份文件名。 */
export const GATEWAY_TOKEN_BACKUP = 'openclaw.json.bak-gateway-token';
/** 旧版所有便携版共用的固定 token——命中即视为"未升级"，必须换随机值。 */
export const LEGACY_GATEWAY_TOKEN = 'uclaw';

const TOKEN_BYTES = 32;
const TOKEN_MAX_LENGTH = 4096;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stateDirOf(stateDir) {
  if (typeof stateDir !== 'string') return null;
  const trimmed = stateDir.trim();
  if (!trimmed) return null;
  try {
    return path.resolve(trimmed);
  } catch {
    return null;
  }
}

/** 合法 token：非空、无内部空白/控制字符（要能安全进 shell、URL fragment）。 */
function usableToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token || token.length > TOKEN_MAX_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

function readTokenFile(dir) {
  try {
    return usableToken(fs.readFileSync(path.join(dir, GATEWAY_TOKEN_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 读 openclaw.json 的"快照"：
 *   { exists, ok, config, configPath }
 * exists=false  → 文件不存在（首次启动，可以放心新建）
 * exists=true, ok=false → 文件存在但损坏/不可读（绝不能覆盖，用户数据优先）
 */
function readConfigSnapshot(dir) {
  const configPath = path.join(dir, OPENCLAW_CONFIG_FILE);
  let exists = false;
  try {
    exists = fs.existsSync(configPath);
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, ok: false, config: null, configPath };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!isPlainObject(parsed)) return { exists: true, ok: false, config: null, configPath };
    return { exists: true, ok: true, config: parsed, configPath };
  } catch {
    return { exists: true, ok: false, config: null, configPath };
  }
}

function tokenFromConfig(config) {
  if (!isPlainObject(config) || !isPlainObject(config.gateway) || !isPlainObject(config.gateway.auth)) {
    return null;
  }
  return usableToken(config.gateway.auth.token);
}

function cloneConfig(config) {
  try {
    return structuredClone(config);
  } catch {
    try {
      return JSON.parse(JSON.stringify(config));
    } catch {
      return {};
    }
  }
}

/** 返回带 gateway.auth.token 的新配置（不改入参）。 */
function withGatewayToken(config, token) {
  const next = cloneConfig(isPlainObject(config) ? config : {});
  if (!isPlainObject(next.gateway)) next.gateway = {};
  if (!isPlainObject(next.gateway.auth)) next.gateway.auth = {};
  next.gateway.auth.mode = 'token';
  next.gateway.auth.token = token;
  return next;
}

function sameConfig(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 原子写 openclaw.json：写同目录临时文件 → rename 覆盖。
 * 写前尽力把旧文件备份成 openclaw.json.bak-gateway-token（失败不阻断）。
 * 返回是否真的写成功；任何异常都吞掉（启动脚本不能被磁盘问题打断）。
 */
function writeConfigAtomic(configPath, config) {
  const dir = path.dirname(configPath);
  let tmpPath = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(dir, GATEWAY_TOKEN_BACKUP));
    } catch {
      // 备份是锦上添花，不是硬依赖。
    }
    tmpPath = path.join(
      dir,
      `.${path.basename(configPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch {
    try {
      if (tmpPath) fs.rmSync(tmpPath, { force: true });
    } catch {
      // 清理失败也无所谓：下次启动写盘不会复用这个随机名字。
    }
    return false;
  }
}

/**
 * 原子写 token 文件：写临时文件（0600）→ rename。
 * POSIX 上再 chmod 一次兜底；Windows 上 chmod 语义不同，失败直接忽略。
 */
function writeTokenFile(dir, token) {
  const tokenPath = path.join(dir, GATEWAY_TOKEN_FILE);
  let tmpPath = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    tmpPath = path.join(
      dir,
      `.${GATEWAY_TOKEN_FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    );
    fs.writeFileSync(tmpPath, token, { mode: 0o600 });
    fs.renameSync(tmpPath, tokenPath);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tokenPath, 0o600);
      } catch {
        // 某些文件系统（FAT/exFAT、网络盘）不支持 chmod：不是硬依赖。
      }
    }
    return true;
  } catch {
    try {
      if (tmpPath) fs.rmSync(tmpPath, { force: true });
    } catch {
      // 同上，清理失败不影响启动。
    }
    return false;
  }
}

/** 写完后以磁盘真实状态为准：配置里的 token 是 gateway 真正会用的那个。 */
function persistedToken(dir) {
  const snapshot = readConfigSnapshot(dir);
  const fromConfig = snapshot.ok ? tokenFromConfig(snapshot.config) : null;
  if (fromConfig) return fromConfig;
  return readTokenFile(dir);
}

/**
 * 确保 stateDir 下有一份可用 gateway token，并把 openclaw.json 的 gateway.auth / bind /
 * tailscale 收敛到安全默认值。永远不抛（磁盘不可写 / JSON 损坏时返回原值或 null）。
 *
 * @param {string} stateDir OPENCLAW_STATE_DIR（如 U 盘 portable/data/.openclaw）
 * @returns {{ token: string|null, changed: boolean, source: 'created'|'migrated'|'existing' }}
 *   token   最终可用的 token（以磁盘真实状态为准；彻底写不进去时为 null）
 *   changed 本次是否真的写动了 token 文件或 openclaw.json
 *   source  created  = 新生成了随机 token
 *           migrated = 发现旧版固定值 "uclaw"（配置或 token 文件里），已替换；
 *                      随机升级时写前会留 openclaw.json.bak-gateway-token
 *           existing = token 本来就存在（文件或配置），只做同步/补齐
 */
export function ensureGatewayToken(stateDir) {
  const failed = { token: null, changed: false, source: 'existing' };
  const dir = stateDirOf(stateDir);
  if (!dir) return failed;

  try {
    const fileToken = readTokenFile(dir);
    const snapshot = readConfigSnapshot(dir);
    const configToken = snapshot.ok ? tokenFromConfig(snapshot.config) : null;

    const fileTokenUsable = fileToken && fileToken !== LEGACY_GATEWAY_TOKEN ? fileToken : null;
    const configTokenUsable = configToken && configToken !== LEGACY_GATEWAY_TOKEN ? configToken : null;
    const sawLegacy = fileToken === LEGACY_GATEWAY_TOKEN || configToken === LEGACY_GATEWAY_TOKEN;

    let token;
    let source;
    let changed = false;

    if (fileTokenUsable) {
      // token 文件是唯一真相源，配置只是投影。
      token = fileTokenUsable;
      source = configToken === LEGACY_GATEWAY_TOKEN ? 'migrated' : 'existing';
    } else if (configTokenUsable) {
      // 老盘上用户手工设过 token：尊重它，只补落 token 文件（不轮换用户凭据）。
      // token 文件缺失、或文件里还是旧版 "uclaw" 时都走这里。
      token = configTokenUsable;
      source = fileToken === LEGACY_GATEWAY_TOKEN ? 'migrated' : 'existing';
      changed = writeTokenFile(dir, token) || changed;
    } else {
      // 首次启动，或 token 文件 / 配置里还是旧版固定值 "uclaw"。
      token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
      source = sawLegacy ? 'migrated' : 'created';
      changed = writeTokenFile(dir, token) || changed;
    }

    if (snapshot.ok) {
      const desiredConfig = normalizeGatewayBinding(withGatewayToken(snapshot.config, token));
      if (!sameConfig(snapshot.config, desiredConfig)) {
        changed = writeConfigAtomic(snapshot.configPath, desiredConfig) || changed;
      }
    } else if (!snapshot.exists) {
      // 首次启动且配置还没种子化：建一份最小可用配置（启动脚本通常已先拷 default-config，
      // 这里只是兜底，保证 gateway 拿到 token 而不是自己生成 runtime token）。
      const desiredConfig = normalizeGatewayBinding(withGatewayToken({ gateway: { mode: 'local' } }, token));
      changed = writeConfigAtomic(snapshot.configPath, desiredConfig) || changed;
    }
    // snapshot.exists && !snapshot.ok：JSON 已损坏——宁可不改，也不吞用户配置。

    const tokenOnDisk = persistedToken(dir);
    if (!tokenOnDisk) {
      // 磁盘彻底写不进去：返回 null，让启动脚本继续用默认流程，绝不假装成功。
      return { token: null, changed: false, source: 'existing' };
    }
    return { token: tokenOnDisk, changed, source };
  } catch {
    return failed;
  }
}

/**
 * 读当前 gateway token：token 文件优先，坏了退回 openclaw.json，再坏返回 null。
 * 供 config-server / 启动脚本 / 诊断工具使用。绝不抛。
 *
 * @param {string} stateDir OPENCLAW_STATE_DIR
 * @returns {string|null}
 */
export function readGatewayToken(stateDir) {
  const dir = stateDirOf(stateDir);
  if (!dir) return null;
  try {
    const fileToken = readTokenFile(dir);
    if (fileToken) return fileToken;
    const snapshot = readConfigSnapshot(dir);
    if (snapshot.ok) return tokenFromConfig(snapshot.config);
    return null;
  } catch {
    return null;
  }
}

/**
 * 显式化 gateway 的网络暴露面，返回新配置（不改入参）：
 *   - gateway.bind 缺省（undefined/null/空串）→ "loopback"；用户显式设置的值不覆盖。
 *   - gateway.tailscale 缺省 → { mode: "off" }；已有对象只补缺失的 mode。
 *     `resetOnExit` 在 OpenClaw 2026.10.9 已被上游废弃（config validate 直接报
 *     "Unrecognized key" 并让 gateway 以 78 退出），这里额外把它从存量配置里剔除，
 *     免得 v2.4.0/v2.4.1 写坏的盘继续起不来。
 *
 * @param {object} config openclaw.json 解析后的对象
 * @returns {object} 新配置（入参无效时返回 {}）
 */
export function normalizeGatewayBinding(config) {
  const next = isPlainObject(config) ? cloneConfig(config) : {};
  if (!isPlainObject(next.gateway)) next.gateway = {};
  const gateway = next.gateway;

  // 只把"缺省"解释成 loopback；显式写了 lan / 0.0.0.0 / 具体地址的一律尊重。
  if (gateway.bind === undefined || gateway.bind === null || gateway.bind === '') {
    gateway.bind = 'loopback';
  }

  if (!isPlainObject(gateway.tailscale)) {
    // 只写上游 2026.10.9 认识的键：resetOnExit 已废弃，写进去 gateway 会 exit 78。
    gateway.tailscale = { mode: 'off' };
  } else {
    const tailscale = gateway.tailscale;
    if (tailscale.mode === undefined || tailscale.mode === null || tailscale.mode === '') {
      tailscale.mode = 'off';
    }
    // 存量盘兼容：v2.4.0/v2.4.1 曾写入 retired 的 resetOnExit，必须剔除。
    if (Object.prototype.hasOwnProperty.call(tailscale, 'resetOnExit')) delete tailscale.resetOnExit;
  }

  return next;
}

// ── 供启动脚本使用的调试 CLI（静默失败：永远 exit 0，不阻塞启动） ─────────────
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  try {
    const defaultStateDir = process.env.OPENCLAW_STATE_DIR
      || path.join(path.dirname(thisFile), '..', 'data', '.openclaw');
    const result = ensureGatewayToken(process.argv[2] || defaultStateDir);
    process.stdout.write(`UCLAW_GATEWAY_TOKEN=${result.token || ''}\n`);
    process.stdout.write(`UCLAW_GATEWAY_TOKEN_SOURCE=${result.source}\n`);
    process.stdout.write(`UCLAW_GATEWAY_TOKEN_CHANGED=${result.changed ? '1' : '0'}\n`);
  } catch {
    process.stdout.write('UCLAW_GATEWAY_TOKEN=\n');
    process.stdout.write('UCLAW_GATEWAY_TOKEN_SOURCE=existing\n');
    process.stdout.write('UCLAW_GATEWAY_TOKEN_CHANGED=0\n');
  }
}
