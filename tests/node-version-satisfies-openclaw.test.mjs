// 守卫测试：**内置的 Node 版本必须跑得动我们 pin 的那个 OpenClaw**。
//
// 为什么需要它（2026-08-23 真机跑出来的线上故障）：
//
//   openclaw 2026.6.34 的 engines 是 >=22.19.0，我们当时 pin 的 Node v22.22.1 够用。
//   openclaw 2026.7.1  把 engines 提到更高的 22.22 补丁号，v22.22.1 就**差 2 个补丁号**。
//   于是 U 盘一插、双击启动，网关直接退出：
//
//     OpenClaw exited unexpectedly (code 1)
//
//   受影响的已发布版本：v2.1.15 / v2.1.16 / v2.1.17 —— 也就是说仓库里挂着的下载包
//   有三个版本是开不了机的，而 CI 全绿、单测全绿、构建成功。
//
// 根因是结构性的：track-upstream.yml 每天自动 bump OPENCLAW_VERSION 并自动发版，
// 但**从来不检查随包发出去的 Node 还够不够新**。自动化只跟了一半。
//
// 加上这条测试之后，上游再提 engines 要求，这里当场变红，而不是等客户报「打不开」。
//
// 附带守住第二件事：Node 版本在这个仓库里散落在 11 个文件里（setup.bat / setup.sh /
// setup.ps1 / Windows-Install.bat / Mac-Install.command / install.sh / install.ps1 /
// release.yml / setup-openclaw.sh / ci.yml / track-upstream.yml）。同一事实存在几份
// 就会漂几份（开发宪法第 8 条）—— 这里断言它们全部一致。CI 与出货运行时对齐这件事，
// 就是靠把 ci.yml 也纳进这份名单来防复发的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

// 所有会把 Node 装进产物的地方。u-claw-app/ 是 2026-06-19 废弃的 Electron 桌面版
// （见 u-claw-app/DEPRECATED.md），既不构建也不发布，故意不纳入。
const NODE_PIN_FILES = [
  'portable/setup.bat',
  'portable/setup.sh',
  'portable/setup.ps1',
  'portable/Windows-Install.bat',
  'portable/Mac-Install.command',
  'install/install.sh',
  'install/install.ps1',
  '.github/workflows/release.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/track-upstream.yml',
  'bootable/linux-setup/setup-openclaw.sh',
];

/**
 * 从脚本里抠出它 pin 的 Node 版本（统一归一化成 vX.Y.Z 形式）。
 *
 * 只认「Node 版本变量的赋值行」，不能直接全文扫 /v\d+\.\d+\.\d+/ ——
 * 那样会把产品自己的版本号（v2.1.0、v2026.5.2 等）一起抓进来，测试就永远红。
 * 各生态的写法都在这：
 *   set "NODE_VERSION=v24.22.1"      (bat)
 *   NODE_VERSION="v24.22.1"          (sh)
 *   $nodeVersion = "v24.22.1"        (ps1)
 *   node_version="v24.22.1"          (yml, release.yml)
 *   node-version: 24.22.1            (yml, actions/setup-node)
 *   set "NODE_VER=v24.22.1"          (Windows-Install.bat)
 */
