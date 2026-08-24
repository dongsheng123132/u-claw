// runtime-paths-fallback.test.mjs — 本机不可写时的降级回落 U 盘（portable-strict）
//
// 钉住的是开发计划 §3 空间治理最后一条：
//   `%LOCALAPPDATA%` 不可写（组策略 / deny ACL / 漫游配置同步）时，
//   **启动器**必须降级回落 U 盘直跑，不许启动失败。
//
// 为什么必须有测试：这条契约在 2026-08-24 之前只写在 CLAUDE.md 和交接文档里，
// 代码从没实现过 —— 全仓库两个 prepareHostDirs() 调用点都是直接 throw
// HOST_NOT_WRITABLE，没有任何地方 catch 后回落。文档写成了既成事实，
// 没有测试钉住，于是没人发现。这个文件就是那根钉子。
//
// 同时钉住**不该降级的那一半**：安装类动作拿到 ok:false 就该硬报错，
// 别被"降级"三个字带跑偏，把 runtime.seed/install 也改成静默回落。
//
// 纯 node:test，无第三方依赖。用真实临时目录 + chmod/只读来制造不可写，
// 不 mock fs —— mock 出来的"不可写"证明不了真机上的行为（宪法 #4）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  resolveRuntimePaths,
  prepareRuntimePaths,
  prepareHostDirs,
  usbFallbackHostRoot,
} from '../portable/lib/runtime-paths.mjs';

const NODE_VERSION = '22.23.2';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'uclaw-fallback-'));
}

/** 造一个必定不可写的宿主机根：拿一个**文件**冒充目录，mkdir 必然 ENOTDIR/EEXIST。
 *  比 chmod 可靠 —— Windows 上 chmod 基本是空操作，CI 又常以管理员跑，
 *  只读位拦不住谁。用文件占位在三个平台上行为一致。 */
function unwritableHostEnv(base) {
  const localAppData = join(base, 'blocked-appdata');
  mkdirSync(localAppData, { recursive: true });
  writeFileSync(join(localAppData, 'U-Claw'), 'not a directory');
  return { LOCALAPPDATA: localAppData, PATH: '' };
}

// ── hostRoot 覆盖：降级只换根，布局不变 ────────────────────────────────────

test('hostRoot 覆盖后，第 2、3 层整体搬到新根，目录结构一字不变', () => {
  const base = resolveRuntimePaths({
    usbRoot: 'I:\\U-Claw', platform: 'win32', arch: 'x64',
    env: { LOCALAPPDATA: 'C:\\Users\\T\\AppData\\Local' }, nodeVersion: NODE_VERSION,
  });
  const moved = resolveRuntimePaths({
    usbRoot: 'I:\\U-Claw', platform: 'win32', arch: 'x64',
    env: { LOCALAPPDATA: 'C:\\Users\\T\\AppData\\Local' }, nodeVersion: NODE_VERSION,
    hostRoot: 'I:\\U-Claw\\host',
  });

  // 槽位算法不受影响 —— 降级不是换布局，是同一套布局换落点。
  assert.equal(moved.slot, base.slot, '槽位必须与本机模式一致，否则升回本机时缓存全成孤儿');

  // 第 2、3 层全部改挂新根。
  for (const key of ['sharedDir', 'runtimeDir', 'kernelsDir', 'npmCacheDir', 'downloadsDir',
                     'slotDir', 'browserDir', 'compileCacheDir', 'logsDir', 'locksDir']) {
    assert.ok(moved[key].startsWith('I:\\U-Claw\\host'), `${key} 应落在覆盖后的 hostRoot 下`);
    assert.notEqual(moved[key], base[key]);
  }

  // 第 1 层（随盘走的用户数据）**绝不能**被降级影响。
  for (const key of ['dataDir', 'stateDir', 'configFile', 'walletFile', 'vendorDir']) {
    assert.equal(moved[key], base[key], `${key} 是第 1 层，降级不该动它`);
  }
});

test('portable-strict 落点是 <usb>/host，不混进 data/', () => {
  assert.equal(usbFallbackHostRoot('I:\\U-Claw'), join('I:\\U-Claw', 'host'));
  // data/ 是用户要备份带走的东西，几百 MB 可重建的运行时不许混进去。
  assert.ok(!usbFallbackHostRoot('I:\\U-Claw').includes('data'));
});

// ── 正常路径 ────────────────────────────────────────────────────────────────

