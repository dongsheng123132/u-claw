#!/usr/bin/env node
// 把 models.json（单一真相源）同步到各配置页里被标记的模型卡片区。
//
// 用法：
//   node lib/sync-models.mjs          写入
//   node lib/sync-models.mjs --check  只检查，有漂移退出码 1（CI / 测试用）
//
// 为什么需要它：模型 ID 原本在多份 HTML 里各写一遍，各家模型名每几个月换一代，
// 副本必然漂移。2026-07 就因为 DeepSeek 停用 deepseek-chat，客户机每条消息都 400。
// 零依赖，只用 node 内置模块。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export const CATALOG_PATH = join(ROOT, 'models.json');
export const TARGETS = [
  join(ROOT, 'Config.html'),
  join(ROOT, 'config-server', 'public', 'index.html'),
];

const BEGIN = '<!-- MODELS:BEGIN 由 models.json 生成，勿手改；改 models.json 后跑 node lib/sync-models.mjs -->';
const END = '<!-- MODELS:END -->';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderCards(catalog, indent = '            ') {
  return catalog.providers.map((p) => {
    const tags = (p.tags || [])
      .map((t) => `<span class="tag${t.cls ? ' ' + t.cls : ''}">${esc(t.text)}</span>`).join('');
    const linkText = p.linkText || '→ 获取 API Key';
    // uclaw-cloud 的链接带 data-action-label（ActionParity：给机器留稳定标识）
    const actionAttr = p.linkText ? ` data-action-label="${esc(linkText.replace(/^→\s*/, ''))}"` : '';
    return [
      `${indent}<div class="model-card" data-provider="${esc(p.id)}" data-base="${esc(p.baseUrl)}" data-model="${esc(p.model)}">`,
      `${indent}    <span class="check">✓</span>`,
      `${indent}    <h4>${esc(p.title)} ${tags}</h4>`,
      `${indent}    <p>${esc(p.desc)}</p>`,
      `${indent}    <a class="buy-link" href="${esc(p.link)}" target="_blank"${actionAttr}>${esc(linkText)}</a>`,
      `${indent}</div>`,
    ].join('\n');
  }).join('\n');
}

export function applyToText(text, catalog, file) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`${file}: 找不到 MODELS:BEGIN / MODELS:END 标记`);
  if (e < b) throw new Error(`${file}: MODELS:END 出现在 MODELS:BEGIN 之前`);
  const head = text.slice(0, b + BEGIN.length);
  const tail = text.slice(e);
  return `${head}\n${renderCards(catalog)}\n            ${tail}`;
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  let drift = 0;
  for (const file of TARGETS) {
    const before = readFileSync(file, 'utf8');
    const after = applyToText(before, catalog, file);
    if (before === after) { console.log(`  ok    ${file}`); continue; }
    drift++;
    if (check) { console.log(`  DRIFT ${file}`); continue; }
    writeFileSync(file, after);
    console.log(`  写入  ${file}`);
  }
  if (check && drift) {
    console.error(`\n${drift} 个文件与 models.json 不一致。跑 \`node lib/sync-models.mjs\` 同步。`);
    process.exit(1);
  }
  console.log(check ? '\n全部一致。' : '\n同步完成。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
