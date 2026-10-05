// 回归测试：issue #67（渠道配置保存失败，页面却照样提示"已保存"并继续）。
//
// 症状：index.html 的 saveChannelsAndOpen() 和 Config.html 的 launchOpenClaw() 往 POST /api/config
// 写渠道配置时，既不看响应状态也不看响应体里的 ok，catch(e){} 还把异常吞了——服务端回 500 /
// {ok:false,error} / 网络断了，用户看到的永远是"配置已保存"，并且页面继续往下走（开 Dashboard /
// 通知 /api/done）。另外 GET /api/config 失败时旧代码会退化成只 POST { channels }，而服务端对
// 受管字段"没带 = 清空"，会把 models/agents/env 一并清掉。
//
// 这里不靠"读 HTML 文本 grep"，而是用花括号配对把真实函数从页面源码里抠出来，丢进 node:vm
// 里，配上假的 document / fetch / showToast / window.open 真跑一遍，断言可观察行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── 从页面源码里抠函数：花括号配对（跳过字符串 / 模板字符串 / 注释）──────────────
//
// 不处理正则字面量（目标函数里没有；以后加了含引号/花括号的正则，抽取会报 unbalanced，
// 测试会大声失败而不是悄悄抽错）。

function skipQuoted(src, i, quote) {
  for (i += 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
  }
  throw new Error('unterminated string literal');
}

function skipTemplate(src, i) {
  for (i += 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '`') return i;
    if (c === '$' && src[i + 1] === '{') {
      i = scanBalanced(src, i + 1) - 1; // 模板里的 ${ ... } 递归配对
    }
  }
  throw new Error('unterminated template literal');
}

// openIdx 指向 '{'，返回配对的 '}' 之后一位的下标。
function scanBalanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const eol = src.indexOf('\n', i);
      if (eol < 0) break;
      i = eol;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced braces while extracting function');
}

