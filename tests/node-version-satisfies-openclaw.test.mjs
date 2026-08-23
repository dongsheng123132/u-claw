// 守卫测试：**内置的 Node 版本必须跑得动我们 pin 的那个 OpenClaw**。
//
// 为什么需要它（2026-08-23 真机跑出来的线上故障）：
//
//   openclaw 2026.6.34 的 engines 是 >=22.19.0，我们 pin 的 Node v22.22.1 够用。
//   openclaw 2026.7.1  把 engines 提到 >=22.22.3，我们的 v22.22.1 就**差 2 个补丁号**。
//   于是 U 盘一插、双击启动，网关直接退出：
//
//     openclaw: Node.js >=22.22.3 <23 ... is required (current: v22.22.1)
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
// 附带守住第二件事：Node 版本在这个仓库里被抄了 8 份（setup.bat / setup.sh /
// setup.ps1 / Windows-Install.bat / Mac-Install.command / install.sh / install.ps1 /
// release.yml）。同一事实存在几份就会漂几份（开发宪法第 8 条）—— 这里断言它们全部一致。

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
  'bootable/linux-setup/setup-openclaw.sh',
];

/**
 * 从脚本里抠出它 pin 的 Node 版本（形如 v22.22.3）。
 *
 * 只认「Node 版本变量的赋值行」，不能直接全文扫 /v\d+\.\d+\.\d+/ ——
 * 那样会把产品自己的版本号（v2.1.0、v2026.5.2 等）一起抓进来，测试就永远红。
 * 各生态的写法都在这：
 *   set "NODE_VERSION=v22.22.3"      (bat)
 *   NODE_VERSION="v22.22.3"          (sh)
 *   $nodeVersion = "v22.22.3"        (ps1)
 *   node_version="v22.22.3"          (yml)
 *   set "NODE_VER=v22.22.3"          (Windows-Install.bat)
 */
function pinnedNodeVersions(text) {
  const re = /(?:NODE_VERSION|NODE_VER|nodeVersion|node_version)\s*=\s*["']?(v\d+\.\d+\.\d+)/gi;
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(m[1]);
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
 *   ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0"
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
  const RANGE = '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0';
  assert.equal(satisfies('v22.22.3', RANGE), true, '边界值本身应满足');
  assert.equal(satisfies('v22.22.1', RANGE), false, '这正是线上坏掉的那个版本');
  assert.equal(satisfies('v22.16.0', RANGE), false);
  assert.equal(satisfies('v23.0.0', RANGE), false, '23.x 被 <23 排除');
  assert.equal(satisfies('v24.15.0', RANGE), true);
  assert.equal(satisfies('v24.14.9', RANGE), false);
  assert.equal(satisfies('v22.19.0', '>=22.19.0'), true, '老 openclaw 的宽松写法');
});

test('所有脚本 pin 的 Node 版本必须完全一致（防 8 份副本各漂各的）', () => {
  const found = new Map();
  for (const f of NODE_PIN_FILES) {
    const p = join(repoRoot, f);
    if (!existsSync(p)) continue; // 文件被挪走时不误报，由下一条断言兜底
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

test('内置 Node 必须满足所 pin 的 OpenClaw 的 engines 要求（v2.1.15~17 就是栽在这）', () => {
  const openclawVersion = read('OPENCLAW_VERSION').trim();
  assert.ok(openclawVersion, 'OPENCLAW_VERSION 读不到');

  const versions = pinnedNodeVersions(read('portable/setup.bat'));
  assert.equal(versions.length, 1, `setup.bat 里应该只有一个 Node 版本，实际：${versions}`);
  const nodeVersion = versions[0];

  // engines 要求以「实际装进产物的那个 openclaw」为准。装过就直接读它的 package.json，
  // 没装过（干净检出）就跳过——不能因为没跑过 setup 就让测试假红。
  const pkgPath = join(repoRoot, 'portable/app/core/node_modules/openclaw/package.json');
  if (!existsSync(pkgPath)) {
    console.log(
      `  (跳过 engines 比对：portable/app/ 还没装。跑 setup 后本条才有实质意义。` +
        `CI 里 release.yml 装完 openclaw 之后应当再跑一次本测试。)`
    );
    return;
  }

  const engines = JSON.parse(readFileSync(pkgPath, 'utf8')).engines?.node;
  assert.ok(engines, `openclaw ${openclawVersion} 没有声明 engines.node`);

  assert.ok(
    satisfies(nodeVersion, engines),
    `内置 Node ${nodeVersion} 跑不动 openclaw ${openclawVersion}（要求 ${engines}）。\n` +
      `  这不是警告——U 盘插上去会直接报 "OpenClaw exited unexpectedly (code 1)"。\n` +
      `  修法：把上面 NODE_PIN_FILES 里所有脚本的 Node 版本一起升到满足 ${engines} 的版本，\n` +
      `  并确认 npmmirror 上四个平台的包都存在（win-x64 / darwin-arm64 / darwin-x64 / linux-x64）。`
  );
});
