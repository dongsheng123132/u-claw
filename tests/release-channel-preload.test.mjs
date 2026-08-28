// 发布工作流的离线渠道承诺必须可验证：包要装进 staged core，且 zip 前逐个验真。
// 这里不跑 npm / 不联网；只防止维护 workflow 时把 --prefix 漏掉，重新装到 runner 工作区。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');

// 与 release notes 中「离线预装」的 QQ / qqbot / 钉钉 / 飞书中国版 / 企业微信一一对应。
const OFFLINE_CHANNEL_PACKAGES = [
  '@sliverp/qqbot',
  '@openclaw-china/dingtalk',
  '@openclaw-china/feishu-china',
  '@openclaw-china/wecom',
  '@openclaw-china/qqbot',
];

function step(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `缺少 workflow 步骤：${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function packageArrays(text) {
  return [...text.matchAll(/channel_packages=\(\s*([\s\S]*?)\n\s*\)/g)].map((match) =>
    [...match[1].matchAll(/"(@[^"\s]+)"/g)].map((item) => item[1]),
  );
}

test('离线渠道只能用 --prefix 安装到 staged core，失败不得放行', () => {
  const installStep = step('Pre-install Node.js (Windows) and OpenClaw deps');
  const channelInstall = installStep.slice(installStep.indexOf('# 5) Pre-install every channel'));
  const arrays = packageArrays(channelInstall);
  assert.equal(arrays.length, 1, '安装步骤应只有一份明确的离线渠道清单');
  assert.deepEqual(arrays[0], OFFLINE_CHANNEL_PACKAGES);
  assert.match(channelInstall, /npm --prefix "\$core_dir" install "\$\{channel_pkg\}@latest"/);
  assert.doesNotMatch(channelInstall, /(^|\n)\s*npm install\b/m, '渠道包不能回退为工作区裸 npm install');
  assert.doesNotMatch(channelInstall, /channel_pkg[^\n]*(?:\|\|\s*(?:true|echo))/,
    '任何公开承诺的离线渠道装不上都必须失败');
});

test('zip 前逐个核验所有公开承诺包的 staged package.json', () => {
  const gate = step('Verify every promised offline channel is in the staged bundle');
  const arrays = packageArrays(gate);
  assert.equal(arrays.length, 1, '发布闸门应使用一份明确的离线渠道清单');
  assert.deepEqual(arrays[0], OFFLINE_CHANNEL_PACKAGES);
  assert.match(gate, /package_json="\$core_dir\/node_modules\/\$channel_pkg\/package\.json"/);
  assert.match(gate, /\[ ! -f "\$package_json" \]/);
  assert.match(gate, /installed_name=\$\(node -p/);
  assert.match(gate, /\[ "\$installed_name" != "\$channel_pkg" \]/);
  assert.ok(
    workflow.indexOf('- name: Verify every promised offline channel is in the staged bundle')
      < workflow.indexOf('- name: Zip portable bundle'),
    '渠道验证必须发生在 zip 之前',
  );
});

test('release notes 只承诺已验证的渠道，不再声称个人微信预装', () => {
  const release = step('Create or update release');
  for (const label of ['QQ', 'qqbot', '钉钉', '飞书中国版', '企业微信']) {
    assert.ok(release.includes(label), `release notes 应明确承诺 ${label} 离线预装`);
  }
  assert.match(release, /个人微信.*暂不可用/);
  assert.doesNotMatch(release, /个人微信.*(?:离线预装|预装)/);
  assert.doesNotMatch(workflow, /@tencent-weixin\/openclaw-weixin/,
    '已禁用的个人微信不应再被作为发布时预装包下载');
});
