// portable-instance-lock.mjs — U-Claw 启动器的单实例闸门。
//
// OpenClaw 自己的 gateway lock 只能在 gateway 已经启动后生效；双击
// Mac-Start.command 时，两个 shell 会先各自挑一个新端口，随后共写同一份
// U 盘 state/session。这个小锁覆盖的是“启动器”这一层：同一份 stateDir
// 同时只允许一个启动器拥有端口与子进程。

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCK_DIR_NAME = 'launcher-instance.lock';
const OWNER_FILE_NAME = 'owner.json';
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

function normalise(value) {
  return value ? resolve(value) : '';
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function lockDir(cacheRoot) {
  return join(cacheRoot, LOCK_DIR_NAME);
}

// 导出给 config-server 的 gatewayPortFromRuntime() 复用：owner.json 里的 port 字段是
// 启动器已经知道的第二手证据（第一手是 runtime.json 的 gatewayPort，见 runtime-ports.mjs）。
export function readOwner(dir) {
  try {
    const owner = JSON.parse(readFileSync(join(dir, OWNER_FILE_NAME), 'utf8'));
    return {
      pid: Number(owner.pid),
      stateDir: normalise(owner.stateDir),
      port: Number.isInteger(Number(owner.port)) ? Number(owner.port) : null,
      startedAt: owner.startedAt || null,
    };
  } catch {
    return null;
  }
}

function writeOwner(dir, owner) {
  writeFileSync(join(dir, OWNER_FILE_NAME), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 });
}

// 返回 acquired（调用方可以继续启动）或 existing（已有健康/正在启动的实例）。
// 缓存盘不可写时返回 unavailable；调用方应继续启动，不能因此阻断客户使用。
export function acquirePortableInstance({
  cacheRoot,
  stateDir,
  pid = process.pid,
  isPidAlive = pidAlive,
  now = () => Date.now(),
} = {}) {
  const root = normalise(cacheRoot);
  const expectedStateDir = normalise(stateDir);
  if (!root || !expectedStateDir || !Number.isInteger(pid) || pid <= 0) {
    return { status: 'unavailable', port: null };
  }

  const dir = lockDir(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(dir);
      writeOwner(dir, { pid, stateDir: expectedStateDir, port: null, startedAt: new Date().toISOString() });
      return { status: 'acquired', port: null };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { status: 'unavailable', port: null };
    }

    const owner = readOwner(dir);
    if (owner?.stateDir === expectedStateDir && isPidAlive(owner.pid)) {
      return { status: 'existing', port: owner.port };
    }

    // mkdir + writeOwner 不是一个系统调用。另一个双击若恰好落在两者之间，
    // 不能把这个新锁当“损坏锁”搬走；保守地让第二个启动器退出即可。只有
    // 超过宽限期仍没有合法 owner 的锁才可能是创建者崩溃留下的残骸。
    if (!owner) {
      try {
        if (now() - statSync(dir).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
          return { status: 'busy', port: null };
        }
      } catch {
        return { status: 'busy', port: null };
      }
    }

    // 仅把已确认“死/损坏”的锁原子改名，随后再竞争 mkdir；不递归删除未知目录。
    try {
      renameSync(dir, `${dir}.stale-${pid}-${Date.now()}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { status: 'busy', port: null };
    }
  }
  return { status: 'unavailable', port: null };
}

export function publishPortableInstance({ cacheRoot, stateDir, pid = process.pid, port } = {}) {
  const dir = lockDir(normalise(cacheRoot));
  const owner = readOwner(dir);
  if (!owner || owner.pid !== pid || owner.stateDir !== normalise(stateDir)) return false;
  writeOwner(dir, { ...owner, port: Number(port) || null });
  return true;
}

export function releasePortableInstance({ cacheRoot, stateDir, pid = process.pid } = {}) {
  const dir = lockDir(normalise(cacheRoot));
  const owner = readOwner(dir);
  if (!owner || owner.pid !== pid || owner.stateDir !== normalise(stateDir)) return false;
  try {
    rmSync(dir, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function print(result) {
  process.stdout.write(`UCLAW_INSTANCE_STATUS=${result.status}\n`);
  process.stdout.write(`UCLAW_INSTANCE_PORT=${result.port ?? ''}\n`);
}

const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  const [command, cacheRoot, stateDir, pidText, portText] = process.argv.slice(2);
  const pid = Number(pidText || process.pid);
  if (command === 'acquire') print(acquirePortableInstance({ cacheRoot, stateDir, pid }));
  else if (command === 'publish') process.exit(publishPortableInstance({ cacheRoot, stateDir, pid, port: Number(portText) }) ? 0 : 1);
  else if (command === 'release') process.exit(releasePortableInstance({ cacheRoot, stateDir, pid }) ? 0 : 1);
  else process.exit(64);
}
