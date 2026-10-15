import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...path) => readFileSync(join(repoRoot, ...path), 'utf8');

test('上游跟踪按 git tag 版本序计算并安全跳过撞车版本', () => {
  const workflow = read('.github', 'workflows', 'track-upstream.yml');

  assert.match(workflow, /git fetch --tags --force/, '必须完整拉取 tag 后再计算版本');
  assert.match(workflow, /--sort=-v:refname/, '必须按版本序而非字典序选择最新 tag');
  assert.match(workflow, /already exists/, '目标 tag 已存在时必须安静跳过');
});

// vendor patch 的 bundle 锚定是跨文件不变量：patch 脚本定义 BUNDLE 名，
// release.yml（发版闸门）与 portable/setup.sh（Mac 安装路径）都必须引用同一个文件。
// 用「从 patch 脚本抽出」而不是硬编码，上游换 hash 后这里自动跟红，不用靠人记。
function extractBundles(patchSource) {
  const bundles = new Set();
  // BUNDLE 常量（patch2，2026.9.1 起指向 @openclaw/fs-safe 包内）与 bundlePath 字面量（patch1）
  for (const m of patchSource.matchAll(/(?:BUNDLE = 'node_modules\/(?:@openclaw\/fs-safe\/dist\/|openclaw\/dist\/)|openclaw\/dist\/)([A-Za-z][A-Za-z0-9._-]*\.(?:mjs|js))'/g)) {
    bundles.add(m[1]);
  }
  return bundles;
}

test('vendor patch 锚定的 bundle 在 release.yml 与 setup.sh 三处一致（跨文件不变量）', () => {
  const browserPatch = read('portable', 'lib', 'patch-managed-browser-root.mjs');
  const pairingPatch = read('portable', 'lib', 'patch-device-pairing-retry.mjs');
  const filesystemPatch = read('portable', 'lib', 'patch-portable-filesystem.mjs');
  const release = read('.github', 'workflows', 'release.yml');
  const setupSh = read('portable', 'setup.sh');
  const setupPs = read('portable', 'setup.ps1');

  const bundles = new Set([...extractBundles(browserPatch), ...extractBundles(pairingPatch), ...extractBundles(filesystemPatch)]);
  assert.ok(bundles.size >= 4, `应从 patch 脚本抽到至少 4 个 bundle 名，实际: ${[...bundles]}`);

  for (const bundle of bundles) {
    assert.ok(release.includes(bundle), `release.yml 缺少 patch 锚定的 bundle: ${bundle}`);
    assert.ok(setupSh.includes(bundle), `portable/setup.sh 缺少 patch 锚定的 bundle: ${bundle}`);
    assert.ok(setupPs.includes(bundle), `portable/setup.ps1 缺少 patch 锚定的 bundle: ${bundle}`);
  }

  // 全仓三个关键文件不得残留任何其他 chrome-*/replace-file-* bundle 硬编码
  const pattern = /(chrome|replace-file)-[A-Za-z0-9_-]{8}\.(?:mjs|js)/g;
  for (const [name, text] of [['release.yml', release], ['setup.sh', setupSh], ['setup.ps1', setupPs], ['patch1', browserPatch], ['patch2', pairingPatch]]) {
    for (const m of text.matchAll(pattern)) {
      assert.ok(bundles.has(m[0]), `${name} 残留未锚定的 bundle 名: ${m[0]}`);
    }
  }
});

test('vendor patch 与 OpenClaw pin 版本一致', () => {
  const pin = read('OPENCLAW_VERSION').trim();
  const browserPatch = read('portable', 'lib', 'patch-managed-browser-root.mjs');
  const pairingPatch = read('portable', 'lib', 'patch-device-pairing-retry.mjs');
  assert.match(browserPatch, new RegExp(`EXPECTED_VERSION = '${pin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`),
    'patch1 锚定版本必须与 OPENCLAW_VERSION 一致');
  assert.match(pairingPatch, new RegExp(`EXPECTED_VERSION = '${pin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`),
    'patch2 锚定版本必须与 OPENCLAW_VERSION 一致');
  const uiPatch = read('portable', 'lib', 'patch-control-ui-channels.mjs');
  assert.ok(uiPatch.includes(`EXPECTED_VERSION = '${pin}'`), 'UI patch 锚定版本必须与 OPENCLAW_VERSION 一致');
  const filesystemPatch = read('portable', 'lib', 'patch-portable-filesystem.mjs');
  assert.ok(filesystemPatch.includes(`EXPECTED_VERSION = '${pin}'`), 'filesystem patch 锚定版本必须与 OPENCLAW_VERSION 一致');
});

test('filesystem patch is mandatory after UI patch on every install path and before an upstream bump', () => {
  const helper = 'patch-portable-filesystem.mjs';
  for (const file of ['portable/setup.sh', 'portable/setup.ps1', '.github/workflows/release.yml']) {
    const source = read(file);
    assert.ok(source.indexOf(helper) > source.indexOf('patch-control-ui-channels.mjs'), `${file}: filesystem patch must run after UI patch`);
  }
  const powershell = read('portable/setup.ps1');
  assert.match(powershell, /patch-portable-filesystem\.mjs"\) \$coreDir\s+if \(\$LASTEXITCODE -ne 0\)/, 'Windows must fail when the helper is missing or rejects the vendor input');
  const tracker = read('.github/workflows/track-upstream.yml');
  assert.ok(tracker.includes(`portable/lib/${helper}; do`), 'automatic updates must review the filesystem patch version');
});
