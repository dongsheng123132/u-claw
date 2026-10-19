// 守卫测试：PicoClaw（Lite 内核）供应链。
//
// 这是第三方 MIT 二进制，冻结供应商版本，不随 OpenClaw 自动更新。本文件锁三件事：
//   1. manifest（portable/picoclaw-runtime.json）是版本/SHA 的唯一真相源，形状齐全且不可漂；
//   2. setup.ps1 从 manifest 取值，且「解压前先校验归档 SHA」，目标落 app/picoclaw；
//   3. PicoClaw 块**不进** OpenClaw 的 patch 循环（那是 OpenClaw 专属补丁，PicoClaw 是独立二进制）。
//
// 归档 SHA ≠ exe 哈希；换 PicoClaw 版本必须重取重核 manifest.sha256，不可只 bump 版本号。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

test('picoclaw-runtime.json 是有效 JSON 且字段齐全（版本/SHA 唯一真相源）', () => {
  const m = JSON.parse(read('portable', 'picoclaw-runtime.json'));
  assert.equal(m.name, 'picoclaw', 'manifest.name 必须是 picoclaw');
  assert.match(m.version, /^v\d+\.\d+\.\d+$/, 'version 形如 v0.3.1');
  assert.match(m.asset_url, /^https:\/\//, 'asset_url 必须是 https');
  assert.match(m.sha256, /^[0-9a-f]{64}$/, '归档 sha256 必须是 64 位小写 hex');
  assert.match(m.binary_sha256, /^[0-9a-f]{64}$/, 'binary_sha256 必须是 64 位小写 hex');
  assert.notEqual(m.sha256, m.binary_sha256, '归档 hash 与 exe hash 是两个不同事实');
  assert.ok(Number.isInteger(m.binary_size) && m.binary_size > 0, 'binary_size 是正整数字节数');
  assert.equal(m.platform, 'windows-x64', '当前仅验证 windows-x64');
  assert.equal(m.install_dir, 'app/picoclaw', '安装目录固定为 app/picoclaw');
  assert.match(m.license, /MIT/i, 'PicoClaw 为 MIT 第三方二进制');
  assert.match(m.license_notice, /Copyright \(c\) 2026 PicoClaw contributors/, '版权行必须与上游 LICENSE 原文一致');
});

test('setup.ps1 从 manifest 取值，SHA 严格 64hex 不做 replace 归一', () => {
  const setup = read('portable', 'setup.ps1');
  assert.match(setup, /picoclaw-runtime\.json/, 'setup 必须读取 picoclaw-runtime.json');
  assert.match(
    setup,
    /\$picoManifestPath\s*=\s*Join-Path \$PSScriptRoot 'picoclaw-runtime\.json'/,
    'setup 必须把 manifest 路径读进变量',
  );
  assert.match(
    setup,
    /\$picoManifest\s*=\s*Get-Content -LiteralPath \$picoManifestPath/,
    'setup 必须把 manifest 解析进 \$picoManifest',
  );
  assert.match(setup, /\$picoManifest\.version/, '版本来自 manifest');
  assert.match(setup, /\$picoManifest\.asset_url/, '下载 URL 来自 manifest');
  assert.match(setup, /\$picoManifest\.sha256/, '归档 SHA 来自 manifest');
  assert.match(setup, /\$picoManifest\.binary_sha256/, 'exe SHA 来自 manifest');
  assert.match(setup, /'\^\[0-9a-fA-F\]\{64\}\$'/, 'SHA 必须严格校验 64 hex');
  assert.doesNotMatch(setup, /-replace\s+'\[\^0-9a-fA-F\]'/, '不得用 replace 无效字符来“修”SHA');
});

test('setup.ps1 用 hash 校验既有 exe，不执行第三方代码', () => {
  const setup = read('portable', 'setup.ps1');
  assert.match(setup, /\(Get-Sha256 \$picoExe\) -ne \$picoBinarySha256/, '已有 exe 直接比对 binary hash');
  assert.doesNotMatch(setup, /picoExe[^\n]*--version/, '不执行 --version（未经核实的命令）');
  assert.doesNotMatch(setup, /picoExe[^\n]*\bversion\b/, '不执行 version 子命令（保持纯静态校验）');
});

test('setup.ps1 解压前先校验归档 SHA-256，解压后再校验 exe hash', () => {
  const setup = read('portable', 'setup.ps1');
  const dl = setup.indexOf('Download $picoAssetUrl');
  const verify = setup.indexOf('(Get-Sha256 $picoArchive) -ne $picoSha256');
  const extract = setup.indexOf('Expand-Archive -LiteralPath $picoArchive');
  const verifyExe = setup.indexOf('(Get-Sha256 $found[0].FullName) -ne $picoBinarySha256');
  assert.ok(dl > 0, '应下载 PicoClaw 归档');
  assert.ok(verify > 0, '应校验归档 SHA');
  assert.ok(extract > 0, '应解压归档');
  assert.ok(verifyExe > 0, '应校验 exe SHA');
  assert.ok(dl < verify, '先下载');
  assert.ok(verify < extract, '校验必须在解压之前（解压前校验，防污染归档落地）');
  assert.ok(extract < verifyExe, '解压后比对 exe hash');
});

test('setup.ps1 只接受唯一 exe，不把 zip 本身复制进 app', () => {
  const setup = read('portable', 'setup.ps1');
  assert.match(setup, /\$found\.Count -ne 1/, '归档必须恰有一个 picoclaw.exe');
  assert.match(setup, /\$picoExtract\s*=\s*Join-Path \$picoTmp 'extracted'/, 'zip 与解压目录分离');
  assert.match(setup, /Copy-Item -LiteralPath \$found\[0\]\.FullName -Destination \$picoExe/, '只复制 exe');
  assert.doesNotMatch(setup, /Copy-Item[^\n]*picoclaw\.zip/, '绝不把 zip 复制进安装目录');
  assert.match(setup, /Test-Path[^\n]*'LICENSE'/, 'LICENSE 随二进制一起保留');
});

test('setup.ps1 目标安装目录为 app/picoclaw', () => {
  const setup = read('portable', 'setup.ps1');
  assert.match(
    setup,
    /\$picoInstallDir\s*=\s*Join-Path \$PSScriptRoot 'app\/picoclaw'/,
    'PicoClaw 必须装到 app/picoclaw',
  );
  assert.match(setup, /app\/picoclaw[\s\S]*?picoclaw\.exe/, '安装产出 picoclaw.exe');
});

test('PicoClaw 安装块在 OpenClaw patch 循环之外', () => {
  const setup = read('portable', 'setup.ps1');
  const picoBlock = setup.indexOf("PicoClaw（Lite 内核）");
  const patchLoop = setup.indexOf("patch-managed-browser-root.mjs");
  assert.ok(picoBlock > 0, '应存在 PicoClaw 安装块');
  assert.ok(patchLoop > 0, '应存在 OpenClaw patch 循环');
  assert.ok(
    picoBlock < patchLoop,
    'PicoClaw 块必须在 OpenClaw patch 循环之前（且不放在循环 body 里，否则会当成 OpenClaw 补丁）',
  );
  // PicoClaw 不应出现在 patch 循环的文件清单里
  const loopBody = setup.slice(patchLoop, patchLoop + 400);
  assert.ok(
    !/picoclaw/.test(loopBody),
    'patch 循环里不应出现 picoclaw（它是独立二进制，不是 OpenClaw 补丁）',
  );
});

test('PicoClaw 安装块存在且对 windows-x64 之外显式跳过', () => {
  const setup = read('portable', 'setup.ps1');
  assert.match(
    setup,
    /\$picoManifest\.platform\s*-ne\s*'windows-x64'/,
    '非 windows-x64 平台应显式跳过、不假报安装成功',
  );
});
