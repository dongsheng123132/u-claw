// 防止模型目录漂移。
//
// 背景：模型 ID 曾经在 Config.html / config-server/public/index.html / install.ps1 /
// install.sh 里各写一遍。2026-07 DeepSeek 停用 deepseek-chat，只改了一部分副本，
// 客户机（pc-5376）每条消息都 400 却没有任何报错。这些测试让副本再也无法悄悄分叉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTABLE = join(REPO, 'portable');
const catalog = JSON.parse(readFileSync(join(PORTABLE, 'models.json'), 'utf8'));

const PAGES = [
  join(PORTABLE, 'Config.html'),
  join(PORTABLE, 'config-server', 'public', 'index.html'),
];

function cardsOf(file) {
  const t = readFileSync(file, 'utf8');
  const b = t.indexOf('<!-- MODELS:BEGIN');
  const e = t.indexOf('<!-- MODELS:END');
  assert.ok(b >= 0 && e > b, `${file}: 缺少 MODELS:BEGIN/END 标记`);
  return [...t.slice(b, e).matchAll(/data-provider="([^"]*)"\s+data-base="([^"]*)"\s+data-model="([^"]*)"/g)]
    .map((m) => ({ id: m[1], baseUrl: m[2], model: m[3] }));
}

test('models.json 自身是合法且完整的', () => {
  assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);
  const seen = new Set();
  for (const p of catalog.providers) {
    assert.ok(p.id, 'provider 缺 id');
    assert.ok(!seen.has(p.id), `provider id 重复: ${p.id}`);
    seen.add(p.id);
    assert.ok(p.model, `${p.id}: 缺 model`);
    assert.ok(p.verified, `${p.id}: 缺 verified 字段（证据强度必须显式写出）`);
  }
});

test('两个配置页的模型卡片都与 models.json 一致', () => {
  for (const page of PAGES) {
    const cards = cardsOf(page);
    assert.equal(cards.length, catalog.providers.length,
      `${page}: 卡片数与 models.json 不符——跑 node portable/lib/sync-models.mjs`);
    catalog.providers.forEach((p, i) => {
      assert.equal(cards[i].id, p.id, `${page}: 第 ${i} 张卡 provider 不符`);
      assert.equal(cards[i].model, p.model, `${page}: ${p.id} 的 data-model 漂移了`);
      assert.equal(cards[i].baseUrl, p.baseUrl, `${page}: ${p.id} 的 data-base 漂移了`);
    });
  }
});

test('两个配置页彼此一致（同一份清单，不允许分叉）', () => {
  const [a, b] = PAGES.map(cardsOf);
  assert.deepEqual(a, b, '两个配置页的模型卡片分叉了——跑 node portable/lib/sync-models.mjs');
});

test('安装脚本里出现的模型名都在 models.json 里', () => {
  const known = new Set(catalog.providers.map((p) => p.model));
  // 目录之外仍允许出现的：本地模型
  const allowlist = new Set(['llama3.2']);
  for (const [file, re] of [
    [join(REPO, 'install', 'install.ps1'), /\bmodel="([^"]+)"/g],
    [join(REPO, 'install', 'install.sh'), /\bMODEL_NAME="([^"]+)"/g],
  ]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const id = m[1];
      assert.ok(known.has(id) || allowlist.has(id),
        `${file}: 模型名 "${id}" 不在 models.json 里——要么是过期值，要么该加进目录`);
    }
  }
});

test('安装脚本把 API Key 写进 JSON 前做了转义', () => {
  // key 里含 \ 或 " 会写出无法解析的 openclaw.json，OpenClaw 直接起不来。
  const sh = readFileSync(join(REPO, 'install', 'install.sh'), 'utf8');
  assert.match(sh, /API_KEY_JSON/, 'install.sh 缺少 API Key 的 JSON 转义');
  const ps1 = readFileSync(join(REPO, 'install', 'install.ps1'), 'utf8');
  assert.match(ps1, /apiKeyJson|\$apiKeyEscaped/,
    'install.ps1 缺少 API Key 的 JSON 转义（install.sh 已修，PowerShell 侧不能漏）');
  assert.doesNotMatch(ps1, /"apiKey":\s*"\$apiKey"/,
    'install.ps1 仍在把未转义的 $apiKey 直接插进 JSON');
});
