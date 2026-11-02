// 守卫：macOS 便携完整包必须真的进 CI 与 Release（2026-11 新增 P0）。
//
// 背景：仓库此前在 CI 里只发 Windows zip，Mac 用户只能自己跑 setup.sh。
// 这次给 release.yml 加了 portable-mac-arm64 job；这个测试把「job 存在 →
// 产物命名/上传路径一致 → publish 依赖并上传它 → release body 有下载说明 →
// README 说清解压即用」这条链固定下来，防止后续改发版文件时悄悄掉链子。
//
// 仓库零依赖，这里不引入 YAML 解析器：按 2 空格缩进的 job 边界切块做文本断言
// （与 tests/publish-latest.test.mjs 读 release.yml 的方式同一思路）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

// 取 `  <job-id>:` 到下一个同缩进 job id 之间的整块文本。
function jobBlock(id) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `release.yml 里找不到 job: ${id}`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z][A-Za-z0-9_-]*:\s*$/.test(lines[i])) break; // 下一个 job
    out.push(lines[i]);
  }
  return out.join('\n');
}

const macJob = jobBlock('portable-mac-arm64');
const publishJob = jobBlock('publish');
const windowsJob = jobBlock('portable-windows-full');

test('macOS job 存在，且在 ubuntu 上交叉打包（不占 macOS runner 分钟）', () => {
  assert.match(macJob, /runs-on: ubuntu-latest/);
  assert.match(macJob, /actions\/checkout@v4/);
  // 交叉打包的关键：Node 二进制按 darwin 下载，npm 按 darwin-arm64 解析依赖
  assert.match(macJob, /node-\$node_version-darwin-arm64\.tar\.gz/);
  assert.match(macJob, /--os=darwin --cpu=arm64/);
});

test('macOS job 复用 Windows job 的安装/校验逻辑（patch 脚本 + engines gate）', () => {
  for (const patch of [
    'patch-managed-browser-root.mjs',
    'patch-device-pairing-retry.mjs',
    'patch-portable-filesystem.mjs',
  ]) {
    assert.ok(macJob.includes(patch), `mac job 少了 ${patch}（口径会和 Windows 包漂）`);
  }
  assert.match(macJob, /needsSetup\(root, nodeVersion, 'darwin-arm64'\)/);
  assert.match(macJob, /engines/);
});

test('macOS job 写平台标记，且遵循 runtime-requirements.mjs 的多平台列表语义', () => {
  // 标记值必须含 darwin-arm64；且追加而不是覆盖已有平台（逗号/换行分隔）
  assert.ok(macJob.includes("'darwin-arm64'"), 'mac job 没有写 darwin-arm64 平台标记');
  assert.match(macJob, /\.uclaw-runtime-platform/);
  assert.match(macJob, /tr -s ',\[:space:\]'/);
});

test('产物命名、zip 路径与 upload-artifact 路径三处一致', () => {
  // stage / zip / upload 都用同一个 tag 模板，防止再出现「zip 在 A、上传找 B」
  assert.ok(
    macJob.includes('dist/u-claw-portable-mac-arm64-${tag_name}'),
    'stage 目录命名不是 u-claw-portable-mac-arm64-${tag_name}',
  );
  assert.ok(
    macJob.includes('"u-claw-portable-mac-arm64-${tag_name}.zip"'),
    'zip 文件名不是 u-claw-portable-mac-arm64-${tag_name}.zip',
  );
  assert.match(macJob, /name: portable-mac-arm64\n\s+path: dist\/u-claw-portable-mac-arm64-\*\.zip/);
  // artifact 名不能和 Windows job 撞
  assert.match(windowsJob, /name: portable-windows-full/);
});

