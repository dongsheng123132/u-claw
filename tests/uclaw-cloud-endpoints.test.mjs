// 回归测试：虾盘云端点 failover（移植自 ClawX uclaw-cloud-endpoint.ts 的防坑）。
//
// 对应的真实事故（ClawX exFAT 交接单坑 #4）：出厂默认端点 api.u-claw.org.cn
// 抖一下 / 被 SNI reset 时，好 key 当场被拒——「这把密钥用不了，没有保存」。
//
// 硬规则：
//   R1 只有网络异常 / 5xx / 404 才换下一个域名；401/403/429 是服务端权威判决，不换
//   R2 全部端点不通时 fail-soft 回第一候选，不抛异常炸掉启动链路
//   R3 运营方放一份 uclaw-cloud-endpoints.json 可覆盖内置清单；无效配置静默退回内置
//   R4 绝不在 import 时联网

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEndpointCandidates,
  detectBestEndpoint,
  fetchWithFailover,
  apiOrigin,
} from '../portable/lib/uclaw-cloud-endpoints.mjs';

async function withTempConfigFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-endpoint-test-'));
  const p = join(dir, 'uclaw-cloud-endpoints.json');
  if (content !== null) writeFileSync(p, content, 'utf8');
  try {
    return await fn(p);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const VALID_CONFIG = JSON.stringify({
  version: 1,
  endpoints: [
    { id: 'a', apiBase: 'https://a.example.com/v1', payBase: 'https://a.example.com' },
    { id: 'b', apiBase: 'https://b.example.com/v1', payBase: 'https://b.example.com' },
  ],
});

// ── R3：配置加载 ──────────────────────────────────────────────────────────────

test('loadEndpointCandidates: 无文件时返回内置清单（org.cn 主 + org 备）', () => {
  const list = loadEndpointCandidates(join(tmpdir(), 'definitely-not-exists-uclaw.json'));
  assert.equal(list.length, 2);
  assert.ok(list[0].apiBase.includes('api.u-claw.org.cn'));
  assert.ok(list[1].apiBase.includes('api.u-claw.org'));
});

test('loadEndpointCandidates: 合法文件覆盖内置清单', async () => {
  await withTempConfigFile(VALID_CONFIG, (p) => {
    const list = loadEndpointCandidates(p);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'a');
    assert.equal(list[0].apiBase, 'https://a.example.com/v1');
  });
});

test('loadEndpointCandidates: 坏 JSON / 错 version / 非 https / 空列表 都静默退回内置', async () => {
  for (const bad of [
    '{not json',
    JSON.stringify({ version: 2, endpoints: [] }),
    JSON.stringify({ version: 1, endpoints: [{ id: 'x', apiBase: 'http://insecure.example.com', payBase: 'http://x' }] }),
    JSON.stringify({ version: 1, endpoints: [] }),
  ]) {
    await withTempConfigFile(bad, (p) => {
      const list = loadEndpointCandidates(p);
      assert.equal(list[0].apiBase.includes('u-claw'), true, `应退回内置清单：${bad}`);
    });
  }
});

test('loadEndpointCandidates: 最多 4 条、按 (apiBase,payBase) 去重', async () => {
  const cfg = JSON.stringify({
    version: 1,
    endpoints: [
      { id: 'a', apiBase: 'https://a.example.com/v1', payBase: 'https://a' },
      { id: 'dup', apiBase: 'https://a.example.com/v1', payBase: 'https://a' },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, apiBase: `https://e${i}.example.com/v1`, payBase: `https://e${i}` })),
    ],
  });
  await withTempConfigFile(cfg, (p) => {
    // ClawX 同款语义：先 slice(0,4) 截断再去重 → a + dup + e0 + e1，去重后 3 条
    const list = loadEndpointCandidates(p);
    assert.equal(list.length, 3);
    assert.equal(list.filter((c) => c.apiBase === 'https://a.example.com/v1').length, 1);
  });
});

// ── R1：探测与切换 ────────────────────────────────────────────────────────────

