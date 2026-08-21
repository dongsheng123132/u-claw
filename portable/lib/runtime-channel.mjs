// runtime-channel.mjs — 读版本通道
//
// 通道文件把"装哪个 Node、装哪个内核、从哪些镜像装、校验和是多少"集中在
// portable/config/runtime-channel.json 一处。移植自 v2/u-dsh 的 runtime-channel.js。
//
// 一处刻意的偏离：内核版本**不在通道文件里**。
// portable/OPENCLAW_VERSION 已经是它的唯一真相源（CI 的 track-upstream.yml 每天读写它），
// 通道文件再抄一份，早晚有一天两边对不上，而且是那种"看起来都对、跑起来装错版本"的漂移。
// 所以通道里只写 kernel.versionFrom = "OPENCLAW_VERSION"，版本由本模块去读那个文件。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const PORTABLE_DIR = join(LIB_DIR, '..');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;

function fail(message) {
  throw new Error(`[runtime-channel] ${message}`);
}

/**
 * 载入并校验版本通道。
 * @param {object} [options]
 * @param {string} [options.portableDir] 便携根目录，默认为本文件的上一级
 * @param {string} [options.target] 目标平台，默认由调用方从 runtime-paths 传入
 */
export function loadChannel({ portableDir = PORTABLE_DIR, target } = {}) {
  const channelFile = join(portableDir, 'config', 'runtime-channel.json');
  let channel;
  try {
    channel = JSON.parse(readFileSync(channelFile, 'utf8'));
  } catch (error) {
    fail(`读不到版本通道 ${channelFile}：${error?.message || error}`);
  }

  if (channel.schemaVersion !== 1) fail(`不认识的 schemaVersion：${channel.schemaVersion}`);
  if (!EXACT_VERSION.test(channel.node?.version || '')) fail(`node.version 无效：${channel.node?.version}`);

  // 内核版本从 OPENCLAW_VERSION 读，见文件头的说明。
  const versionFrom = channel.kernel?.versionFrom;
  if (versionFrom !== 'OPENCLAW_VERSION') {
    fail(`kernel.versionFrom 只支持 "OPENCLAW_VERSION"，收到：${versionFrom}`);
  }
  const versionFile = join(portableDir, 'OPENCLAW_VERSION');
  let kernelVersion;
  try {
    kernelVersion = readFileSync(versionFile, 'utf8').trim();
  } catch (error) {
    fail(`读不到 ${versionFile}：${error?.message || error}`);
  }
  if (!EXACT_VERSION.test(kernelVersion)) fail(`OPENCLAW_VERSION 内容无效：${kernelVersion}`);

  const nodeTarget = target ? channel.node?.targets?.[target] : undefined;
  if (target && !nodeTarget) {
    fail(`版本通道里没有 ${target} 的 Node 目标，当前只支持：${Object.keys(channel.node?.targets ?? {}).join(', ')}`);
  }

  return {
    schemaVersion: channel.schemaVersion,
    channel: channel.channel ?? 'stable',
    node: {
      version: channel.node.version,
      minimumVersion: channel.node.minimumVersion || '22.12.0',
      mirrors: channel.node.mirrors ?? [],
      target: nodeTarget ?? null,
      targets: channel.node.targets ?? {},
    },
    kernel: {
      package: channel.kernel?.package || 'openclaw',
      version: kernelVersion,
      registry: channel.kernel?.registry || 'https://registry.npmjs.org/',
      installRegistries: channel.kernel?.installRegistries?.length
        ? channel.kernel.installRegistries
        : [channel.kernel?.registry || 'https://registry.npmjs.org/'],
    },
    reuse: {
      allowSystemNode: channel.reuse?.allowSystemNode === true,
      allowForeignKernel: channel.reuse?.allowForeignKernel === true,
    },
    sourceFiles: { channelFile, versionFile },
  };
}

/** 拼某个目标平台的 Node 下载地址（按镜像顺序）。 */
export function nodeDownloadUrls(channel, target) {
  const spec = channel.node.targets?.[target];
  if (!spec) return [];
  return channel.node.mirrors.map(
    (mirror) => `${mirror.replace(/\/$/, '')}/v${channel.node.version}/${spec.archive}`,
  );
}

export { EXACT_VERSION };
