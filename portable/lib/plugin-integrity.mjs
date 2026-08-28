// 离线渠道插件的发布完整性契约。
//
// release.yml 和 build-seed.mjs 都从这里取同一份固定版本清单，并在各自的
// staged node_modules 上运行同一校验。不能只确认「npm install 返回 0」：
// 包缺 manifest、ID 冲突，或 manifest 指向不存在的入口时，客户离线拿到的
// 仍是一份看似完整、实际无法加载的插件树。

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OFFLINE_CHANNEL_PLUGIN_SPECS = Object.freeze([
  '@openclaw-china/dingtalk@2026.4.24',
  '@openclaw-china/feishu-china@2026.4.24',
  '@openclaw-china/wecom@2026.4.24',
  '@openclaw-china/qqbot@2026.4.24',
]);

export class PluginIntegrityError extends Error {}

export function parsePackageSpec(spec) {
  const value = String(spec || '').trim();
  const separator = value.startsWith('@') ? value.indexOf('@', 1) : value.indexOf('@');
  const name = separator === -1 ? value : value.slice(0, separator);
  const version = separator === -1 ? '' : value.slice(separator + 1);
  if (!name || version.includes('@') || (name.startsWith('@') && !name.includes('/')) || value !== `${name}${version ? `@${version}` : ''}`) {
    throw new PluginIntegrityError(`非法插件包规格：${value || '(空)'}`);
  }
  return { name, version };
}

function ensureInside(root, candidate, description) {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return candidate;
  throw new PluginIntegrityError(`${description} 越出了插件包目录：${candidate}`);
}

async function readJson(file, description) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new PluginIntegrityError(`${description} 不可读取或不是合法 JSON：${file}（${error.message}）`);
  }
}

function entryCandidates(packageDir, entry) {
  const raw = String(entry || '').trim();
  if (!raw) throw new PluginIntegrityError('插件 manifest.entry / package.json main 为空');
  if (path.isAbsolute(raw) || raw.includes('\0')) throw new PluginIntegrityError(`插件入口必须是包内相对路径：${raw}`);

  const base = ensureInside(packageDir, path.resolve(packageDir, raw), '插件入口');
  return [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
}

function resolveEntry(packageDir, entry, packageName) {
  const found = entryCandidates(packageDir, entry).find((candidate) => {
    try { return existsSync(candidate) && statSync(candidate).isFile(); }
    catch { return false; }
  });
  if (!found) throw new PluginIntegrityError(`${packageName} 的入口不存在：${entry}`);
  return found;
}

/**
 * 验证 node_modules 中的一组 OpenClaw 插件；任一失败直接 reject。
 * packageSpecs 可传 `@scope/name@x.y.z`（同时核对版本）或裸包名。
 */
export async function verifyPluginIntegrity({ nodeModulesDir, packageSpecs }) {
  if (!nodeModulesDir) throw new PluginIntegrityError('缺少 nodeModulesDir');
  if (!Array.isArray(packageSpecs) || packageSpecs.length === 0) {
    throw new PluginIntegrityError('插件完整性校验至少需要一个包');
  }

  const seenIds = new Set();
  const verified = [];
  for (const spec of packageSpecs) {
    const { name, version: expectedVersion } = parsePackageSpec(spec);
    const packageDir = ensureInside(path.resolve(nodeModulesDir), path.resolve(nodeModulesDir, name), '插件包路径');
    const packageJsonPath = path.join(packageDir, 'package.json');
    const manifestPath = path.join(packageDir, 'openclaw.plugin.json');
    if (!existsSync(packageJsonPath)) throw new PluginIntegrityError(`${name} 缺少 package.json：${packageJsonPath}`);
    if (!existsSync(manifestPath)) throw new PluginIntegrityError(`${name} 缺少 openclaw.plugin.json：${manifestPath}`);

    const packageJson = await readJson(packageJsonPath, `${name} package.json`);
    if (packageJson.name !== name) throw new PluginIntegrityError(`${name} 的 package.json name 不匹配：${packageJson.name || '(空)'}`);
    if (expectedVersion && packageJson.version !== expectedVersion) {
      throw new PluginIntegrityError(`${name} 版本不匹配：期望 ${expectedVersion}，实际 ${packageJson.version || '(空)'}`);
    }

    const manifest = await readJson(manifestPath, `${name} openclaw.plugin.json`);
    const pluginId = typeof manifest.id === 'string' ? manifest.id.trim() : '';
    if (!pluginId) throw new PluginIntegrityError(`${name} 的 openclaw.plugin.json 缺少非空 id`);
    if (seenIds.has(pluginId)) throw new PluginIntegrityError(`插件 ID 重复：${pluginId}`);
    seenIds.add(pluginId);

    const entry = typeof manifest.entry === 'string' && manifest.entry.trim()
      ? manifest.entry.trim()
      : packageJson.main;
    const entryPath = resolveEntry(packageDir, entry, name);
    verified.push({ packageName: name, version: packageJson.version, pluginId, entry, entryPath });
  }
  return verified;
}

function printUsageAndExit() {
  process.stderr.write('用法: node plugin-integrity.mjs --print-offline-channel-specs | --node-modules <dir> --offline-channel-plugins\n');
  process.exitCode = 2;
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--print-offline-channel-specs') {
    process.stdout.write(`${OFFLINE_CHANNEL_PLUGIN_SPECS.join('\n')}\n`);
    return;
  }
  if (argv.length === 3 && argv[0] === '--node-modules' && argv[2] === '--offline-channel-plugins') {
    const verified = await verifyPluginIntegrity({ nodeModulesDir: argv[1], packageSpecs: OFFLINE_CHANNEL_PLUGIN_SPECS });
    for (const plugin of verified) process.stdout.write(`OK ${plugin.packageName}@${plugin.version} id=${plugin.pluginId} entry=${plugin.entry}\n`);
    return;
  }
  printUsageAndExit();
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`插件完整性校验失败：${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
