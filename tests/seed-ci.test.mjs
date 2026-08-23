// 守卫测试：**CI 必须按平台在对应 runner 上打 seed，不许交叉打。**
//
// 为什么需要它：
//
//   build-seed.mjs 的 --target 只决定 Node 官方包和产物文件名。内核树是拿构建机上的
//   npm 装出来的，里面的原生 optionalDependency（sqlite-vec 等）跟着**构建机**走，
//   不跟着 --target 走。所以在 ubuntu-latest 上 `--target win-x64`，会产出一个
//   名字写着 win-x64、内容是 Linux 二进制的 seed。
//
//   这种错的致命之处在于它全程不报错：npm install 成功、打包成功、上传成功、
//   SHA256 也对得上（校验的是那个错包自己）。要到客户**断网首启**解这个包、
//   起网关的时候才炸 —— 而离线 seed 存在的全部理由就是那一刻没有网可以救。
//
//   这正是 v2.1.15/16/17 那次事故的同一形状：构建绿、CI 绿、发布成功、客户打不开
//   （见 tests/node-version-satisfies-openclaw.test.mjs 的头注）。区别只是那次错的是
//   Node 版本，这次错的会是原生二进制的平台。
//
// 两道防线，这条测试守的是第二道：
//   ① build-seed.mjs 里的运行时守卫：target !== 本机平台且要打内核 → 退出码 2；
//   ② 本测试：CI 的矩阵必须让守卫永远不被触发（每个 target 配对应的 runner）。
//
// 只有 ① 不够 —— 有人在 CI 里加个 --allow-cross 就绕过去了，而那次改动在 review 里
// 看着只是"让 job 跑起来"。所以把配对关系断言在这里。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

/** target → 唯一允许的 runner 前缀。交叉组合一律视为 bug。 */
const REQUIRED_RUNNER_PREFIX = {
  'win-x64': 'windows-',
  'darwin-arm64': 'macos-',
  'darwin-x64': 'macos-',
  'linux-x64': 'ubuntu-',
};

/** 从 release.yml 的 seed job 矩阵里抠出 include 的 (target, runs-on) 对。 */
function parseSeedMatrix(text) {
  const seedJob = text.split(/^  seed:$/m)[1];
  assert.ok(seedJob, 'release.yml 里应该有一个 seed job');
  const includeBlock = seedJob.split(/^\s*include:$/m)[1];
  assert.ok(includeBlock, 'seed job 应该用 matrix.include 显式配平台与 runner');

  const pairs = [];
  const re = /-\s*target:\s*([\w-]+)\s*\n\s*runs-on:\s*([\w.-]+)/g;
  let m;
  while ((m = re.exec(includeBlock)) !== null) pairs.push({ target: m[1], runsOn: m[2] });
  return pairs;
}

test('seed job 存在，且每个 target 都配了对应平台的 runner', () => {
  const pairs = parseSeedMatrix(workflow);
  assert.ok(pairs.length > 0, 'seed 矩阵不能为空');

  for (const { target, runsOn } of pairs) {
    const prefix = REQUIRED_RUNNER_PREFIX[target];
    assert.ok(prefix, `矩阵里出现了未登记的 target：${target}，请在本测试里补上它该用的 runner`);
    assert.ok(
      runsOn.startsWith(prefix),
      `seed 的 ${target} 必须在 ${prefix}* runner 上打，实际配的是 ${runsOn}。` +
      '内核树的原生依赖跟构建机走，交叉打出来的包在目标机上起不来。',
    );
  }
});

test('CI 不得用 --allow-cross 绕开跨平台守卫', () => {
  assert.ok(
    !/--allow-cross/.test(workflow),
    'release.yml 里出现了 --allow-cross —— 那是给本地临时调试用的逃生门，'
    + '发布链路上用它等于把守卫关掉，会打出平台错配的 seed。',
  );
});

test('seed 产完必须校验 SHA256SUMS', () => {
  const seedJob = workflow.split(/^  seed:$/m)[1];
  assert.match(
    seedJob,
    /sha256sum -c SHA256SUMS|shasum -a 256 -c SHA256SUMS/,
    'SHA256SUMS 是客户断网首启时唯一的完整性依据，生成完必须当场按它重算一遍',
  );
});

test('publish job 不依赖 seed —— v3 的 seed 挂了不许拦住 v2 出货', () => {
  const publishJob = workflow.split(/^  publish:$/m)[1];
  const needs = /needs:\s*\[([^\]]*)\]/.exec(publishJob);
  assert.ok(needs, 'publish job 应该显式声明 needs');
  assert.ok(
    !needs[1].includes('seed'),
    'publish 依赖了 seed：v3 还没发版，seed 失败会连带拦住 v2 便携包发布（宪法第 3 条）。'
    + '等 v3 切成主线时再连，并同步把 seed 加进 release 资产列表。',
  );
});

test('build-seed.mjs 自身带跨平台守卫（第一道防线还在）', () => {
  const script = readFileSync(path.join(REPO_ROOT, 'portable', 'scripts', 'build-seed.mjs'), 'utf8');
  assert.match(
    script,
    /hostTarget[\s\S]{0,400}?allow_cross/,
    'build-seed.mjs 里应有 target !== 本机平台时的拒绝逻辑；'
    + '删掉它之后本测试的矩阵断言就只剩纸面约束了',
  );
});
