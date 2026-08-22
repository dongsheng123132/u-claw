// seed-channel.test.mjs — 版本通道与 seed 构建的卡口
//
// 存在的唯一理由是 2026-08-22 那次真机翻车：
// runtime-channel.json 钉 Node 22.22.1、minimumVersion 写 22.14.0，
// 离线 seed 装得好好的，网关一起就报
//   openclaw: Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0 is required (current: v22.22.1)
// —— 「解压即用」在最后一米碎掉，而所有单元测试都是绿的，因为没人跑过真东西。
//
// track-upstream.yml 每天自动升 OPENCLAW_VERSION，engines.node 会随之悄悄收紧。
// 所以这里钉两层：
//   1. 通道文件自身的一致性（这一层能在 CI 里秒级跑）
//   2. satisfiesRange 的语义正确性，尤其是那次翻车的具体版本组合
// 「装好的内核 engines 与通道对不对得上」这条卡在 build-seed.mjs 里（那里才有真包）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { satisfiesRange } from '../portable/scripts/build-seed.mjs';

const PORTABLE = fileURLToPath(new URL('../portable', import.meta.url));
const channel = JSON.parse(readFileSync(join(PORTABLE, 'config', 'runtime-channel.json'), 'utf8'));

// openclaw 2026.7.1-2 的真实 engines.node，从装好的树里抄来的。
// 这不是第二份真相源：真值在内核包里，build-seed.mjs 每次构建都拿真包比对；
// 这里只是把"翻车时的那个具体范围"固化成回归用例。
const ENGINES_AT_2026_7_1_2 = '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0';

test('翻车的那组版本必须判为不满足 —— 22.22.1 是当时钉的值', () => {
  assert.equal(satisfiesRange('22.22.1', ENGINES_AT_2026_7_1_2), false);
  assert.equal(satisfiesRange('22.14.0', ENGINES_AT_2026_7_1_2), false, '当时的 minimumVersion 也不满足');
});

test('修好的那组版本必须判为满足', () => {
  assert.equal(satisfiesRange('22.23.2', ENGINES_AT_2026_7_1_2), true);
  assert.equal(satisfiesRange('22.22.3', ENGINES_AT_2026_7_1_2), true, '边界值：正好等于下界');
});

test('多段 range 的每一段都要认，跨大版本上界要拦住', () => {
  assert.equal(satisfiesRange('24.19.0', ENGINES_AT_2026_7_1_2), true);
  assert.equal(satisfiesRange('25.9.0', ENGINES_AT_2026_7_1_2), true);
  assert.equal(satisfiesRange('23.0.0', ENGINES_AT_2026_7_1_2), false, '23.x 被 <23 挡住');
  assert.equal(satisfiesRange('24.14.0', ENGINES_AT_2026_7_1_2), false, '低于 24 段的下界');
  assert.equal(satisfiesRange('25.0.0', ENGINES_AT_2026_7_1_2), false, '低于 25 段的下界');
});

test('缺位版本按补 0 解析（engines 里 "<23" 就是这么写的）', () => {
  assert.equal(satisfiesRange('22.23.2', '>=22 <23'), true);
  assert.equal(satisfiesRange('23.0.0', '>=22 <23'), false);
  assert.equal(satisfiesRange('v22.23.2', '>=22.23.2'), true, '带 v 前缀也要认');
});

test('看不懂的比较符宁可判不满足，不许猜出一个"通过"', () => {
  // ^ / ~ 没在 engines.node 里出现过；真出现了应该人工看一眼，
  // 而不是让构建带着一个猜出来的结论继续往下走。
  assert.equal(satisfiesRange('22.23.2', '^22.23.0'), false);
});

// ── 通道文件自身 ────────────────────────────────────────────────────────────

test('通道钉的 Node 版本不低于它自己声明的最低版本', () => {
  assert.equal(
    satisfiesRange(channel.node.version, `>=${channel.node.minimumVersion}`),
    true,
    `node.version=${channel.node.version} 低于 node.minimumVersion=${channel.node.minimumVersion}`,
  );
});

test('每个平台目标的压缩包文件名都带着通道钉的那个版本号', () => {
  for (const [target, spec] of Object.entries(channel.node.targets)) {
    assert.ok(
      spec.archive.includes(`v${channel.node.version}`),
      `${target} 的 archive=${spec.archive} 与 node.version=${channel.node.version} 不一致 —— ` +
      '升 Node 时漏改文件名，客户断网首启会找不到 seed',
    );
    assert.match(spec.sha256, /^[0-9a-f]{64}$/, `${target} 的 sha256 不像一个 SHA-256`);
  }
});

test('内核版本仍然只从 OPENCLAW_VERSION 来，通道里不许自带一份', () => {
  assert.equal(channel.kernel.versionFrom, 'OPENCLAW_VERSION');
  assert.equal(channel.kernel.version, undefined, '通道里出现了第二份内核版本，必然漂移');
});
