import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFLINE_CHANNEL_PLUGIN_SPECS,
  PluginIntegrityError,
  parsePackageSpec,
  verifyPluginIntegrity,
} from '../portable/lib/plugin-integrity.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'uclaw-plugin-integrity-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function writePlugin(nodeModulesDir, { name, version = '1.2.3', id = name.replace(/[^a-z0-9]+/gi, '-'), entry, main = 'dist/index.js', writeEntry = true }) {
  const dir = join(nodeModulesDir, ...name.split('/'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, main }), 'utf8');
  await writeFile(join(dir, 'openclaw.plugin.json'), JSON.stringify({ id, ...(entry === undefined ? {} : { entry }) }), 'utf8');
  if (writeEntry) await writeFile(join(dir, entry || main), 'export default {};', 'utf8');
}

test('固定离线渠道只保留 openclaw-china 包且全部锁定精确版本', () => {
  assert.deepEqual(OFFLINE_CHANNEL_PLUGIN_SPECS, [
    '@openclaw-china/dingtalk@2026.4.24',
    '@openclaw-china/feishu-china@2026.4.24',
    '@openclaw-china/wecom@2026.4.24',
    '@openclaw-china/qqbot@2026.4.24',
  ]);
  assert.equal(OFFLINE_CHANNEL_PLUGIN_SPECS.some((spec) => spec.includes('@latest') || spec.includes('@sliverp/')), false);
});

test('完整插件组通过 manifest ID 与入口校验，缺 entry 时回落 package main', async () => {
  await withTempDir(async (dir) => {
    const nodeModulesDir = join(dir, 'node_modules');
    await writePlugin(nodeModulesDir, { name: '@example/one', id: 'one', entry: 'dist/plugin.mjs' });
    await writePlugin(nodeModulesDir, { name: '@example/two', id: 'two', entry: undefined, main: 'dist/main.js' });

    const verified = await verifyPluginIntegrity({
      nodeModulesDir,
      packageSpecs: ['@example/one@1.2.3', '@example/two@1.2.3'],
    });
    assert.deepEqual(verified.map((plugin) => [plugin.packageName, plugin.pluginId, plugin.entry]), [
      ['@example/one', 'one', 'dist/plugin.mjs'],
      ['@example/two', 'two', 'dist/main.js'],
    ]);
  });
});

test('缺 manifest、重复 ID、错误入口或版本漂移都会阻断', async () => {
  await withTempDir(async (dir) => {
    const nodeModulesDir = join(dir, 'node_modules');
    await writePlugin(nodeModulesDir, { name: '@example/no-manifest', id: 'no-manifest' });
    await rm(join(nodeModulesDir, '@example', 'no-manifest', 'openclaw.plugin.json'));
    await assert.rejects(
      verifyPluginIntegrity({ nodeModulesDir, packageSpecs: ['@example/no-manifest@1.2.3'] }),
      (error) => error instanceof PluginIntegrityError && /缺少 openclaw\.plugin\.json/.test(error.message),
    );

    await writePlugin(nodeModulesDir, { name: '@example/one', id: 'same', entry: 'dist/index.js' });
    await writePlugin(nodeModulesDir, { name: '@example/two', id: 'same', entry: 'dist/index.js' });
    await assert.rejects(
      verifyPluginIntegrity({ nodeModulesDir, packageSpecs: ['@example/one@1.2.3', '@example/two@1.2.3'] }),
      (error) => error instanceof PluginIntegrityError && /ID 重复/.test(error.message),
    );

    await writePlugin(nodeModulesDir, { name: '@example/two', id: 'two', entry: 'dist/missing.js', writeEntry: false });
    await assert.rejects(
      verifyPluginIntegrity({ nodeModulesDir, packageSpecs: ['@example/two@1.2.3'] }),
      (error) => error instanceof PluginIntegrityError && /入口不存在/.test(error.message),
    );

    await assert.rejects(
      verifyPluginIntegrity({ nodeModulesDir, packageSpecs: ['@example/one@9.9.9'] }),
      (error) => error instanceof PluginIntegrityError && /版本不匹配/.test(error.message),
    );
  });
});

test('包规格解析不接受不完整 scoped 包或额外 @ 段', () => {
  assert.deepEqual(parsePackageSpec('@scope/plugin@1.0.0'), { name: '@scope/plugin', version: '1.0.0' });
  assert.throws(() => parsePackageSpec('@scope@1.0.0'), PluginIntegrityError);
  assert.throws(() => parsePackageSpec('@scope/plugin@1@extra'), PluginIntegrityError);
});
