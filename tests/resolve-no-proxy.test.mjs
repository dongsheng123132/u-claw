// resolve-no-proxy 的主机分类测试
//
// 回归的是一个方向性错误：这个脚本本意是让**内网模型**绕开公司代理，
// 但改造前它把所有 baseUrl 一视同仁，连 api.deepseek.com 也塞进了 NO_PROXY。
// 公司机器上 HTTP_PROXY 常常是唯一出网路径，公网主机进了 NO_PROXY 就变成强制
// 直连 → 模型彻底连不上，正好是它想解决的问题的反面。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isIntranetHost, resolveNoProxy } from '../portable/lib/resolve-no-proxy.mjs';

test('私网 / 回环 / 链路本地 IPv4 判为内网', () => {
  for (const host of [
    '127.0.0.1', '127.1.2.3',
    '10.0.0.1', '10.255.255.254',
    '172.16.0.1', '172.20.10.5', '172.31.255.254',
    '192.168.1.100',
    '169.254.10.20',      // 链路本地
    '100.64.0.1', '100.127.255.254',  // CGNAT / Tailscale
  ]) {
    assert.equal(isIntranetHost(host), true, `${host} 应判为内网`);
  }
});

test('公网 IPv4 不判为内网（含私网段的边界外侧）', () => {
  for (const host of [
    '8.8.8.8', '1.1.1.1',
    '172.15.0.1', '172.32.0.1',   // 172.16/12 的两侧
    '192.167.1.1', '192.169.1.1', // 192.168/16 的两侧
    '11.0.0.1', '9.255.255.255',  // 10/8 的两侧
    '100.63.0.1', '100.128.0.1',  // 100.64/10 的两侧
    '169.253.0.1',
  ]) {
    assert.equal(isIntranetHost(host), false, `${host} 是公网，不该进 NO_PROXY`);
  }
});

test('IPv6 的 ULA 与链路本地判为内网，公网 v6 不判', () => {
  assert.equal(isIntranetHost('::1'), true);
  assert.equal(isIntranetHost('[::1]'), true, '方括号形式也要认');
  assert.equal(isIntranetHost('fd00:1234::1'), true, 'ULA');
  assert.equal(isIntranetHost('fc00::1'), true, 'ULA');
  assert.equal(isIntranetHost('fe80::1'), true, '链路本地');
  assert.equal(isIntranetHost('2001:4860:4860::8888'), false, 'Google DNS 是公网');
});

test('无点主机名与内网后缀域名判为内网', () => {
  for (const host of ['ai-server', 'gpu01', 'llm.local', 'model.internal', 'box.lan', 'svc.corp']) {
    assert.equal(isIntranetHost(host), true, `${host} 应判为内网`);
  }
});

test('公网域名不判为内网', () => {
  for (const host of [
    'api.deepseek.com', 'api.openai.com', 'api.anthropic.com',
    'api.u-claw.org', 'dashscope.aliyuncs.com', 'localhost.attacker.com',
  ]) {
    assert.equal(isIntranetHost(host), false, `${host} 是公网，不该进 NO_PROXY`);
  }
});

test('非法输入不炸', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}, '999.999.999.999']) {
    assert.equal(isIntranetHost(bad), false);
  }
});

// ── 端到端 ──────────────────────────────────────────────────────────────────

test('内网 + 公网混配时，只有内网主机进 NO_PROXY', () => {
  const config = {
    models: {
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
        openai:   { baseUrl: 'https://api.openai.com/v1' },
        neiwang:  { baseUrl: 'http://10.20.30.40:8000/v1' },
        jifang:   { baseUrl: 'http://gpu-node-3:9000/v1' },
      },
    },
  };
  const r = resolveNoProxy(config, {});

  assert.ok(r.merged.includes('10.20.30.40'), '内网 IP 必须进');
  assert.ok(r.merged.includes('gpu-node-3'), '内网短名必须进');
  // 这两条就是那个 bug 的回归断言
  assert.equal(r.merged.includes('api.deepseek.com'), false, '公网主机进了 NO_PROXY 会让公司机器彻底连不上');
  assert.equal(r.merged.includes('api.openai.com'), false);

  assert.deepEqual(r.skipped.sort(), ['api.deepseek.com', 'api.openai.com']);
  // 回环始终保留
  for (const h of ['localhost', '127.0.0.1', '::1']) assert.ok(r.merged.includes(h));
});

test('已有的 NO_PROXY 会被保留，不覆盖用户设置', () => {
  const config = { models: { providers: { x: { baseUrl: 'http://192.168.1.5:11434/v1' } } } };
  const r = resolveNoProxy(config, { NO_PROXY: 'corp.example.com,10.9.9.9' });
  assert.ok(r.merged.includes('corp.example.com'));
  assert.ok(r.merged.includes('10.9.9.9'));
  assert.ok(r.merged.includes('192.168.1.5'));
});

test('只配了公网模型时不产生 NO_PROXY 内网条目', () => {
  const config = { models: { providers: { ds: { baseUrl: 'https://api.deepseek.com/v1' } } } };
  const r = resolveNoProxy(config, {});
  assert.deepEqual(r.intranet, [], '没有内网主机时不该硬塞');
  assert.deepEqual(r.skipped, ['api.deepseek.com']);
});

test('缺协议的写法也能解析出主机', () => {
  const config = { models: { providers: { x: { baseUrl: '192.168.0.9:8080/v1' } } } };
  assert.ok(resolveNoProxy(config, {}).merged.includes('192.168.0.9'));
});

test('baseURL 大小写变体也收', () => {
  const config = { models: { providers: { x: { baseURL: 'http://10.1.1.1/v1' } } } };
  assert.ok(resolveNoProxy(config, {}).merged.includes('10.1.1.1'));
});