function extractFunction(source, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name}() not found in source`);

  // 跳过参数列表（按圆括号配对），再找函数体的 '{'
  let i = m.index + m[0].length;
  let parens = 1;
  while (parens > 0) {
    if (i >= source.length) throw new Error(`unbalanced parens in ${name}() signature`);
    const c = source[i];
    if (c === '(') parens += 1;
    else if (c === ')') parens -= 1;
    i += 1;
  }
  while (/\s/.test(source[i])) i += 1;
  if (source[i] !== '{') throw new Error(`expected '{' after ${name}() signature`);

  return source.slice(m.index, scanBalanced(source, i));
}

// ── 假环境 + 在 vm 里真跑 ────────────────────────────────────────────────────

const GATEWAY_URL = 'http://127.0.0.1:18789/#token=uclaw';
const SUCCESS_TOAST_CONFIG = '配置已保存！请关闭此页面，回到启动窗口使用 U-Claw';

const PAGES = [
  {
    label: 'index.html',
    file: new URL('../portable/config-server/public/index.html', import.meta.url),
    fn: 'saveChannelsAndOpen',
    kind: 'index',
    // 抽取是否真的抽到函数末尾：函数体末尾才有的标志性语句
    tailMarker: 'window.open(gatewayUrl()',
  },
  {
    label: 'Config.html',
    file: new URL('../portable/Config.html', import.meta.url),
    fn: 'launchOpenClaw',
    kind: 'config',
    tailMarker: "'/api/done'",
  },
];

for (const page of PAGES) {
  page.source = readFileSync(page.file, 'utf8');
  page.code = extractFunction(page.source, page.fn);
}

// 构造 fetch 响应。bodyOrThrow 为 Error 实例时 json() 抛错（模拟返回的不是 JSON）。
function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

// routes(url, method, body) → 响应对象 / Promise；抛错或返回 rejected Promise 即模拟网络失败。
function runPage(page, { fields = {}, routes }) {
  const calls = [];
  const toasts = [];
  const opens = [];
  const order = [];

  const sandbox = {
    document: {
      getElementById(id) {
        return { value: Object.prototype.hasOwnProperty.call(fields, id) ? fields[id] : '' };
      },
    },
    async fetch(url, opts) {
      const method = (opts && opts.method) || 'GET';
      const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, method, body });
      return routes(url, method, body);
    },
    showToast(msg, isError) {
      toasts.push({ msg, isError: !!isError });
      order.push('toast');
    },
    gatewayUrl() {
      return GATEWAY_URL;
    },
    window: {
      open(...args) {
        opens.push(args);
        order.push('open');
      },
    },
  };

  const ctx = vm.createContext(sandbox);
  const fn = vm.runInContext(`${page.code}\n;${page.fn};`, ctx);
  assert.equal(typeof fn, 'function', `${page.fn} 应当被还原成函数`);

  const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/config');
  const done = () => calls.filter((c) => c.url === '/api/done');
  return {
    async run() {
      await fn();
      return { calls, toasts, opens, order, posts: posts(), done: done() };
    },
  };
}

const DISK_CONFIG = () => ({
  models: { mode: 'merge', providers: { minimax: { baseUrl: 'https://minimax' } } },
  agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
  channels: { qqbot: { enabled: true, appId: 'qq-app', clientSecret: 'qq-secret' } },
  agent: {}, // 旧版废弃键，提交前必须被清掉
});

const FILL_TELEGRAM = { 'ch-telegram-token': ' tg-token ' };

// 默认路由：GET /api/config 回磁盘配置；POST 由用例自己给；/api/done 回 200。
function routesWith({ get = () => resp(200, DISK_CONFIG()), post }) {
  return (url, method) => {
    if (url === '/api/done') return resp(200, {});
    if (url === '/api/config' && method === 'GET') return get();
    if (url === '/api/config' && method === 'POST') return post();
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
}

const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// 失败路径的公共断言：错误 toast 恰好一条、含原因；没有任何"成功"信号；页面没有继续往下走。
function assertFailureOutcome(page, out, reasonFragment) {
  assert.equal(out.toasts.length, 1, `只应出现一条 toast，实际：${JSON.stringify(out.toasts)}`);
  const [toast] = out.toasts;
  assert.equal(toast.isError, true, '失败 toast 必须是 isError=true');
  assert.ok(toast.msg.startsWith('渠道配置保存失败：'), toast.msg);
  assert.ok(toast.msg.includes(reasonFragment), `toast 应包含原因 "${reasonFragment}"：${toast.msg}`);
  assert.ok(toast.msg.endsWith('，请重试'), toast.msg);

  const successMsg = page.kind === 'index' ? '渠道配置已保存' : SUCCESS_TOAST_CONFIG;
  assert.ok(!out.toasts.some((t) => t.msg === successMsg), '失败时不能出现成功 toast');

  if (page.kind === 'index') {
    assert.equal(out.opens.length, 0, '保存失败时不能打开 Dashboard');
  } else {
    assert.equal(out.done.length, 0, '保存失败时不能 POST /api/done');
  }
}

// ── 抽取器自检：确保花括号配对在模板字符串 / ?. / 注释 / 字符串里的花括号下依旧正确 ───────

test('extractFunction: 模板字符串、可选链、字符串/注释里的花括号都不会让配对跑偏', () => {
  const src = [
    'function before() { return 1; }',
    'async function target(a, b = { x: 1 }) {',
    "  const s = '}{'; // 注释里的 } 不算 {",
    '  /* 块注释 } */',
    '  const t = `模板 ${a?.b ?? `嵌套 ${ {k: 1}.k }`} 结尾 }`;',
    '  if (a) { return { s, t }; }',
    '  return "done}";',
    '}',
    'function after() { return 2; }',
  ].join('\n');
  const code = extractFunction(src, 'target');
  assert.ok(code.startsWith('async function target('));
  assert.ok(code.endsWith('return "done}";\n}'), `抽取结果末尾不对：${JSON.stringify(code.slice(-30))}`);
  assert.ok(!code.includes('function after'));
});

test('extractFunction: 找不到函数时大声报错，而不是返回空', () => {
  assert.throws(() => extractFunction('function other() {}', 'nope'), /not found/);
});

for (const page of PAGES) {
  test(`${page.label}: 抽到的 ${page.fn}() 是完整的真实函数（到了函数末尾，不是被截断的）`, () => {
    assert.ok(page.code.includes(page.tailMarker), `抽取结果里应含 ${page.tailMarker}`);
    assert.ok(page.code.trimEnd().endsWith('}'));
    // 抽取结果之后紧跟的不能还是同一个函数的内容：下一段应是别的顶层声明 / </script>
    const rest = page.source.slice(page.source.indexOf(page.code) + page.code.length);
    assert.ok(!/^\s*(?:try|catch|showToast|window\.open)\b/.test(rest), '函数后面不应还有残余语句');
  });
}

// ── 行为测试：两个页面同一组用例 ─────────────────────────────────────────────

for (const page of PAGES) {
  const L = page.label;

  test(`${L}: (a) 保存成功——POST 恰好一次，带 qqbot+telegram，保留 models/agents，不带 agent；成功提示后继续`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => resp(200, { ok: true }) }),
    }).run();

    assert.equal(out.posts.length, 1, '应当恰好 POST 一次 /api/config');
    const body = roundTrip(out.posts[0].body);
    const disk = DISK_CONFIG();
    assert.deepEqual(body.channels, {
      qqbot: disk.channels.qqbot,
      telegram: { enabled: true, botToken: 'tg-token', dmPolicy: 'pairing' },
    });
    assert.deepEqual(body.models, disk.models, 'models 必须原样带回，否则服务端会当作"清空"');
    assert.deepEqual(body.agents, disk.agents, 'agents 必须原样带回');
    assert.ok(!('agent' in body), '旧版废弃键 agent 必须被清掉');

    if (page.kind === 'index') {
      assert.deepEqual(out.toasts, [{ msg: '渠道配置已保存', isError: false }]);
      assert.equal(out.opens.length, 1, '成功后应打开 Dashboard 恰好一次');
      assert.deepEqual(roundTrip(out.opens[0]), [GATEWAY_URL, '_blank']);
      assert.deepEqual(out.order, ['toast', 'open'], '先提示成功再开 Dashboard');
    } else {
      assert.deepEqual(out.toasts, [{ msg: SUCCESS_TOAST_CONFIG, isError: false }]);
      assert.equal(out.done.length, 1, '成功后应 POST /api/done');
      assert.equal(out.done[0].method, 'POST');
    }
  });

  test(`${L}: (b) 服务端 200 但 ok:false（如无法安全保存 API Key）——报错，不报成功，不往下走`, async () => {
    const reason = '无法安全保存 API Key（timeout）';
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => resp(200, { ok: false, error: reason }) }),
    }).run();

    assert.equal(out.posts.length, 1);
    assertFailureOutcome(page, out, reason);
  });

  test(`${L}: (c) 服务端 500 {ok:false,error}——报错，不报成功，不往下走`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => resp(500, { ok: false, error: 'disk full' }) }),
    }).run();

    assert.equal(out.posts.length, 1);
    assertFailureOutcome(page, out, 'disk full');
  });

  test(`${L}: (c2) 服务端 500 且返回的不是 JSON——报通用的"保存失败"，不往下走`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => resp(500, new SyntaxError('Unexpected token < in JSON')) }),
    }).run();

    assert.equal(out.posts.length, 1);
    assertFailureOutcome(page, out, '保存失败');
  });

  test(`${L}: (c3) 200 但响应体缺 ok（不是 {ok:true}）——不能当成功`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => resp(200, {}) }),
    }).run();

    assert.equal(out.posts.length, 1);
    assertFailureOutcome(page, out, '保存失败');
  });

  test(`${L}: (d) POST 的 fetch 本身 reject（断网）——报错，不报成功，不往下走`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({ post: () => Promise.reject(new Error('Failed to fetch')) }),
    }).run();

    assert.equal(out.posts.length, 1);
    assertFailureOutcome(page, out, 'Failed to fetch');
  });

  test(`${L}: (e) GET /api/config 返回 500——根本不能 POST（否则会把 models/agents/env 清空）`, async () => {
    const out = await runPage(page, {
      fields: FILL_TELEGRAM,
      routes: routesWith({
        get: () => resp(500, { error: 'read failed' }),
        post: () => {
          throw new Error('GET 失败后不应该发起 POST');
        },
      }),
    }).run();

    assert.equal(out.posts.length, 0, 'GET 失败时不能发 POST，哪怕只带 channels');
    assert.deepEqual(
      out.calls.map((c) => `${c.method} ${c.url}`).filter((s) => s !== 'POST /api/done'),
      ['GET /api/config']
    );
    assertFailureOutcome(page, out, '读取现有配置失败（HTTP 500）');
  });

  test(`${L}: (f) 没填任何渠道——不碰 /api/config，行为同改动前`, async () => {
    const out = await runPage(page, {
      fields: {},
      routes: routesWith({
        get: () => {
          throw new Error('没填渠道不应该 GET /api/config');
        },
        post: () => {
          throw new Error('没填渠道不应该 POST /api/config');
        },
      }),
    }).run();

    assert.equal(out.calls.filter((c) => c.url === '/api/config').length, 0);
    if (page.kind === 'index') {
      assert.equal(out.opens.length, 1, '没填渠道也应直接打开 Dashboard');
      assert.deepEqual(roundTrip(out.opens[0]), [GATEWAY_URL, '_blank']);
      assert.deepEqual(out.toasts, []);
    } else {
      assert.deepEqual(out.toasts, [{ msg: SUCCESS_TOAST_CONFIG, isError: false }]);
      assert.equal(out.done.length, 1);
    }
  });

  test(`${L}: (f2) 只填了半套（有 AppID 无 Secret）——不算填了渠道，不碰 /api/config`, async () => {
    const out = await runPage(page, {
      fields: { 'ch-qqbot-appid': 'only-id' },
      routes: routesWith({
        get: () => {
          throw new Error('半套渠道不应该 GET /api/config');
        },
        post: () => {
          throw new Error('半套渠道不应该 POST /api/config');
        },
      }),
    }).run();

    assert.equal(out.calls.filter((c) => c.url === '/api/config').length, 0);
  });
}
