// 回归测试：虾盘云「设备钱包」——一键领取额度 + 一键充值 + 换一把 + 填一把。
//
// 覆盖 portable/lib/wallet-client.mjs 的六条硬契约：
//   C1 全程不抛异常（含打开/读取存储文件）
//   C2 rotate 验证只用只读接口，不消耗额度
//   C3 pendingKind 不认识就原样返回，不猜
//   C4 单一真相源 + in-flight 去重
//   C5 领取/rotate/adopt 三条路径都汇到同一个 applyKey()
//   C6（配套）adopt 是存储损坏后重新找回钱包的兜底入口
//
// 网络和文件系统都做成可注入依赖，不碰真实网络和真实 U 盘。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import {
  claimWallet,
  getBalance,
  rotateWallet,
  adoptWallet,
  resetLocalWallet,
  settlePending,
  getStatus,
  applyKey,
  createFileWalletStore,
  createMemoryWalletStore,
  CLOUD_PROVIDER_ID,
} from '../portable/lib/wallet-client.mjs';

// applyKey() 在没有显式传 configPath 时会落到 defaultConfigPath()（真实 portable/data/.openclaw/
// openclaw.json）。这里给所有「没有专门测配置写入」的用例一个共享临时 configPath，
// 绝不能让测试悄悄写进仓库里的真实 U 盘数据目录。
const SHARED_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'uclaw-wallet-test-shared-config-'));
const SHARED_CONFIG_PATH = join(SHARED_CONFIG_DIR, 'openclaw.json');
after(() => {
  try {
    rmSync(SHARED_CONFIG_DIR, { recursive: true, force: true });
  } catch {}
});

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-wallet-test-'));
  try {
    // fn 可能是 async 函数——必须 await 完再清理，否则目录会在异步体还没跑完时就被删掉。
    return await fn(dir);
  } finally {
    try {
      // Windows 上 chmod 0o444 的文件/目录要先恢复权限才能删干净。
      chmodSync(dir, 0o777);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 按「路径 → 依次返回的响应」编排一个假服务端，并记录调用顺序（含 URL）。 */
function fakeServer(routes) {
  const calls = [];
  const queues = new Map();
  for (const [p, r] of Object.entries(routes)) {
    queues.set(p, Array.isArray(r) ? [...r] : [r]);
  }
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, url: String(url), body: init?.body ? JSON.parse(init.body) : {}, headers: init?.headers || {} });
    const queue = queues.get(u.pathname);
    if (!queue || queue.length === 0) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { fetchImpl, calls, pathsCalled: () => calls.map((c) => c.path) };
}

const alwaysValid = async () => true;
const neverValid = async () => false;

// ── C1：存储打不开时绝不抛异常 ──────────────────────────────────────────────

test('C1: 存储文件是损坏 JSON 时，getStatus 不抛异常，返回“还没绑定”', async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, 'uclaw-device.json');
    writeFileSync(storePath, '{ this is not valid json');
    const store = createFileWalletStore(storePath);

    // createFileWalletStore.get() 对损坏 JSON 会抛，验证上层 getStatus 兜住了它。
    const status = await getStatus({ store });
    assert.equal(status.ok, false);
    assert.equal(status.hasWallet, false);
  });
});

test('C1: 存储目录只读（模拟 U 盘写保护）时，claimWallet 不抛异常', async () => {
  if (process.platform === 'win32') {
    // Windows 上目录权限位对 Node fs 不总是生效，改用「get 直接抛」的等价用例。
    const store = {
      get: async () => {
        throw new Error('EACCES: permission denied, open uclaw-device.json');
      },
      set: async () => {
        throw new Error('EROFS: read-only file system');
      },
    };
    const r = await claimWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: async () => { throw new Error('不该发请求'); } });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
    return;
  }
  await withTempDir(async (dir) => {
    const roDir = join(dir, 'readonly');
    mkdirSync(roDir);
    chmodSync(roDir, 0o555);
    const storePath = join(roDir, 'uclaw-device.json');
    const store = createFileWalletStore(storePath);
    const { fetchImpl } = fakeServer({ '/device/bind': { status: 200, body: { apiKey: 'sk-x', walletId: 'w1' } } });

    const r = await claimWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  });
});