function pinnedNodeVersions(text) {
  const re = /(?:NODE_VERSION|NODE_VER|nodeVersion|node_version|node-version)\s*[=:]\s*["']?v?(\d+\.\d+\.\d+)/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(`v${m[1]}`);
  return [...out];
}

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function cmp(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * 判断 version 是否满足 openclaw 那种 engines 串：
 *   ">=24.22.1 <25 || >=26.12.1"
 * 只需支持 >= 和 < 两种比较 + || 分支，够覆盖 node engines 的实际写法。
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return String(range)
    .split('||')
    .some((branch) =>
      branch
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((clause) => {
          const m = clause.match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
          if (!m) return false;
          const op = m[1] || '=';
          const parts = m[2].split('.').map(Number);
          const target = { major: parts[0], minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
          const c = cmp(v, target);
          if (op === '>=') return c >= 0;
          if (op === '>') return c > 0;
          if (op === '<=') return c <= 0;
          if (op === '<') return c < 0;
          return c === 0;
        })
    );
}

// 自检：上面那个 satisfies 自己得是对的，否则它可能永远返回 true，测试就成了摆设。
test('satisfies() 自身可信（这是本文件其余断言的地基）', () => {
  // 当前 openclaw 声明的 engines 形状：只放行 24.22.1+ 与 26.12.1+。
  const RANGE = '>=24.22.1 <25 || >=26.12.1';
  assert.equal(satisfies('v24.22.1', RANGE), true, '边界值本身应满足');
  assert.equal(satisfies('v24.22.0', RANGE), false, '差一个补丁号也不行');
  assert.equal(satisfies('v22.22.1', RANGE), false, '这正是 v2.1.15~17 线上坏掉的那个版本');
  assert.equal(satisfies('v23.0.0', RANGE), false, '23.x 不在任何分支里');
  assert.equal(satisfies('v24.23.0', RANGE), true);
  assert.equal(satisfies('v25.0.0', RANGE), false, '25.x 被 <25 排除');
  assert.equal(satisfies('v26.12.1', RANGE), true);
  assert.equal(satisfies('v26.12.0', RANGE), false);
  assert.equal(satisfies('v27.0.0', RANGE), true, '比 26.x 更新的大版本默认放行');

  // 老 openclaw 的宽松写法（>=22.19.0）也要能解析，证明比较器不只认得一种形状。
  const legacyRange = '>=22.19.0 <23 || >=24.15.0 <25 || >=25.9.0';
  assert.equal(satisfies('v22.19.0', legacyRange), true, '边界值本身应满足');
  assert.equal(satisfies('v22.18.9', legacyRange), false);
  assert.equal(satisfies('v23.0.0', legacyRange), false, '23.x 被 <23 排除');
  assert.equal(satisfies('v24.15.0', legacyRange), true);
  assert.equal(satisfies('v24.14.9', legacyRange), false);
});

test('所有脚本 pin 的 Node 版本必须完全一致（防 11 个文件各漂各的）', () => {
  const found = new Map();
  for (const f of NODE_PIN_FILES) {
    // 名单里的文件被挪走时必须改这里，不能静默跳过——否则 ci.yml 改名后
    // 「CI 与出货版本一致」这条守卫会悄悄失效。
    assert.ok(existsSync(join(repoRoot, f)), `NODE_PIN_FILES 里列的文件不存在：${f}`);
    for (const v of pinnedNodeVersions(read(f))) {
      if (!found.has(v)) found.set(v, []);
      found.get(v).push(f);
    }
  }

  assert.ok(found.size > 0, '一个 Node 版本都没抠到，说明抓取规则失效了');
  assert.equal(
    found.size,
    1,
    `Node 版本在不同脚本里不一致，会导致「某条安装路径能用、另一条开不了机」：\n` +
      [...found.entries()].map(([v, fs]) => `  ${v}  ←  ${fs.join(', ')}`).join('\n')
  );
});

test('bootable Linux 安装自检期望的 Node 版本必须与出货 pin 一致', () => {
  // 这条脚本装对了也会告警，就是因为把旧版本号写死在断言里。
  const [pin] = pinnedNodeVersions(read('portable/setup.bat'));
  const script = read('bootable/linux-setup/test-installation.sh');
  const expected = [...new Set([...script.matchAll(/v\d+\.\d+\.\d+/g)].map((m) => m[0]))];
  assert.deepEqual(
    expected,
    [pin],
    `test-installation.sh 期望 ${expected.join(', ') || '(无)'}，出货 pin 是 ${pin}；` +
      `版本不一致时用户装对了也会被 warn。`
  );
});

test('内置 Node 必须满足所 pin 的 OpenClaw 的 engines 要求（v2.1.15~17 就是栽在这）', () => {
  const openclawVersion = read('OPENCLAW_VERSION').trim();
  assert.ok(openclawVersion, 'OPENCLAW_VERSION 读不到');

  const versions = pinnedNodeVersions(read('portable/setup.bat'));
  assert.equal(versions.length, 1, `setup.bat 里应该只有一个 Node 版本，实际：${versions}`);
  const nodeVersion = versions[0];

  // engines 要求以「实际装进产物的那个 openclaw」为准。装过就直接读它的 package.json，
  // 没装过（干净检出）就跳过——不能因为没跑过 setup 就让测试假红。
  const pkgPath = process.env.UCLAW_TEST_CORE_DIR
    ? join(process.env.UCLAW_TEST_CORE_DIR, 'node_modules/openclaw/package.json')
    : join(repoRoot, 'portable/app/core/node_modules/openclaw/package.json');
  if (!existsSync(pkgPath)) {
    console.log(
      `  (跳过 engines 比对：portable/app/ 还没装。跑 setup 后本条才有实质意义。` +
        `CI 里 release.yml 装完 openclaw 之后应当再跑一次本测试。)`
    );
    return;
  }

  const runtimePackage = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(runtimePackage.version, openclawVersion, '校验的运行时必须与发布 pin 相同');
  const engines = runtimePackage.engines?.node;
  assert.ok(engines, `openclaw ${openclawVersion} 没有声明 engines.node`);

  assert.ok(
    satisfies(nodeVersion, engines),
    `内置 Node ${nodeVersion} 跑不动 openclaw ${openclawVersion}（要求 ${engines}）。\n` +
      `  这不是警告——U 盘插上去会直接报 "OpenClaw exited unexpectedly (code 1)"。\n` +
      `  修法：把上面 NODE_PIN_FILES 里所有脚本的 Node 版本一起升到满足 ${engines} 的版本，\n` +
      `  并确认 npmmirror 上四个平台的包都存在（win-x64 / darwin-arm64 / darwin-x64 / linux-x64）。`
  );
});
