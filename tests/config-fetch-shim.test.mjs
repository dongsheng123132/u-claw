// 回归测试：配置页的 file:// fetch shim 曾写成自递归（09bc4b8 引入，v2.3.2 起 Config.html 网络全废）。
//
// 机制：脚本顶层 `function fetch` 声明会在脚本实例化阶段就被提升并覆盖 window.fetch。
// 如果 `var nativeFetch = window.fetch.bind(window)` 和这个声明写在同一个 <script> 块里，
// 它抓到的就是 shim 自己 —— 每个 fetch 都无限递归，抛 RangeError: Maximum call stack size exceeded，
// 页面里模型目录 / 钱包状态 / Gateway 状态 / 保存配置全部静默失效。
// 修法：把 configOrigin / nativeFetch 放进前面的独立 <script> 块，先拿到原生 fetch，再装 shim。
//
// 这个测试是静态的（不启动浏览器）：只要有人把两段合并回去、或在捕获块里重新声明 function fetch，
// CI 就会拦住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const configPage = readFileSync(join(root, 'portable', 'Config.html'), 'utf8');
const backupPage = readFileSync(join(root, 'portable', 'config-server', 'public', 'index.html'), 'utf8');

const CAPTURE_RE = /var\s+nativeFetch\s*=\s*window\.fetch\.bind\(window\)/;
const SHIM_RE = /function\s+fetch\s*\(\s*resource\s*,\s*options\s*\)/;

function scriptBlocks(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

test('Config.html 的 fetch shim：原生 fetch 在前一个独立脚本块里捕获，不会自我递归', () => {
  const blocks = scriptBlocks(configPage);
  const captureIndex = blocks.findIndex((b) => CAPTURE_RE.test(b));
  const shimIndex = blocks.findIndex((b) => SHIM_RE.test(b));

  assert.ok(captureIndex >= 0, 'Config.html 缺少捕获原生 fetch 的语句（双击 file:// 页面要靠它连本机配置服务）');
  assert.ok(shimIndex >= 0, 'Config.html 缺少 file:// 兼容的 fetch shim');
  assert.ok(
    captureIndex < shimIndex,
    '原生 fetch 必须先于 shim 捕获，且不能与 function fetch 声明同处一个 <script> 块',
  );
  assert.doesNotMatch(
    blocks[captureIndex],
    /function\s+fetch\s*\(/,
    '捕获原生 fetch 的脚本块里不能出现 function fetch 声明：函数声明提升会让 window.fetch.bind(window) 抓到 shim 自己，所有请求 RangeError 爆栈',
  );
  // 每个内联块都要能独立解析（浏览器按块实例化，语法错误会整块不执行）
  for (const [i, block] of blocks.entries()) new Script(block, { filename: 'Config.html#script' + i });
});

test('Config.html 的 shim 仍把 "/" 开头的请求转到本机配置服务（file:// 双击场景）', () => {
  const shim = scriptBlocks(configPage).find((b) => SHIM_RE.test(b));
  assert.match(shim, /configOrigin\s*\+\s*resource/, 'shim 应把 / 开头的相对路径接到 configOrigin');
  assert.match(configPage, /get\('configPort'\)/, 'configOrigin 仍需读取 ?configPort= 查询参数');
});

test('备用配置中心由 config-server 同源伺服，不需要也不该带 fetch shim', () => {
  const blocks = scriptBlocks(backupPage);
  assert.ok(blocks.length > 0, '备用配置中心缺少内联脚本');
  assert.doesNotMatch(backupPage, /function\s+fetch\s*\(/, 'index.html 是 http 同源页面，装 fetch shim 只会再次埋下自递归风险');
  for (const [i, block] of blocks.entries()) new Script(block, { filename: 'index.html#script' + i });
});