test('C1: 存储 get() 抛异常时，settlePending / resetLocalWallet / getBalance 都不抛，返回失败结果', async () => {
  const brokenStore = {
    get: async () => {
      throw new Error('EACCES');
    },
    set: async () => {},
  };
  const unreachable = async () => {
    throw new Error('ENETUNREACH');
  };

  const r1 = await settlePending({ store: brokenStore, fetch: unreachable });
  assert.equal(r1.ok, false);

  const r2 = await resetLocalWallet({ store: brokenStore, configPath: SHARED_CONFIG_PATH });
  assert.equal(r2.ok, false);

  const r3 = await getBalance({ store: brokenStore, fetch: unreachable });
  assert.equal(r3.ok, false);
});

// ── C3：pendingKind 不认识时不猜 ─────────────────────────────────────────────

test('C3: pendingKind 是没见过的值 → settlePending 原样返回，本地状态不变，不发网络请求', async () => {
  const store = createMemoryWalletStore({
    apiKey: 'sk-old',
    walletId: 'wal_1',
    pendingKey: 'sk-staged',
    pendingKind: 'some-future-kind',
    pendingFrom: 'sk-old',
  });
  const { fetchImpl, pathsCalled } = fakeServer({
    '/device/rotate/commit': { status: 200, body: {} },
  });

  const r = await settlePending({ store, fetch: fetchImpl, verifyReadOnly: alwaysValid });

  assert.equal(r.ok, true);
  assert.equal(r.settled, false);
  assert.equal(pathsCalled().length, 0, '不认识的 pendingKind 不该发出任何网络请求');

  const saved = await store.get();
  assert.equal(saved.apiKey, 'sk-old');
  assert.equal(saved.pendingKey, 'sk-staged', 'pending 必须原样保留，等人工处理');
});

test('resetLocalWallet 遇到未知 pendingKind → 拒绝执行，本地状态不变', async () => {
  const store = createMemoryWalletStore({
    apiKey: 'sk-old',
    pendingKey: 'sk-staged',
    pendingKind: 'weird-unknown-kind',
    pendingFrom: 'sk-old',
  });

  const r = await resetLocalWallet({ store, configPath: SHARED_CONFIG_PATH });
  assert.equal(r.ok, false);

  const saved = await store.get();
  assert.equal(saved.apiKey, 'sk-old', '拒绝执行时本地状态必须原封不动');
  assert.equal(saved.pendingKey, 'sk-staged');
});

// ── C4：并发调用去重 ─────────────────────────────────────────────────────────

test('C4: 并发调用 claimWallet 只发一次 /device/bind 请求', async () => {
  const store = createMemoryWalletStore();
  let bindCallCount = 0;
  const fetchImpl = async (url) => {
    const p = new URL(String(url)).pathname;
    if (p === '/device/bind') {
      bindCallCount++;
      // 模拟网络延迟，让两次调用真的会在时间上重叠。
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200, json: async () => ({ apiKey: 'sk-fresh', walletId: 'wal_1' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const [r1, r2] = await Promise.all([
    claimWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl }),
    claimWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl }),
  ]);

  assert.equal(bindCallCount, 1, '并发领取应该只打一次 bind，否则会拿到两个钱包');
  assert.equal(r1.apiKey, 'sk-fresh');
  assert.equal(r2.apiKey, 'sk-fresh');
});

// ── rotate 两阶段提交 ────────────────────────────────────────────────────────

test('rotateWallet: mint → 只读验证 → commit，成功后旧 key 换掉', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old', walletId: 'wal_1' });
  const { fetchImpl, pathsCalled, calls } = fakeServer({
    '/device/rotate': { status: 200, body: { apiKey: 'sk-rotated', walletId: 'wal_1' } },
    '/v1/models': { status: 200, body: { data: [] } },
    '/device/rotate/commit': { status: 200, body: {} },
  });

  const r = await rotateWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.apiKey, 'sk-rotated');
  assert.deepEqual(pathsCalled(), ['/device/rotate', '/v1/models', '/device/rotate/commit']);
  assert.deepEqual(calls[2].body, { currentKey: 'sk-old', newKey: 'sk-rotated' });
});

