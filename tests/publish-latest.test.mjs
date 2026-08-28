// publish-latest 生成的链接必须指向真实存在的东西
//
// 回归的是：这个脚本早期拿 OPENCLAW_VERSION（2026.7.1-2）当发布 tag，
// 但仓库实际打的 tag 是壳版本（v2.1.16），release.yml 的产物名也跟着 tag 走。
// 结果 releasePageUrl 和 downloadUrl 全是死链——就算把 latest.json 传上 OSS，
// 用户点"下载新版"照样 404，等于更新通道白搭。
//
// 这里不联网，只断言"生成的链接和仓库里的事实一致"：
// tag 取自 u-claw-app/package.json，文件名格式取自 release.yml。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// publish-latest.mjs 把 latest.json 写死到 <repo>/dist/latest.json。
// ⚠️ 绝不能 rmSync(<repo>/dist)：CI（release.yml）的 test suite 步骤跑在
// 「打包产物已放进 dist/ 之后、zip 之前」，v2.1.19 就是这里把整个
// dist/ 连同 474MB 的 staged 产物一起删了，导致 zip 步骤 cd dist 失败。
// 改成把已有 dist 内容挪进临时目录，测完再原样放回。
const DIST = join(REPO, 'dist');

function generate() {
  // 若 CI 已有 staged 产物，先整体挪走保命
  const stash = mkdtempSync(join(tmpdir(), 'publish-latest-test-'));
  const hadDist = existsSync(DIST);
  if (hadDist) {
    execFileSync('mv', [DIST, join(stash, 'dist')]);
  }
  try {
    execFileSync(process.execPath, [join(REPO, 'portable', 'lib', 'publish-latest.mjs'), '--notes', 'test'], {
      cwd: REPO,
      stdio: 'ignore',
    });
    const file = join(DIST, 'latest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    return manifest;
  } finally {
    // 删掉测试生成的 dist，把原产物原样放回
    rmSync(DIST, { recursive: true, force: true });
    if (hadDist) {
      execFileSync('mv', [join(stash, 'dist'), DIST]);
    }
    try { rmSync(stash, { recursive: true, force: true }); } catch {}
  }
}

const shellVersion = () => JSON.parse(readFileSync(join(REPO, 'u-claw-app', 'package.json'), 'utf8')).version;
const openclawVersion = () => readFileSync(join(REPO, 'OPENCLAW_VERSION'), 'utf8').trim();

test('version 字段用 OpenClaw 上游版本（check-update 拿它比大小）', () => {
  assert.equal(generate().version, openclawVersion());
});

test('releasePageUrl 指向壳版本 tag，不是 OpenClaw 版本', () => {
  const m = generate();
  const tag = `v${shellVersion()}`;
  assert.ok(m.releasePageUrl.endsWith(`/tag/${tag}`), `应指向 ${tag}，实际 ${m.releasePageUrl}`);
  assert.equal(
    m.releasePageUrl.includes(openclawVersion()),
    false,
    'OpenClaw 版本不是 git tag，拿它拼发布页链接必然 404',
  );
});

test('产物文件名与 release.yml 的命名一致', () => {
  const m = generate();
  const expected = `u-claw-portable-windows-v${shellVersion()}.zip`;

  // 直接从 workflow 里读命名模板，避免这里和 CI 各写一份约定
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(
    workflow.includes('u-claw-portable-windows-${tag_name}.zip'),
    'release.yml 的产物命名变了，本测试的期望也要跟着改',
  );

  assert.ok(m.downloadUrl.endsWith(expected), `downloadUrl 应以 ${expected} 结尾，实际 ${m.downloadUrl}`);
  assert.ok(m.mirrors.oss.endsWith(expected));
  assert.ok(m.mirrors.github.endsWith(expected));
});

test('GitHub 镜像用 /releases/download/<tag>/<file>，不是发布页 URL 后面接文件名', () => {
  const m = generate();
  assert.ok(m.mirrors.github.includes('/releases/download/'), `实际 ${m.mirrors.github}`);
  assert.equal(m.mirrors.github.includes('/tag/'), false, '发布页 URL 后面拼文件名不是有效下载地址');
});

test('生成后不留下 dist/ 垃圾（本测试自己清理，顺带确认路径正确）', () => {
  generate();
  assert.equal(existsSync(join(REPO, 'dist', 'latest.json')), false);
});
