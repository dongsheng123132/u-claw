import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// portable-maintenance.mjs：Maintain 菜单背后的动作核心。这里用真实子进程 +
// fake openclaw CLI + 本地 HTTP stub 打 settings-url 的实例核对、backup/restore
// 的 argv 形状与退出码/超时传播、restore 只落全新空目录、慢实例不误判。
// 不碰真实服务/真实备份。

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const maintPath = join(repoRoot, 'portable', 'lib', 'portable-maintenance.mjs');
const realMaint = process.execPath;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'uclaw-maint-'));
  const usbRoot = join(root, 'usb');
  const stateDir = join(usbRoot, 'data', '.openclaw');
  mkdirSync(stateDir, { recursive: true });
  const local = join(root, 'LocalCache');
  mkdirSync(local, { recursive: true });
  // fake openclaw.mjs：把 argv 原样记下来，按 FAKE_EXIT 退出；FAKE_SLEEP 时先睡。
  const fakeCli = join(root, 'fake-openclaw.mjs');
  writeFileSync(fakeCli, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
process.stdout.write('fake-stdout\\n');
process.stderr.write('fake-stderr\\n');
const sleep = Number(process.env.FAKE_SLEEP || 0);
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  return { root, usbRoot, stateDir, local, fakeCli };
}

function maintEnv(fixture, extraEnv) {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: fixture.stateDir,
    UCLAW_DIR: fixture.usbRoot,
    UCLAW_CACHE_CANDIDATES: fixture.local,
    UCLAW_OPENCLAW_MJS: fixture.fakeCli,
    ...extraEnv,
  };
}

function runMaint(fixture, args, extraEnv = {}) {
  return spawnSync(realMaint, [maintPath, ...args], {
    encoding: 'utf8',
    env: maintEnv(fixture, extraEnv),
    timeout: 30000,
  });
}

