// gateway.mjs —— 网关生命周期动作：lock.clean / gateway.start / gateway.stop
//
// lock.clean 的逻辑来自已有的 lib/clean-stale-lock.mjs（那个脚本本来就是无界面、
// 零依赖、CLI 可调的——本质上已经是个 Action，只是没有统一契约）。收进来之后
// 它同时被启动器、CLI、诊断流程复用，而不是各自 spawn 一次 node。

import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { defineAction, ActionError } from '../runtime.mjs';

const PORT_MIN = 18789;
const PORT_MAX = 18799;

function lockDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return join(tmpdir(), uid != null ? `openclaw-${uid}` : 'openclaw');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH=进程不存在→死；EPERM=进程在但无权限→视为活（保守不删）
    return !!(e && e.code === 'EPERM');
  }
}

function probePort(port, timeoutMs = 400) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const finish = (open) => { sock.destroy(); res(open); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function findFreePort() {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!(await probePort(p))) return p;
  }
  // 注意：这里不像 Windows-Start.bat 那样因为 delayed-expansion 的 off-by-one
  // 滑到 18800 去。范围就是范围，超了明确报错。
  throw new ActionError('NO_FREE_PORT', `端口 ${PORT_MIN}-${PORT_MAX} 全部被占用`);
}

// ── lock.clean ──────────────────────────────────────────────────────────────

export const lockClean = defineAction({
  id: 'lock.clean',
  title: '清理失效网关锁',
  description:
    '删掉崩溃 / 拔盘残留、持有进程已不存在的 gateway 锁，修复 "gateway already running (pid XXXX)" 拒启动。' +
    '只删死锁，活着的实例一律不动。',
  tags: ['gateway', 'repair'],
  input_schema: { type: 'object', additionalProperties: false, properties: {} },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lock_dir: { type: 'string' },
      scanned: { type: 'number' },
      removed: { type: 'number' },
      alive_same_config: { type: 'number' },
    },
    required: ['lock_dir', 'scanned', 'removed', 'alive_same_config'],
  },
  // 删文件属破坏性动作，所以不能声明 confirmation:'never'（验证器会判 unsafe）。
  // 用 conditional：由动作自己判定安全边界——**只删持有进程已死的锁**，
  // 活着的实例一律不碰。这个判定就是这里的确认条件，比弹窗更硬。
  // 保持非 always 是必要的：gateway.start 每次启动都要内部调用它，不能卡在确认上。
  effects: { class: 'destructive', risk: 'low', reversible: false, confirmation: 'conditional', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 10000, progress_events: false, headless_evidence: 'tests/action-core.test.mjs' },
  async run(_input, ctx) {
    const dir = lockDir();
    const ourConfig = resolve(ctx.paths.configPath);
    let scanned = 0, removed = 0, aliveSameConfig = 0;

    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => /^gateway\..*\.lock$/.test(f));
    } catch {
      return { lock_dir: dir, scanned: 0, removed: 0, alive_same_config: 0 };
    }

    for (const name of entries) {
      scanned++;
      const full = join(dir, name);
      let payload = null;
      try { payload = JSON.parse(readFileSync(full, 'utf8')); } catch { /* 损坏/空 */ }
      const pid = payload ? Number(payload.pid) : NaN;

      if (!payload || !Number.isFinite(pid) || !pidAlive(pid)) {
        if (!ctx.dryRun) {
          try { rmSync(full, { force: true }); removed++; } catch { /* 别的进程正用着 */ }
        } else removed++;
        continue;
      }
      if (payload.configPath) {
        try { if (resolve(payload.configPath) === ourConfig) aliveSameConfig++; } catch { /* ignore */ }
      }
    }
    return { lock_dir: dir, scanned, removed, alive_same_config: aliveSameConfig };
  },
});

// ── gateway.start ───────────────────────────────────────────────────────────