test('macOS 包对 exFAT/FAT32 U 盘友好：不带 symlink 条目 + 入口保留可执行位', () => {
  // macOS Node tarball 的 bin/npm、bin/npx、bin/corepack 是符号链接；exFAT/FAT32
  // 不支持 symlink，直接入 zip 会让 Mac 用户解压到 U 盘失败。CI 里把它们换成
  // 动态 import 的垫片，并用 python zipfile 对 zip 本身断言。
  assert.match(macJob, /symlink-free shim/);
  assert.ok(macJob.includes("import('%s')"), 'symlink 垫片不是动态 import 真实入口');
  assert.ok(macJob.includes('find "$mac_node" -type l'), '缺少「node 目录已无 symlink」断言');
  assert.ok(macJob.includes('zip -qr "$zip_name"'), 'macOS zip 不能用 -y 保留符号链接');
  assert.match(macJob, /0o120000/, 'zip 自检缺少 symlink 条目检测');
  assert.ok(macJob.includes('Mac-Start.command'), 'zip 自检没校验 Mac-Start.command 可执行位');
});

test('macOS job 内置 Node 版本与仓库唯一 pin 一致（防 9 份副本各漂各的）', () => {
  // 同一事实的真相源是 portable/setup.sh 的 NODE_VERSION
  const setupSh = readFileSync(join(repoRoot, 'portable', 'setup.sh'), 'utf8');
  const pinned = setupSh.match(/NODE_VERSION="(v\d+\.\d+\.\d+)"/)?.[1];
  assert.ok(pinned, 'portable/setup.sh 里找不到 NODE_VERSION');
  assert.ok(
    macJob.includes(`node_version="${pinned}"`),
    `mac job 的 node_version 必须是 ${pinned}（与 setup.sh / Windows job 一致）`,
  );
});

test('publish 依赖两个平台的 job，并把 mac zip 一起上传到 Release', () => {
  const needsLine = publishJob.match(/^\s+needs:\s*\[(.*)\]\s*$/m);
  assert.ok(needsLine, 'publish job 没有 needs 列表');
  const needs = needsLine[1].split(',').map((s) => s.trim());
  assert.deepEqual(
    [...needs].sort(),
    ['portable-mac-arm64', 'portable-windows-full'],
    'publish 必须等两个完整包都构建成功',
  );
  assert.ok(publishJob.includes('artifacts/portable-windows-full/*'), 'Windows zip 上传丢了');
  assert.ok(publishJob.includes('artifacts/portable-mac-arm64/*'), 'macOS zip 没接到 Release');
});

test('release body 有 macOS 下载说明（解压后双击 Mac-Start.command）', () => {
  assert.ok(publishJob.includes('u-claw-portable-mac-arm64-*.zip'), 'release body 没写 mac 包文件名');
  assert.ok(publishJob.includes('Mac-Start.command'), 'release body 没告诉 Mac 用户双击哪个启动器');
  assert.ok(publishJob.includes('未验证的开发者'), 'release body 没提 macOS 首次启动的权限提示');
});

test('Windows job 的既有发版约定没被破坏', () => {
  // tests/publish-latest.test.mjs 依赖这一行，改了就两边一起红
  assert.ok(workflow.includes('u-claw-portable-windows-${tag_name}.zip'));
  assert.match(windowsJob, /node_version="v/);
  assert.ok(windowsJob.includes('--os=win32 --cpu=x64'));
});

test('README 中英双语都说清 macOS 下载 zip 解压即用', () => {
  // 中文“直接下载发行版”区
  assert.ok(readme.includes('u-claw-portable-mac-arm64-vX.Y.Z.zip'), 'README 中文没写 mac 包文件名');
  assert.ok(
    /u-claw-portable-mac-arm64[\s\S]{0,200}解压后双击\s*`Mac-Start\.command`\s*即用/.test(readme),
    'README 中文没写「解压后双击 Mac-Start.command 即用」',
  );
  // 英文区
  assert.ok(
    readme.includes('u-claw-portable-mac-arm64-*.zip'),
    'README 英文段没写 mac 包文件名',
  );
  assert.ok(
    /Unzip, then double-click[\s\S]{0,80}Mac-Start\.command/.test(readme),
    'README 英文没写 unzip → double-click Mac-Start.command',
  );
});