test('detectBestEndpoint: 第一个端点 HEAD <500 就用它（含 401/404——域名活着）', async () => {
  await withTempConfigFile(VALID_CONFIG, async (p) => {
    let hit = 0;
    const fetchImpl = async (url) => {
      // apiBase 带 /v1 后缀，探测路径拼在其后：https://a.example.com/v1/models
      assert.equal(String(url), 'https://a.example.com/v1/models');
      hit += 1;
      return { status: 401 };
    };
    const ep = await detectBestEndpoint({ fetch: fetchImpl, configPath: p });
    assert.equal(hit, 1);
    assert.equal(ep.origin, 'primary');
    assert.equal(ep.id, 'a');
  });
});

test('detectBestEndpoint: 第一个网络失败切第二个；全挂时回第一候选且不抛', async () => {
  await withTempConfigFile(VALID_CONFIG, async (p) => {
    // 第二个活：切过去
    const tried = [];
    const ep1 = await detectBestEndpoint({
      fetch: async (url) => {
        tried.push(new URL(String(url)).host);
        if (String(url).includes('a.example')) throw new Error('SNI reset');
        return { status: 200 };
      },
      configPath: p,
    });
    assert.deepEqual(tried, ['a.example.com', 'b.example.com']);
    assert.equal(ep1.origin, 'fallback');

    // 全挂：fail-soft 回第一候选
    const ep2 = await detectBestEndpoint({ fetch: async () => { throw new Error('down'); }, configPath: p });
    assert.equal(ep2.origin, 'primary-unverified');
    assert.equal(ep2.id, 'a');
  });
});

test('fetchWithFailover: 5xx 换下一个域名成功；401/403/429 原样返回不换', async () => {
  await withTempConfigFile(VALID_CONFIG, async (p) => {
    // 5xx → 切换后拿到 200
    const hosts = [];
    const r1 = await fetchWithFailover('/device/bind', { method: 'POST' }, {
      fetch: async (url) => {
        hosts.push(new URL(String(url)).host);
        return hosts.length === 1 ? { ok: false, status: 502, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ apiKey: 'sk-x' }) };
      },
      configPath: p,
    });
    assert.equal(r1.ok, true);
    assert.deepEqual(hosts, ['a.example.com', 'b.example.com']);

    // 429 → 不换域名（防薅羊毛限流是权威判决）
    const hosts2 = [];
    const r2 = await fetchWithFailover('/device/bind', { method: 'POST' }, {
      fetch: async (url) => {
        hosts2.push(new URL(String(url)).host);
        return { ok: false, status: 429, json: async () => ({ error: 'rate-limited' }) };
      },
      configPath: p,
    });
    assert.equal(r2.status, 429);
    assert.deepEqual(hosts2, ['a.example.com'], '429 绝不能换域名重试');
  });
});

test('fetchWithFailover: 全部端点网络异常时抛最后一个错误（调用方自行兜底）', async () => {
  await withTempConfigFile(VALID_CONFIG, (p) => {
    return assert.rejects(
      fetchWithFailover('/device/bind', {}, { fetch: async () => { throw new Error('offline'); }, configPath: p }),
      /offline/
    );
  });
});

test('fetchWithFailover: 返回 body 已解析成对象（对齐 wallet-client 的消费方式）', async () => {
  await withTempConfigFile(VALID_CONFIG, async (p) => {
    const r = await fetchWithFailover('/v1/dashboard/billing/subscription', {}, {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ hard_limit_usd: 2 }) }),
      configPath: p,
    });
    assert.equal(r.body.hard_limit_usd, 2);
  });
});

// ── 杂项 ──────────────────────────────────────────────────────────────────────

test('apiOrigin: 带 /v1 后缀的 apiBase 还原 origin', () => {
  assert.equal(apiOrigin('https://api.u-claw.org.cn/v1'), 'https://api.u-claw.org.cn');
  assert.equal(apiOrigin('https://api.u-claw.org.cn'), 'https://api.u-claw.org.cn');
});
