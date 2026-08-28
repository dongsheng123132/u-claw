// 发布工作流的离线渠道承诺必须可验证：包要装进 staged core，且 zip 前逐个验真。
// 这里不跑 npm / 不联网；只防止维护 workflow 时把 --prefix 漏掉，重新装到 runner 工作区。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OFFLINE_CHANNEL_PLUGIN_SPECS } from '../portable/lib/plugin-integrity.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
const seedBuilder = readFileSync(join(REPO, 'portable', 'scripts', 'build-seed.mjs'), 'utf8');

function step(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `缺少 workflow 步骤：${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test('离线渠道只能用 --prefix 安装到 staged core，失败不得放行', () => {
  const installStep = step('Pre-install Node.js (Windows) and OpenClaw deps');
  const channelInstall = installStep.slice(installStep.indexOf('# 5) Pre-install every channel'));
  assert.deepEqual(OFFLINE_CHANNEL_PLUGIN_SPECS, [
    '@openclaw-china/dingtalk@2026.4.24',
    '@openclaw-china/feishu-china@2026.4.24',
    '@openclaw-china/wecom@2026.4.24',
    '@openclaw-china/qqbot@2026.4.24',
  ]);
  assert.match(channelInstall, /plugin-integrity\.mjs" --print-offline-channel-specs/);
  assert.match(channelInstall, /npm --prefix "\$core_dir" install "\$channel_spec"/);
  assert.doesNotMatch(channelInstall, /(^|\n)\s*npm install\b/m, '渠道包不能回退为工作区裸 npm install');
  assert.doesNotMatch(channelInstall, /channel_spec[^\n]*(?:\|\|\s*(?:true|echo))/,
    '任何公开承诺的离线渠道装不上都必须失败');
  assert.doesNotMatch(channelInstall, /@sliverp\/qqbot|@latest/);
});

test('zip 前复用完整性校验器逐个核验 staged 插件', () => {
  const gate = step('Verify every promised offline channel is in the staged bundle');
  assert.match(gate, /plugin-integrity\.mjs"/);
  assert.match(gate, /--node-modules "\$core_dir\/node_modules"/);
  assert.match(gate, /--offline-channel-plugins/);
  assert.ok(
    workflow.indexOf('- name: Verify every promised offline channel is in the staged bundle')
      < workflow.indexOf('- name: Zip portable bundle'),
    '渠道验证必须发生在 zip 之前',
  );
});

test('release notes 只承诺已验证的渠道，不再声称个人微信或已移除 QQ 包', () => {
  const release = step('Create or update release');
  for (const label of ['QQBot', '钉钉', '飞书中国版', '企业微信']) {
    assert.ok(release.includes(label), `release notes 应明确承诺 ${label} 离线预装`);
  }
  assert.doesNotMatch(release, /个人微信|@sliverp\/qqbot/);
  assert.doesNotMatch(workflow, /@sliverp\/qqbot|@tencent-weixin\/openclaw-weixin/);
});

test('build-seed 复用固定清单和完整性校验，渠道安装失败必须终止', () => {
  assert.match(seedBuilder, /import \{ OFFLINE_CHANNEL_PLUGIN_SPECS, verifyPluginIntegrity \} from '\.\.\/lib\/plugin-integrity\.mjs';/);
  assert.match(seedBuilder, /const CHANNEL_PLUGINS = OFFLINE_CHANNEL_PLUGIN_SPECS;/);
  assert.match(seedBuilder, /'install', spec,/);
  assert.match(seedBuilder, /await verifyPluginIntegrity\(\{[\s\S]*nodeModulesDir: path\.join\(staging, 'node_modules'\),[\s\S]*packageSpecs: CHANNEL_PLUGINS,/);
  assert.doesNotMatch(seedBuilder, /'install',\s*`\$\{(?:pkg|spec)\}@latest`|@sliverp\/qqbot|pluginsFailed|安装失败（跳过/);
});
