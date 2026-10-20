#!/usr/bin/env node
// runtime-ports.mjs — U-Claw 端口的单一真相源（读写 data/.openclaw/runtime.json）。
//
// 背景（v2.2.1）：config-server 曾经把 gateway 端口"猜"成 configServerPort + 1
// （18788→18789）。干净机上两者恰好差 1，猜对了；客户机上 18789 一旦被别的程序占用，
// 启动脚本会把 gateway 顺延到 18790，但这个真实端口从没写回 runtime.json —— config-server
// 继续拿猜出来的 18789 去调 secrets reload，打中的是客户机上别家程序，DeepSeek Key 存了
// 跟没存一样。
//
// 本模块把"启动脚本实际选中的端口"发布成唯一真相源，config-server / 前端只读不猜。
//
// 设计原则（照抄 lib/ 里其它助手的惯例）：
//   - 零依赖：只用 node:fs / node:path
//   - 静默失败：读写出错都不能拖垮启动脚本或 config-server
//   - 原子写：tmp 文件 + rename，失败清理残留（与 official-provider-guard.mjs 的 writeAtomic 同一写法）
//   - 读-改-写：publish 只更新自己那个 key，不覆盖另一侧已经写好的端口
//
// CLI 用法：
//   node runtime-ports.mjs publish <stateDir> <gateway|configServer> <port>
//   node runtime-ports.mjs read <stateDir>
//     UCLAW_CONFIG_PORT=<n或空>
//     UCLAW_GATEWAY_PORT=<n或空>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY_BY_ROLE = {
  gateway: 'gatewayPort',
  configServer: 'configServerPort',
};

function runtimePath(stateDir) {
  return path.join(stateDir, 'runtime.json');
}

function readRaw(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(runtimePath(stateDir), 'utf8'));
  } catch {
    return {};
  }
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.runtime-ports-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* 本就不存在或删不掉，随它 */ }
    throw err;
  }
}

/**
 * 发布某一侧（gateway / configServer）的实际监听端口。读-改-写，不覆盖另一侧字段。
 * @param {string} stateDir data/.openclaw 目录
 * @param {'gateway'|'configServer'} role
 * @param {number} port
 * @returns {boolean} 是否成功写入
 */
export function publishPort(stateDir, role, port) {
  const key = KEY_BY_ROLE[role];
  const portNum = Number(port);
  if (!stateDir || !key || !Number.isInteger(portNum) || portNum <= 0) return false;
  try {
    const existing = readRaw(stateDir);
    existing[key] = portNum;
    existing[`${key}UpdatedAt`] = new Date().toISOString();
    writeAtomic(runtimePath(stateDir), JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读出当前已知的两个端口，缺失的字段返回 null。
 * @param {string} stateDir
 * @returns {{configServerPort: number|null, gatewayPort: number|null}}
 */
export function readPorts(stateDir) {
  const raw = stateDir ? readRaw(stateDir) : {};
  const configServerPort = Number.isInteger(raw.configServerPort) ? raw.configServerPort : null;
  const gatewayPort = Number.isInteger(raw.gatewayPort) ? raw.gatewayPort : null;
  return { configServerPort, gatewayPort };
}

function printPorts(ports) {
  process.stdout.write(`UCLAW_CONFIG_PORT=${ports.configServerPort ?? ''}\n`);
  process.stdout.write(`UCLAW_GATEWAY_PORT=${ports.gatewayPort ?? ''}\n`);
}

export function main(argv) {
  const [command, stateDir, roleOrNothing, portText] = argv.slice(2);
  if (command === 'publish') {
    const ok = publishPort(stateDir, roleOrNothing, Number(portText));
    return ok ? 0 : 0; // 静默失败：绝不能因为写不进 runtime.json 就阻断启动
  }
  if (command === 'read') {
    printPorts(readPorts(stateDir));
    return 0;
  }
  return 64;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) process.exitCode = main(process.argv);