test('本机可写时用本机，mode=host，不在 U 盘留运行时目录', () => {
  const base = scratch();
  try {
    const usbRoot = join(base, 'usb');
    mkdirSync(usbRoot, { recursive: true });
    const result = prepareRuntimePaths({
      usbRoot, nodeVersion: NODE_VERSION,
      env: { LOCALAPPDATA: join(base, 'appdata'), XDG_CACHE_HOME: join(base, 'appdata') },
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'host');
    assert.ok(existsSync(result.paths.sharedDir), '本机共享目录应已建好');
    assert.ok(!existsSync(join(usbRoot, 'host')), '本机可写就不该在 U 盘上建 host/');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 降级路径：这是本文件的主角 ──────────────────────────────────────────────

test('本机不可写时降级回落 U 盘，ok 仍为 true —— 不许启动失败', () => {
  const base = scratch();
  try {
    const usbRoot = join(base, 'usb');
    mkdirSync(usbRoot, { recursive: true });
    const result = prepareRuntimePaths({
      usbRoot, nodeVersion: NODE_VERSION, env: unwritableHostEnv(base),
    });

    // 最重要的一条：受限账户不该看到启动失败。
    assert.equal(result.ok, true, '本机不可写不是致命错误，必须能继续启动');
    assert.equal(result.mode, 'portable-strict');

    // 真的落在 U 盘上，而且真的建出来了 —— 不是只改了字符串。
    assert.ok(result.paths.sharedDir.startsWith(join(usbRoot, 'host')));
    assert.ok(existsSync(result.paths.runtimeDir), 'U 盘上的运行时目录应已真实建好');
    assert.ok(existsSync(result.paths.locksDir), 'U 盘上的锁目录应已真实建好');

    // 降级要留痕，否则用户不知道自己为什么变慢了。
    assert.ok(result.degradedFrom, '应记录原本想用的本机根');
    assert.ok(result.reason, '应记录降级原因，供启动器提示用户');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('降级后用户数据仍在 U 盘 data/，不因降级而改位置', () => {
  const base = scratch();
  try {
    const usbRoot = join(base, 'usb');
    mkdirSync(usbRoot, { recursive: true });
    const degraded = prepareRuntimePaths({
      usbRoot, nodeVersion: NODE_VERSION, env: unwritableHostEnv(base),
    });
    assert.equal(degraded.mode, 'portable-strict');

    const expected = resolveRuntimePaths({ usbRoot, nodeVersion: NODE_VERSION });
    assert.equal(degraded.paths.configFile, expected.configFile);
    assert.equal(degraded.paths.walletFile, expected.walletFile);
    // 钱包永远在 U 盘 —— 降级不能变成"往宿主机多撒一份能花钱的凭证"。
    assert.ok(degraded.paths.walletFile.startsWith(usbRoot));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('本机和 U 盘都写不了才算真失败，ok=false 且两个原因都留着', () => {
  const base = scratch();
  try {
    // U 盘根用文件占位 —— 连 <usb>/host 都建不出来。
    const usbRoot = join(base, 'usb');
    writeFileSync(usbRoot, 'usb is not a directory');

    const result = prepareRuntimePaths({
      usbRoot, nodeVersion: NODE_VERSION, env: unwritableHostEnv(base),
    });

    assert.equal(result.ok, false);
    assert.equal(result.mode, 'failed');
    assert.ok(result.hostReason, '本机失败原因要留着');
    assert.ok(result.reason, 'U 盘失败原因也要留着——只报一个的话没法排查');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 不该降级的那一半 ────────────────────────────────────────────────────────

test('prepareHostDirs 本身不降级，仍老老实实返回 ok:false', () => {
  const base = scratch();
  try {
    const usbRoot = join(base, 'usb');
    mkdirSync(usbRoot, { recursive: true });
    const paths = resolveRuntimePaths({
      usbRoot, nodeVersion: NODE_VERSION, env: unwritableHostEnv(base),
    });
    const host = prepareHostDirs(paths);

    // 安装类动作（runtime.seed / runtime.install）依赖这个 ok:false 来硬报错。
    // 要是哪天有人"顺手"把降级塞进 prepareHostDirs，客户要求装到本机却
    // 静默装到了 U 盘上 —— 那正是 v2 的病根。这条断言拦住这种改法。
    assert.equal(host.ok, false, 'prepareHostDirs 必须保持"只报告不决策"');
    assert.ok(host.error);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
