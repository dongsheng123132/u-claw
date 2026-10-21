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

test('双击 file:// 兜底页：配置服务在线就跳到配置中心，离线给明确提示', () => {
  // file:// 页面跨域访问配置服务必然被 CORS 拦（服务端只放行 127.0.0.1/localhost 来源，
  // 不为「任意下载来的 .html 都能读/改配置」放行 Origin: null）。所以双击页只做两件事：
  // 探测 → 在线跳转；离线提示。回归点：这条路径不能被删、不能改成静默失败。
  assert.match(configPage, /location\.protocol !== 'file:'/, '跳转/提示逻辑必须先判断 file:// 协议');
  assert.match(configPage, /\.get\('configPort'\)/, '探测端口来自 ?configPort= 查询参数');
  assert.match(configPage, /\/api\/runtime/, '用配置服务的 /api/runtime 探测是否在线');
  assert.match(configPage, /AbortController/, '探测必须有超时（AbortController），不能卡死页面');
  assert.match(
    configPage,
    /location\.replace\('http:\/\/127\.0\.0\.1:' \+ port \+ '\/'\)/,
    '在线时 location.replace 到同源配置中心',
  );
  assert.match(configPage, /configServerNotice/, '离线时要在页头显示「配置服务未启动」提示');
  assert.match(configPage, /Windows-Start\.bat/, '提示要告诉用户先启动哪个脚本');
  assert.doesNotMatch(configPage, /Origin: null 放行|origin === 'null'/,
    '不要靠放行 Origin:null 解决跨域（安全上不可接受）');
  assert.doesNotMatch(backupPage, /location\.replace/, '备用配置中心是 http 页面，不做 file:// 跳转');
});