test('rotateWallet 验证阶段打的是**只读**接口 /v1/models，不是真实模型调用', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const touchedPaths = [];
  const fetchImpl = async (url, init) => {
    const p = new URL(String(url)).pathname;
    touchedPaths.push(p);
    if (p === '/device/rotate') return { ok: true, status: 200, json: async () => ({ apiKey: 'sk-new' }) };
    if (p === '/v1/models') return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (p === '/device/rotate/commit') return { ok: true, status: 200, json: async () => ({}) };
    if (p === '/v1/chat/completions' || p.includes('completions')) {
      throw new Error('绝不能走到真实模型调用——新 key 余额为 0，永远调不通');
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const r = await rotateWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(touchedPaths.includes('/v1/models'));
  assert.ok(!touchedPaths.some((p) => p.includes('completions')));
});

test('rotateWallet: mint 后进程「中断」（下次带着 pending 重启），下次调用能正确收尾且不留第二把悬空 key', async () => {
  // 第一次调用只跑到 mint 就模拟中断：commit 请求直接失败/超时。
  const store = createMemoryWalletStore({ apiKey: 'sk-old', walletId: 'wal_1' });
  const interrupted = fakeServer({
    '/device/rotate': { status: 200, body: { apiKey: 'sk-minted', walletId: 'wal_1' } },
    '/v1/models': { status: 200, body: { data: [] } },
    '/device/rotate/commit': { status: 500, body: {} }, // 模拟这一步没发成功
  });
  const r1 = await rotateWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: interrupted.fetchImpl });
  assert.equal(r1.ok, false, 'commit 失败时应报告失败，且保留 pending 供下次续跑');

  const afterFirst = await store.get();
  assert.equal(afterFirst.pendingKey, 'sk-minted');
  assert.equal(afterFirst.apiKey, 'sk-old');

  // 下次调用（模拟重启后再点一次「换一把」/自动收尾）：不该再打 /device/rotate 第二次 mint。
  const resumed = fakeServer({
    '/device/rotate': { status: 200, body: { apiKey: 'sk-SHOULD-NOT-BE-MINTED-AGAIN' } },
    '/v1/models': { status: 200, body: { data: [] } },
    '/device/rotate/commit': { status: 200, body: {} },
  });
  const r2 = await rotateWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: resumed.fetchImpl });

  assert.equal(r2.ok, true);
  assert.equal(r2.apiKey, 'sk-minted', '收尾用的必须是上次已经 mint 过的那把，不能重新 mint');
  assert.deepEqual(resumed.pathsCalled(), ['/v1/models', '/device/rotate/commit'], '不应该重新调用 /device/rotate');

  const final = await store.get();
  assert.equal(final.pendingKey, '', '收尾后不应留下悬空的 pending');
});

test('rotateWallet: 新 key 验不过时不 commit，旧 key 保留', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const { fetchImpl, pathsCalled } = fakeServer({
    '/device/rotate': { status: 200, body: { apiKey: 'sk-bad' } },
    '/device/rotate/commit': { status: 200, body: {} },
  });

  const r = await rotateWallet({ store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl, verifyReadOnly: neverValid });

  assert.equal(r.ok, false);
  assert.ok(!pathsCalled().includes('/device/rotate/commit'));
  assert.equal((await store.get()).apiKey, 'sk-old');
});

// ── resetLocalWallet 绝不调用服务端删除接口 ─────────────────────────────────

test('resetLocalWallet 绝不发起任何网络请求（只清本地 + 清实际消费者）', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old', walletId: 'wal_1' });
  let networkTouched = false;
  const fetchImpl = async () => {
    networkTouched = true;
    throw new Error('resetLocalWallet 不应该打任何网络请求');
  };

  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ models: { providers: { [CLOUD_PROVIDER_ID]: { apiKey: 'sk-old' } } } }));

    const r = await resetLocalWallet({ store, fetch: fetchImpl, configPath });
    assert.equal(r.ok, true);
    assert.equal(networkTouched, false);

    const saved = await store.get();
    assert.equal(saved.apiKey, '');
    assert.equal(saved.walletId, '');

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(!(CLOUD_PROVIDER_ID in (onDisk.models?.providers || {})), '实际消费者（provider 配置）必须被清掉');
  });
});

// ── adoptWallet：只验一次，不调服务端 bind/rotate；C5 汇流点 applyKey 生效 ──

