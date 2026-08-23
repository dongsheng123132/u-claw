// 守卫测试：**SHA256SUMS 必须覆盖 vendor 目录里的每一个产物，不能只覆盖"本次构建产的那部分"。**
//
// 2026-08-23 打真 seed 时踩到的：
//   第一次构建在打包步骤超时挂掉。那次已经下好并逐字节校验过的
//   node-v22.23.2-win-x64.zip 留在了目录里，但 writeChecksums 只在两步都走完之后
//   才调用，所以从没被写进 SHA256SUMS。
//   第二次带 --skip-node 重跑，只记了内核。
//   结果：vendor 目录里躺着两个包，SHA256SUMS 只列了一个。
//
// 这个状态最危险的地方是**它看起来是好的**：
//   `sha256sum -c SHA256SUMS` 只校验**列出来的**文件，少列一个它照样全绿；
//   CI 的 Verify 步骤全绿；客户首启拿它当全覆盖的完整性依据，也不会报错。
//   一份"看着齐全、实际只保一半"的完整性文件，比没有更危险。
//
// 修法是在 writeChecksums 里补算 outDir 中未被记录的产物。这条测试守住它。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeChecksums } from '../portable/scripts/build-seed.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function makeDir() {
  return mkdtemp(path.join(tmpdir(), 'uclaw-cksum-'));
}

function parse(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

test('上一次构建中途失败留下的产物，会被补算进 SHA256SUMS', async () => {
  const dir = await makeDir();
  try {
    // 模拟现场：node 包在（上次构建下好了但没记），本次只产内核
    await writeFile(path.join(dir, 'node-v22.23.2-win-x64.zip'), 'fake-node');
    await writeFile(path.join(dir, 'openclaw-2026.7.1-2-win-x64.tar.gz'), 'fake-kernel');

    await writeChecksums(dir, new Map([['openclaw-2026.7.1-2-win-x64.tar.gz', sha('fake-kernel')]]));

    const map = parse(await readFile(path.join(dir, 'SHA256SUMS'), 'utf8'));
    assert.equal(map.size, 2, 'vendor 里有两个产物，SHA256SUMS 就该有两条');
    assert.equal(map.get('openclaw-2026.7.1-2-win-x64.tar.gz'), sha('fake-kernel'));
    assert.equal(
      map.get('node-v22.23.2-win-x64.zip'), sha('fake-node'),
      '上次构建遗留的 Node 包必须被补算——否则 sha256sum -c 会漏校验它却依然全绿',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('本次构建传进来的哈希优先于磁盘现算（不会被补算逻辑覆盖）', async () => {
  const dir = await makeDir();
  try {
    await writeFile(path.join(dir, 'openclaw-1.0.0-win-x64.tar.gz'), 'fake-kernel');
    const declared = sha('fake-kernel');
    await writeChecksums(dir, new Map([['openclaw-1.0.0-win-x64.tar.gz', declared]]));
    const map = parse(await readFile(path.join(dir, 'SHA256SUMS'), 'utf8'));
    assert.equal(map.get('openclaw-1.0.0-win-x64.tar.gz'), declared);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('指向已不存在文件的旧条目会被丢掉（升版本换包后不能留死条目）', async () => {
  const dir = await makeDir();
  try {
    await writeFile(
      path.join(dir, 'SHA256SUMS'),
      `${sha('old')}  node-v22.22.3-win-x64.zip\n`,
    );
    await writeFile(path.join(dir, 'node-v22.23.2-win-x64.zip'), 'fake-node');

    await writeChecksums(dir, new Map([['node-v22.23.2-win-x64.zip', sha('fake-node')]]));

    const map = parse(await readFile(path.join(dir, 'SHA256SUMS'), 'utf8'));
    assert.ok(!map.has('node-v22.22.3-win-x64.zip'), '旧版本的包已经不在盘上，条目必须清掉');
    assert.ok(map.has('node-v22.23.2-win-x64.zip'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SHA256SUMS 自己和 .tmp 中间文件不进清单', async () => {
  const dir = await makeDir();
  try {
    await writeFile(path.join(dir, 'openclaw-1.0.0-win-x64.tar.gz'), 'k');
    await writeFile(path.join(dir, '.openclaw-1.0.0-win-x64.123.tar.gz.tmp'), 'half-written');

    await writeChecksums(dir, new Map([['openclaw-1.0.0-win-x64.tar.gz', sha('k')]]));

    const map = parse(await readFile(path.join(dir, 'SHA256SUMS'), 'utf8'));
    assert.equal(map.size, 1, '只该有内核那一条');
    assert.ok(!map.has('SHA256SUMS'));
    assert.ok(
      ![...map.keys()].some((k) => k.endsWith('.tmp')),
      '半截的 .tmp 是上次失败留下的垃圾，绝不能当成产物记进完整性清单',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
