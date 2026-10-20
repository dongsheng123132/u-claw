import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// docs/快速上手.md 与 portable/快速上手.html 是同一份教程的两份形态
// （仓库版 + U盘离线版）。历史上靠手抄同步，改一边必漂。本测试守住两边的
// 步骤标题集合一致——改教程时两边必须一起改。
function extractMdSteps(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}

function extractHtmlSteps(text) {
  return [...text.matchAll(/<h2>(.+?)<\/h2>/g)].map((m) => m[1].trim());
}

test('quickstart: docs/快速上手.md 与 portable/快速上手.html 步骤标题同步', () => {
  const md = readFileSync(join(repoRoot, 'docs', '快速上手.md'), 'utf8');
  const html = readFileSync(join(repoRoot, 'portable', '快速上手.html'), 'utf8');
  const mdSteps = extractMdSteps(md);
  const htmlSteps = extractHtmlSteps(html);
  assert.deepEqual(
    htmlSteps,
    mdSteps,
    '两份教程步骤标题不一致——请同时修改 docs/快速上手.md 与 portable/快速上手.html',
  );
});

test('quickstart: 关键提示两边同步（钱包备份/Dashboard token/步数说明）', () => {
  const md = readFileSync(join(repoRoot, 'docs', '快速上手.md'), 'utf8');
  const html = readFileSync(join(repoRoot, 'portable', '快速上手.html'), 'utf8');
  for (const keyword of ['你的密钥就是你的钱包', '#token=uclaw', '都发生在配置中心的第 3 步']) {
    assert.ok(md.includes(keyword), `docs/快速上手.md 缺关键字: ${keyword}`);
    assert.ok(html.includes(keyword), `portable/快速上手.html 缺关键字: ${keyword}`);
  }
});

test('quickstart: 离线版引用的截图在 portable/img/ 都存在', () => {
  const html = readFileSync(join(repoRoot, 'portable', '快速上手.html'), 'utf8');
  const imgs = [...html.matchAll(/src="(img\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 3, '离线教程应至少引用 3 张截图');
  for (const rel of imgs) {
    const p = join(repoRoot, 'portable', rel);
    assert.ok(readFileSync(p), `截图缺失: ${rel}`);
  }
});

test('quickstart: docs/img 与 portable/img 截图字节级一致（防换图只换一边）', () => {
  for (const name of ['config-step1.png', 'config-step2.png', 'config-step3.png']) {
    const a = readFileSync(join(repoRoot, 'docs', 'img', name));
    const b = readFileSync(join(repoRoot, 'portable', 'img', name));
    assert.ok(a.equals(b), `两张 ${name} 内容不一致——请用同一张图更新 docs/img 与 portable/img`);
  }
});