test('adoptWallet 只验证一次，不调用服务端 bind/rotate', async () => {
  const store = createMemoryWalletStore();
  const touched = [];
  const fetchImpl = async (url) => {
    touched.push(new URL(String(url)).pathname);
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };

  const r = await adoptWallet('sk-from-other-pc-01234567', { store, configPath: SHARED_CONFIG_PATH, fetch: fetchImpl });

  assert.equal(r.ok, true);
  assert.deepEqual(touched, ['/v1/models']);
  assert.ok(!touched.includes('/device/bind'));
  assert.ok(!touched.includes('/device/rotate'));
});

test('adoptWallet 验不过时不落盘', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const r = await adoptWallet('sk-typo-but-long-enough', { store, configPath: SHARED_CONFIG_PATH, verifyReadOnly: neverValid, fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(r.ok, false);
  assert.equal((await store.get()).apiKey, 'sk-old');
});

test('adoptWallet 之后：applyKey 把新 key 写进 openclaw.json，且原有 plugins 字段存活（防 #58 回归）', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: { entries: { 'openclaw-weixin': { enabled: true } } },
        models: { mode: 'merge', providers: { someOtherProvider: { baseUrl: 'https://x' } } },
      })
    );

    const store = createMemoryWalletStore();
    const r = await adoptWallet('sk-adopted-key-0001', {
      store,
      configPath,
      verifyReadOnly: alwaysValid,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    });
    assert.equal(r.ok, true);

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(onDisk.plugins, { entries: { 'openclaw-weixin': { enabled: true } } }, 'plugins 必须存活');
    assert.equal(onDisk.models.providers[CLOUD_PROVIDER_ID].apiKey, 'sk-adopted-key-0001');
    assert.ok('someOtherProvider' in onDisk.models.providers, '既有 provider 不该被冲掉');
    assert.equal(onDisk.agents.defaults.model.primary, `${CLOUD_PROVIDER_ID}/deepseek-v4-flash`);
  });
});

test('applyKey 是领取 / rotate / adopt 三条路径共用的同一个写盘函数（C5 汇流点存在性检查）', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    const merged = applyKey(configPath, 'sk-direct-call-test');
    assert.equal(merged.models.providers[CLOUD_PROVIDER_ID].apiKey, 'sk-direct-call-test');
  });
});

// ── 主模型归属：「空位才占」，不抢用户已配好的 provider ────────────────────────
//
// 领取额度是给没配过模型的人用的，不该把付费用户设好的 MiniMax/DeepSeek 换掉。
// 商业版 ClawX 的既定策略是「付费用户的默认模型必须活过重启」，这里遵循同一条。

test('applyKey：用户已配了别家主模型时，领取额度不抢主模型', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        models: { mode: 'merge', providers: { minimax: { baseUrl: 'https://api.minimaxi.com/v1' } } },
        agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } },
      })
    );

    const merged = applyKey(configPath, 'sk-should-not-steal-primary');

    assert.equal(
      merged.agents.defaults.model.primary,
      'minimax/MiniMax-M3',
      '用户自己配的主模型必须原样存活'
    );
    assert.equal(
      merged.models.providers[CLOUD_PROVIDER_ID].apiKey,
      'sk-should-not-steal-primary',
      '钱包 provider 仍然要写进去（只是不当主模型）'
    );
  });
});

test('applyKey：没有主模型时才占位（新用户一键领取即可用）', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    const merged = applyKey(configPath, 'sk-fresh-user-key');
    assert.equal(merged.agents.defaults.model.primary, `${CLOUD_PROVIDER_ID}/deepseek-v4-flash`);
  });
});

test('applyKey：主模型本来就指向钱包 provider 时，换 key 后仍指向它', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: { defaults: { model: { primary: `${CLOUD_PROVIDER_ID}/deepseek-v4-flash` } } },
      })
    );
    const merged = applyKey(configPath, 'sk-rotated-key');
    assert.equal(merged.agents.defaults.model.primary, `${CLOUD_PROVIDER_ID}/deepseek-v4-flash`);
    assert.equal(merged.models.providers[CLOUD_PROVIDER_ID].apiKey, 'sk-rotated-key');
  });
});

test('applyKey：setPrimary:true 可强制夺取主模型（留给用户显式的「设为主模型」动作）', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { model: { primary: 'minimax/MiniMax-M3' } } } })
    );
    const merged = applyKey(configPath, 'sk-forced', { setPrimary: true });
    assert.equal(merged.agents.defaults.model.primary, `${CLOUD_PROVIDER_ID}/deepseek-v4-flash`);
  });
});