// 异步跑：settings-url 用例里父进程自己是 stub HTTP server，spawnSync 会阻塞
// 事件循环，stub 永远应答不了，子进程 fetch 只能超时。
function runMaintAsync(fixture, args, extraEnv = {}) {
  return new Promise((resolveDone) => {
    const child = spawn(realMaint, [maintPath, ...args], {
      env: maintEnv(fixture, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', (err) => resolveDone({ status: -1, stdout, stderr: stderr + err.message }));
    child.once('close', (status) => resolveDone({ status, stdout, stderr }));
  });
}

function expectedInstanceId(stateDir) {
  return createHash('sha256').update(resolve(stateDir)).digest('hex');
}

function listen(handler, delayMs = 0) {
  return new Promise((res) => {
    const server = createServer((req, res2) => {
      const answer = () => handler(req, res2);
      if (delayMs > 0) setTimeout(answer, delayMs);
      else answer();
    });
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

test('settings-url：/api/runtime 的 instanceId 匹配本实例时输出配置中心 URL', async () => {
  const fixture = makeFixture();
  try {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configServerPort: port,
        gatewayPort: 18789,
        instanceId: expectedInstanceId(fixture.stateDir),
      }));
    });
    try {
      writeFileSync(join(fixture.stateDir, 'runtime.json'), JSON.stringify({ configServerPort: port }));
      const r = await runMaintAsync(fixture, ['settings-url']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.stdout.trim(), `http://127.0.0.1:${port}/`);
    } finally {
      await new Promise((res2) => server.close(res2));
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('settings-url：instanceId 不匹配（foreign/stale）不得给 URL', async () => {
  const fixture = makeFixture();
  try {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configServerPort: port,
        gatewayPort: 18789,
        instanceId: 'deadbeef'.repeat(8),
      }));
    });
    try {
      writeFileSync(join(fixture.stateDir, 'runtime.json'), JSON.stringify({ configServerPort: port }));
      const r = await runMaintAsync(fixture, ['settings-url']);
      assert.notEqual(r.status, 0, 'foreign instance must fail');
      assert.equal(r.stdout.trim(), '', 'must not print a URL');
      assert.match(r.stderr, /mismatch|foreign|stale/i);
    } finally {
      await new Promise((res2) => server.close(res2));
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('settings-url：服务未启动时提示先 Start，不给 URL', () => {
  const fixture = makeFixture();
  try {
    // 指向一个已经关掉的端口：连接必然失败。
    writeFileSync(join(fixture.stateDir, 'runtime.json'), JSON.stringify({ configServerPort: 1 }));
    const r = runMaint(fixture, ['settings-url']);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /start/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('settings-url：server 故意慢 2s 时仍成功（5s 超时，不误判活实例）', async () => {
  const fixture = makeFixture();
  try {
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configServerPort: port,
        gatewayPort: 18789,
        instanceId: expectedInstanceId(fixture.stateDir),
      }));
    }, 2000);
    try {
      writeFileSync(join(fixture.stateDir, 'runtime.json'), JSON.stringify({ configServerPort: port }));
      const r = await runMaintAsync(fixture, ['settings-url']);
      assert.equal(r.status, 0, `slow-but-alive instance must succeed: ${r.stderr}${r.stdout}`);
      assert.equal(r.stdout.trim(), `http://127.0.0.1:${port}/`);
    } finally {
      await new Promise((res2) => server.close(res2));
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('backup：默认输出落 U 盘 data/backups/<时间戳>/，带 sessions 跳过说明', () => {
  const fixture = makeFixture();
  try {
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['backup'], { FAKE_ARGV_OUT: argvOut });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const argv = JSON.parse(readFileSyncUtf8(argvOut));
    assert.equal(argv[0], 'backup');
    assert.equal(argv[1], 'create');
    assert.ok(argv.includes('--verify'), `argv must include --verify: ${JSON.stringify(argv)}`);
    const outIdx = argv.indexOf('--output');
    assert.ok(outIdx > 0, 'argv must include --output');
    const target = argv[outIdx + 1];
    // 备份是耐久用户数据，不是缓存：必须落 U 盘 data/backups/，绝不落 %LOCALAPPDATA%。
    assert.ok(target.startsWith(join(fixture.usbRoot, 'data', 'backups')), `output must default under USB data/backups: ${target}`);
    assert.ok(existsSync(target), `backup target dir must exist: ${target}`);
    // live sessions JSONL 不入备份——文案必须写明（官方 volatile/skipped）。
    assert.match(r.stderr, /sessions\/\*\.jsonl/);
    assert.match(r.stderr, /volatile/i);
    // 路径文案必须是完整路径。
    assert.match(r.stderr, new RegExp(escapeRe(target)));
    // U 盘耐久提示。
    assert.match(r.stderr, /portable drive/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('backup：--output 透传用户目标，子进程 exit code 原样传播', () => {
  const fixture = makeFixture();
  try {
    const customOut = join(fixture.root, 'my-backups');
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['backup', '--output', customOut], {
      FAKE_ARGV_OUT: argvOut,
      FAKE_EXIT: '3',
    });
    assert.equal(r.status, 3, `child exit code must propagate: ${r.status}`);
    const argv = JSON.parse(readFileSyncUtf8(argvOut));
    assert.equal(argv[argv.indexOf('--output') + 1], resolve(customOut));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('backup：子进程挂死时按超时退出非 0，不静默', () => {
  const fixture = makeFixture();
  try {
    const r = runMaint(fixture, ['backup'], {
      FAKE_ARGV_OUT: join(fixture.root, 'argv.json'),
      FAKE_SLEEP: '5000',
      UCLAW_BACKUP_TIMEOUT_MS: '300',
    });
    assert.notEqual(r.status, 0, 'hung backup must fail');
    assert.match(r.stderr, /timed out/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('backup/restore：本机缓存不可写也仍可做（备份是耐久数据，不依赖缓存）', () => {
  const fixture = makeFixture();
  try {
    // 全部缓存候选不可写（候选在 U 盘内 → 拒绝）时，backup 仍应成功。
    const usbOnly = join(fixture.usbRoot, 'only-candidate');
    mkdirSync(usbOnly, { recursive: true });
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['backup'], {
      UCLAW_CACHE_CANDIDATES: usbOnly,
      FAKE_ARGV_OUT: argvOut,
    });
    assert.equal(r.status, 0, `backup must not depend on writable local cache: ${r.stderr}${r.stdout}`);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('restore：backup restore <archive> --target <U盘全新空目录>，绝不覆盖既有 state', () => {
  const fixture = makeFixture();
  try {
    // 既有 state 必须原样不动。
    const marker = join(fixture.stateDir, 'openclaw.json');
    writeFileSync(marker, '{"keep":"me"}');
    const archive = join(fixture.root, 'uclaw-backup.zip');
    writeFileSync(archive, 'fake-archive-bytes');
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['restore', archive], { FAKE_ARGV_OUT: argvOut });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const argv = JSON.parse(readFileSyncUtf8(argvOut));
    assert.equal(argv[0], 'backup');
    assert.equal(argv[1], 'restore');
    assert.equal(argv[2], resolve(archive));
    const targetIdx = argv.indexOf('--target');
    assert.ok(targetIdx > 0, 'argv must include --target');
    const target = argv[targetIdx + 1];
    // 目标必须是 U 盘 data/backups/ 下的新目录，不是 STATE_DIR，也不是既有目录。
    assert.ok(target.startsWith(join(fixture.usbRoot, 'data', 'backups')), `restore target must be under USB data/backups/: ${target}`);
    assert.notEqual(resolve(target), resolve(fixture.stateDir));
    assert.match(r.stdout.trim(), new RegExp(escapeRe(target)), 'stdout must report the fresh target');
    // state 未被覆盖。
    assert.equal(readFileSyncUtf8(marker), '{"keep":"me"}');
    // 文案写明 sessions volatile + 完整路径 + U 盘 + 恢复不自动激活（先停 Gateway）。
    assert.match(r.stderr, /sessions\/\*\.jsonl/);
    assert.match(r.stderr, new RegExp(escapeRe(target)));
    assert.match(r.stderr, /portable drive/i);
    assert.match(r.stderr, /Stop the Gateway/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('restore：--target 指向非空目录时拒绝，不启动 restore', () => {
  const fixture = makeFixture();
  try {
    const archive = join(fixture.root, 'uclaw-backup.zip');
    writeFileSync(archive, 'fake-archive-bytes');
    const dirty = join(fixture.root, 'dirty-target');
    mkdirSync(dirty);
    writeFileSync(join(dirty, 'something.txt'), 'not empty');
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['restore', archive, '--target', dirty], { FAKE_ARGV_OUT: argvOut });
    assert.notEqual(r.status, 0, 'non-empty restore target must be rejected');
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /empty/i);
    assert.equal(existsSync(argvOut), false, 'openclaw restore must not run against a non-empty target');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('restore：--target 指向空目录时允许', () => {
  const fixture = makeFixture();
  try {
    const archive = join(fixture.root, 'uclaw-backup.zip');
    writeFileSync(archive, 'fake-archive-bytes');
    const empty = join(fixture.root, 'empty-target');
    mkdirSync(empty);
    const argvOut = join(fixture.root, 'argv.json');
    const r = runMaint(fixture, ['restore', archive, '--target', empty], { FAKE_ARGV_OUT: argvOut });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const argv = JSON.parse(readFileSyncUtf8(argvOut));
    assert.equal(argv[argv.indexOf('--target') + 1], resolve(empty));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('restore：归档不存在时失败且不建假目录', () => {
  const fixture = makeFixture();
  try {
    const r = runMaint(fixture, ['restore', join(fixture.root, 'nope.zip')]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /archive not found/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('restore：子进程挂死时按超时退出非 0，不静默', () => {
  const fixture = makeFixture();
  try {
    const archive = join(fixture.root, 'uclaw-backup.zip');
    writeFileSync(archive, 'fake-archive-bytes');
    const r = runMaint(fixture, ['restore', archive], {
      FAKE_ARGV_OUT: join(fixture.root, 'argv.json'),
      FAKE_SLEEP: '5000',
      UCLAW_RESTORE_TIMEOUT_MS: '300',
    });
    assert.notEqual(r.status, 0, 'hung restore must fail');
    assert.match(r.stderr, /timed out/i);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('logs-path：走缓存解析器的 logDir，无本机缓存时失败', () => {
  const fixture = makeFixture();
  try {
    const r = runMaint(fixture, ['logs-path']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.trim().startsWith(fixture.local), r.stdout);
    assert.match(r.stdout.trim(), /logs/);

    // 全部候选不可写（候选在 U 盘内 → 拒绝）→ 失败、不回落。
    const usbOnly = join(fixture.usbRoot, 'only-candidate');
    mkdirSync(usbOnly, { recursive: true });
    const r2 = runMaint(fixture, ['logs-path'], { UCLAW_CACHE_CANDIDATES: usbOnly });
    assert.notEqual(r2.status, 0);
    assert.equal(r2.stdout.trim(), '');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('/api/runtime 的 instanceId 与 helper 同算法（真实 config-server 沙箱）', async () => {
  const { createServerSandbox, withSandboxServer } = await import('./helpers/config-server-sandbox.mjs');
  const fixture = createServerSandbox();
  try {
    await withSandboxServer(fixture, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      const body = await res.json();
      assert.equal(body.instanceId, expectedInstanceId(fixture.stateDir), 'server instanceId must be sha256(path.resolve(OPENCLAW_STATE_DIR))');
    });
  } finally {
    fixture.cleanup();
  }
});

function readFileSyncUtf8(p) {
  return readFileSync(p, 'utf8');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
