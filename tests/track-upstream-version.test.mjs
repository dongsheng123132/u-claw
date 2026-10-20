import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...path) => readFileSync(join(repoRoot, ...path), 'utf8');

test('upstream discovery cannot publish unvalidated runtimes', () => {
  const workflow = read('.github', 'workflows', 'track-upstream.yml');
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /git push|git tag|git commit/);
  const release = read('.github', 'workflows', 'release.yml');
  assert.match(release, /runs-on: windows-latest/);
  assert.match(release, /--draft/);
  assert.match(release, /Refusing to overwrite a published release/);
});

// vendor patch 的 bundle 锚定是跨文件不变量：patch 脚本定义 BUNDLE 名，
// release.yml（发版闸门）与 portable/setup.sh（Mac 安装路径）都必须引用同一个文件。
// 用「从 patch 脚本抽出」而不是硬编码，上游换 hash 后这里自动跟红，不用靠人记。
function extractBundles(patchSource) {
  const bundles = new Set();
  // BUNDLE 常量（patch2，2026.9.1 起指向 @openclaw/fs-safe 包内）与 bundlePath 字面量（patch1）
  for (const m of patchSource.matchAll(/(?:BUNDLE = 'node_modules\/(?:@openclaw\/fs-safe\/dist\/|openclaw\/dist\/)|openclaw\/dist\/)([A-Za-z][A-Za-z0-9._-]*\.m?js)'/g)) {
    bundles.add(m[1]);
  }
  return bundles;
}

test('vendor patch 锚定的 bundle 在 release.yml 与 setup.sh 三处一致（跨文件不变量）', () => {
  const browserPatch = read('portable', 'lib', 'patch-managed-browser-root.mjs');
  const pairingPatch = read('portable', 'lib', 'patch-device-pairing-retry.mjs');
  const release = read('portable', 'setup.ps1');
  const setupSh = read('portable', 'setup.sh');

  const bundles = new Set([...extractBundles(browserPatch), ...extractBundles(pairingPatch)]);
  assert.ok(bundles.size >= 2, `应从两个 patch 脚本抽到至少 2 个 bundle 名，实际: ${[...bundles]}`);

  for (const bundle of bundles) {
    assert.ok(release.includes(bundle), `release.yml 缺少 patch 锚定的 bundle: ${bundle}`);
    assert.ok(setupSh.includes(bundle), `portable/setup.sh 缺少 patch 锚定的 bundle: ${bundle}`);
  }

  // 全仓三个关键文件不得残留任何其他 chrome-*/replace-file-* bundle 硬编码
  const pattern = /(chrome|replace-file)-[A-Za-z0-9_-]{8}\.m?js/g;
  for (const [name, text] of [['release.yml', release], ['setup.sh', setupSh], ['patch1', browserPatch], ['patch2', pairingPatch]]) {
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
});