test('applyKey：setPrimary:false 永不设置主模型', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    const merged = applyKey(configPath, 'sk-no-primary', { setPrimary: false });
    assert.equal(merged.agents?.defaults?.model?.primary, undefined);
  });
});

test('applyKey：不抢主模型时，agents.defaults 下的其它字段不被破坏', async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: { defaults: { model: { primary: 'minimax/MiniMax-M3', fallback: 'minimax/abc' }, somethingElse: 42 } },
      })
    );
    const merged = applyKey(configPath, 'sk-keep-siblings');
    assert.equal(merged.agents.defaults.somethingElse, 42);
    assert.equal(merged.agents.defaults.model.fallback, 'minimax/abc');
  });
});

// ── getBalance ───────────────────────────────────────────────────────────────

test('getBalance: 没有钱包时直接返回失败，不发请求', async () => {
  const store = createMemoryWalletStore();
  let touched = false;
  const r = await getBalance({ store, fetch: async () => { touched = true; } });
  assert.equal(r.ok, false);
  assert.equal(touched, false);
});

// 余额走两个 OpenAI 兼容的 billing 接口。这两个接口的形状是 2026-08-23 对着
// api.u-claw.org.cn 实测出来的——技能文档里写的 /api/usage/token/ 在真环境是 404，
// 单测全绿也发现不了，只有真打一次才知道（宪法第 5 条）。
//   剩余 USD = hard_limit_usd - total_usage / 100
//   500,000 quota = $1
test('getBalance: 打 billing 两个接口，按 hard_limit_usd - total_usage/100 算余额', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/v1/dashboard/billing/subscription')) {
      return { ok: true, status: 200, json: async () => ({ hard_limit_usd: 2 }) };
    }
    if (u.includes('/v1/dashboard/billing/usage')) {
      // total_usage 单位是 USD×100，这里代表已用 $0.5
      return { ok: true, status: 200, json: async () => ({ object: 'list', total_usage: 50 }) };
    }
    throw new Error(`不该打这个地址：${u}`);
  };

  const r = await getBalance({ store, fetch: fetchImpl, today: '2026-08-23' });
  assert.equal(r.ok, true);
  assert.equal(r.grantedUsd, 2);
  assert.equal(r.usedUsd, 0.5);
  assert.equal(r.remainingUsd, 1.5);
  assert.equal(r.remainingQuota, 750000, '1.5 USD × 500000 = 750000 quota');

  assert.ok(seen.some((u) => u.includes('/v1/dashboard/billing/subscription')));
  assert.ok(
    seen.some((u) => u.includes('start_date=2020-01-01') && u.includes('end_date=2026-08-23')),
    'usage 必须带上日期区间，否则服务端只给今天的用量'
  );
  assert.ok(!seen.some((u) => u.includes('/api/usage/token')), '不许再打那个 404 的老接口');
});

test('getBalance: billing 接口挂了要如实报失败，不能把余额显示成 0', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const r = await getBalance({
    store,
    today: '2026-08-23',
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 404/);
});

test('getBalance: 返回格式不认识时报错，不许拿 NaN 去显示', async () => {
  const store = createMemoryWalletStore({ apiKey: 'sk-old' });
  const r = await getBalance({
    store,
    today: '2026-08-23',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ 啥也没有: 1 }) }),
  });
  assert.equal(r.ok, false);
});

// ── 平台无关：os 引入仅用于跳过判断，避免 lint 报未使用 ──────────────────────
void os.platform;

// ── 领取失败的人话提示（实测 2026-08-23：限流返回 429 {"error":"rate-limited"}）──

test('claimWallet: 撞上服务端限流(429)时给人话，不甩 HTTP 状态码给用户', async () => {
  const store = createMemoryWalletStore();
  const r = await claimWallet({
    store,
    configPath: SHARED_CONFIG_PATH,
    fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate-limited' }) }),
  });
  assert.equal(r.ok, false);
  assert.ok(!/HTTP|429/.test(r.error), `不该把状态码甩给用户，实际是：${r.error}`);
  assert.match(r.error, /稍等|再试|太多/, '要告诉用户过一会儿再点');
});

test('claimWallet: 服务器 5xx 时提示检查网络，同样不甩状态码', async () => {
  const store = createMemoryWalletStore();
  const r = await claimWallet({
    store,
    configPath: SHARED_CONFIG_PATH,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /连不上|网络/);
});
