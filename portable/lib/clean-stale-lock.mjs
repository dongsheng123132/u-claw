#!/usr/bin/env node
// clean-stale-lock.mjs —— 启动前清理 OpenClaw 残留的 gateway 锁
//
// 背景：OpenClaw 的网关锁写在 os.tmpdir()/openclaw[-uid]/gateway.<hash>.lock，
// 内容是 {pid, createdAt, configPath}（hash = sha256(configPath) 前 8 位）。
// 注意它**不**落在 U 盘的 state 目录，而是系统临时目录。U 盘被拔 / 进程崩溃后，
// 这个锁会残留；下次启动若那个 pid 已死、或被系统复用成别的进程，OpenClaw 可能
// 报 "gateway already running (pid XXXX)" 而拒绝启动（这是 CLAUDE.md 里记录、过去
// 需要手动 rm 的故障）。
//
// 本脚本在启动自己的 gateway 之前，主动把"持有进程已不在 / 内容损坏"的死锁删掉。
// 安全第一：**只删死锁**，绝不动还活着的实例的锁；对其它 config（别的 OpenClaw
// 安装）的锁也只在其 pid 已死时才清理（死锁删了对谁都无害）。
// 跨平台、静默失败、绝不阻塞启动。
//
// 用法：node clean-stale-lock.mjs [我们自己的 openclaw.json 路径]
//   传入配置路径只用于"检测到本盘可能已在运行"时给一句友好提示，不影响删除逻辑。

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveLockDir() {
  // 复刻 OpenClaw 的 resolveGatewayLockDir()：tmpdir()/openclaw[-<uid>]
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : 'openclaw';
  return path.join(os.tmpdir(), suffix);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0：只探测进程是否存在，不真正发信号
    return true;
  } catch (e) {
    // ESRCH = 进程不存在 → 死；EPERM = 进程在但无权限 → 视为活（保守不删）
    return !!(e && e.code === 'EPERM');
  }
}

// 供测试直接调用的核心逻辑：给定锁目录 + 探活函数，返回清理结果，不碰真实文件系统之外的东西。
export function cleanStaleLocks(dir, { ourConfig = null, isPidAlive = pidAlive, fsImpl = fs } = {}) {
  let removed = 0;
  let aliveSameConfig = 0;

  try {
    const entries = fsImpl.readdirSync(dir).filter((f) => /^gateway\..*\.lock$/.test(f));
    for (const name of entries) {
      const full = path.join(dir, name);
      let payload = null;
      try {
        payload = JSON.parse(fsImpl.readFileSync(full, 'utf8'));
      } catch {
        /* 损坏/空 */
      }

      const pid = payload ? Number(payload.pid) : NaN;
      const corrupt = !payload || !Number.isFinite(pid);

      if (corrupt || !isPidAlive(pid)) {
        try {
          fsImpl.rmSync(full, { force: true });
          removed++;
        } catch {
          /* 别的进程正用着，跳过 */
        }
        continue;
      }

      // pid 还活着 → 不删（可能是真在跑的实例）。若锁属于本盘配置，给一句提示。
      if (ourConfig && payload.configPath) {
        let lockCfg = null;
        try {
          lockCfg = path.resolve(payload.configPath);
        } catch {
          /* ignore */
        }
        if (lockCfg === ourConfig) aliveSameConfig++;
      }
    }
  } catch {
    /* 锁目录不存在等 → 无需清理 */
  }

  return { removed, aliveSameConfig };
}

// --- CLI entrypoint ---
const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const ourConfig = process.argv[2]
    ? (() => {
        try {
          return path.resolve(process.argv[2]);
        } catch {
          return null;
        }
      })()
    : null;

  const { removed, aliveSameConfig } = cleanStaleLocks(resolveLockDir(), { ourConfig });

  if (removed) console.error(`[clean-stale-lock] cleaned ${removed} stale lock(s)`);
  if (aliveSameConfig) {
    console.error('[clean-stale-lock] U-Claw 可能已在运行；若本次启动失败，请先关闭旧的 U-Claw 窗口再试。');
  }
}
