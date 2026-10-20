#!/usr/bin/env node
// 把 models.json（单一真相源）生成为配置中心运行时渲染的数据源
// config-server/public/models-catalog.json。
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
// 配置中心 config-server/public/index.html 运行时渲染 models-catalog.json，
// 不含 MODELS 标记也不手写卡片——它的一致性由下方生成的 JSON 文件保证。
export const CATALOG_JSON_PATH = join(ROOT, 'config-server', 'public', 'models-catalog.json');

// 生成 config-server/public/models-catalog.json（配置中心动态渲染的数据源）。
// 每家提供商的 models 列表 = models（显式维护的多模型列表）∪ [model]，
// recommended = model（单一真相源里的主模型永远在下拉里排第一或被选中）。
// tags 保留 {cls,text} 对象：cls 是样式键，text 是显示文本（"中转站"等无样式标签也保留）。
export function renderCatalogJson(catalog) {
  return JSON.stringify({
    _generated: '本文件由 node lib/sync-models.mjs 从 portable/models.json 生成，勿手改；改 models.json 后重新跑同步脚本。',
    updated: catalog.updated || '',
    providers: catalog.providers.map((p) => ({
      id: p.id,
      name: p.title,
      tags: (p.tags || []).map((t) => ({ cls: t.cls || '', text: t.text })),
      desc: p.desc,
      base: p.baseUrl,
      models: Array.from(new Set([p.model, ...(p.models || [])])),
      recommended: p.model,
      link: p.link,
      linkLabel: p.linkText ? p.linkText.replace(/^→\s*/, '') : '获取 API Key',
      verified: p.verified,
    })).concat([CUSTOM_CARD]),
  }, null, 2) + '\n';
}

// 自定义卡不进 models.json（它没有模型/端点可维护），由生成器固定追加，保证前端必有此卡。
export const CUSTOM_CARD = {
  id: 'custom',
  name: '自定义',
  tags: [],
  desc: '填写任意 OpenAI 兼容 API 地址（OpenRouter、API2D、New API、One API 等）',
  base: '',
  models: [],
  recommended: '',
  link: '',
  linkLabel: '',
  verified: 'unverified',
};

function main() {
  const check = process.argv.includes('--check');
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  let drift = 0;
  // 生成配置中心的动态渲染数据源 models-catalog.json
  const CATALOG_JSON = CATALOG_JSON_PATH;
  const jsonAfter = renderCatalogJson(catalog);
  let jsonBefore = '';
  try { jsonBefore = readFileSync(CATALOG_JSON, 'utf8'); } catch { /* 首次生成 */ }
  if (jsonBefore === jsonAfter) {
    console.log(`  ok    config-server/public/models-catalog.json`);
  } else {
    drift++;
    if (check) { console.log(`  DRIFT config-server/public/models-catalog.json`); }
    else { writeFileSync(CATALOG_JSON, jsonAfter); console.log(`  写入  config-server/public/models-catalog.json`); }
  }
  if (check && drift) {
    console.error(`\n${drift} 个文件与 models.json 不一致。跑 \`node lib/sync-models.mjs\` 同步。`);
    process.exit(1);
  }
  console.log(check ? '\n全部一致。' : '\n同步完成。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