export const gatewayStart = defineAction({
  id: 'gateway.start',
  title: '启动网关',
  description:
    '在 18789-18799 找一个空闲端口启动 OpenClaw 网关。启动前自动清理失效锁。' +
    '默认后台运行并等待端口就绪后返回。',
  tags: ['gateway'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      port: { type: 'number', description: '指定端口；留空=自动挑一个空闲的' },
      wait_ms: { type: 'number', description: '等待就绪的毫秒数，默认 90000' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      port: { type: 'number' },
      pid: { type: ['number', 'null'] },
      ready: { type: 'boolean' },
    },
    required: ['port', 'ready'],
  },
  effects: { class: 'external', risk: 'medium', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: false, cancellable: true, timeout_ms: 120000, progress_events: true, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const p = ctx.paths;
    const entry = join(p.coreDir, 'node_modules', 'openclaw', 'openclaw.mjs');
    if (!existsSync(entry)) {
      throw new ActionError('CORE_MISSING', `找不到 OpenClaw 入口：${entry}。先跑 setup.sh。`);
    }

    // 先清死锁，否则 OpenClaw 会因为上次崩溃残留的锁拒绝启动
    ctx.progress?.(10, '清理失效锁');
    if (!ctx.dryRun) await lockClean.run({}, ctx);

    const port = input.port || (await findFreePort());
    if (ctx.dryRun) return { port, pid: null, ready: false };

    ctx.progress?.(30, `在 ${port} 启动网关`);
    mkdirSync(p.logsDir, { recursive: true });
    const child = spawn(
      process.execPath,
      [entry, 'gateway', 'run', '--allow-unconfigured', '--force', '--port', String(port)],
      {
        cwd: p.coreDir,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          OPENCLAW_HOME: p.home,
          OPENCLAW_STATE_DIR: p.stateDir,
          OPENCLAW_CONFIG_PATH: p.configPath,
          ...(platform() === 'win32' ? { OPENCLAW_DISABLE_BONJOUR: '1' } : {}),
        },
      },
    );
    child.unref();

    const deadline = Date.now() + (input.wait_ms || 90000);
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) throw new ActionError('CANCELLED', '启动已取消');
      if (await probePort(port)) {
        ctx.progress?.(100, '网关就绪');
        return { port, pid: child.pid ?? null, ready: true };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { port, pid: child.pid ?? null, ready: false };
  },
});

// ── gateway.stop ────────────────────────────────────────────────────────────

export const gatewayStop = defineAction({
  id: 'gateway.stop',
  title: '停止网关',
  description: '停止本盘配置对应的 OpenClaw 网关进程（按锁文件里的 pid 定位，不误杀别的实例）。',
  tags: ['gateway'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { force: { type: 'boolean', description: 'SIGKILL 而非 SIGTERM' } },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      stopped: { type: 'array', items: { type: 'number' } },
      not_found: { type: 'boolean' },
    },
    required: ['stopped', 'not_found'],
  },
  // 停服务是外部可见的破坏性动作 → 必须显式确认（§11.2）
  effects: { class: 'destructive', risk: 'high', reversible: true, confirmation: 'always', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: false, timeout_ms: 30000, progress_events: false, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const ourConfig = resolve(ctx.paths.configPath);
    const dir = lockDir();
    const stopped = [];

    let entries = [];
    try { entries = readdirSync(dir).filter((f) => /^gateway\..*\.lock$/.test(f)); } catch { /* 无锁目录 */ }

    for (const name of entries) {
      let payload = null;
      try { payload = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
      const pid = Number(payload?.pid);
      if (!Number.isFinite(pid) || !pidAlive(pid)) continue;
      // 只杀属于本盘配置的实例——别人的 OpenClaw 不关我们的事
      try { if (resolve(payload.configPath || '') !== ourConfig) continue; } catch { continue; }

      if (!ctx.dryRun) {
        try { process.kill(pid, input.force ? 'SIGKILL' : 'SIGTERM'); } catch { continue; }
      }
      stopped.push(pid);
    }
    return { stopped, not_found: stopped.length === 0 };
  },
});

export default [lockClean, gatewayStart, gatewayStop];
