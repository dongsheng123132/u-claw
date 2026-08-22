// doctor.mjs —— 无界面健康诊断
//
// 存在的理由：改造前 U-Claw 没有任何 headless 入口，客户机出问题只能远程逐条
// 猜着跑 PowerShell（pc-4800 那次 20 分钟一条结果都没拿到）。现在远程只要能跑
// 一条命令就行：
//     node uclaw.mjs doctor.diagnose --json
// 输出是结构化 findings，运维/AI 都能直接判读，不用解析人类文案。
// 规范 §7.3（无界面执行）+ 宪法 #14（界面之外必须留一条给机器走的路）。
//
// 与 Windows-Diagnose.bat 的关系：那个脚本只查"组件在不在"，且 Windows 独有、
// 输出是给人看的纯文本。本动作是它的超集，且跨平台。.bat 后续改成调这里。

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { defineAction } from '../runtime.mjs';

const GATEWAY_PORTS = Array.from({ length: 11 }, (_, i) => 18789 + i); // 18789-18799
const CONFIG_PORTS = Array.from({ length: 11 }, (_, i) => 18788 + i);  // 18788-18798

/** 探一个本地 TCP 端口是否有人监听。宪法 #9：一律带超时，别指望连接自己失败。 */
function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function firstOpenPort(ports) {
  for (const p of ports) {
    if (await probePort(p)) return p;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 复刻 OpenClaw 的锁目录规则：tmpdir()/openclaw[-uid] */
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
    return !!(e && e.code === 'EPERM');
  }
}

export const doctorDiagnose = defineAction({
  id: 'doctor.diagnose',
  title: '健康诊断',
  description:
    '无界面检查 U-Claw 的运行时、依赖、配置、网关、插件和残留锁，返回结构化 findings。' +
    '只读，不修改任何东西。远程排障的第一条命令。',
  tags: ['diagnostics'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scope: {
        type: 'array',
        description: '只查指定范围；留空=全查',
        items: { enum: ['runtime', 'core', 'config', 'gateway', 'plugin', 'lock'] },
      },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      healthy: { type: 'boolean' },
      platform: { type: 'string' },
      findings: { type: 'array', items: { type: 'object' } },
      summary: { type: 'object' },
    },
    required: ['healthy', 'platform', 'findings', 'summary'],
  },
  effects: { class: 'read', risk: 'low', reversible: true, confirmation: 'never', audit_required: false },
  execution: { headless: true, idempotent: true, cancellable: true, timeout_ms: 60000, progress_events: true, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const p = ctx.paths;
    const scope = input.scope?.length ? new Set(input.scope) : null;
    const want = (name) => !scope || scope.has(name);
    const findings = [];
    const add = (level, id, title, detail, hint) => findings.push({ id, level, title, detail, ...(hint ? { hint } : {}) });

    // ── runtime ──────────────────────────────────────────────────────────
    if (want('runtime')) {
      ctx.progress?.(10, '检查 Node 运行时');
      const dirs = { win32: 'node-win-x64', darwin: 'node-mac-arm64' };
      const nodeDir = join(p.runtimeDir, dirs[platform()] || 'node-linux-x64');
      const nodeBin = platform() === 'win32' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node');
      if (existsSync(nodeBin)) {
        add('ok', 'runtime.node', '内置 Node 运行时存在', nodeBin);
      } else {
        add('error', 'runtime.node', '内置 Node 运行时缺失', nodeBin, '重新解压发行包，或运行 setup.sh');
      }
      add('info', 'runtime.current', '当前进程 Node 版本', process.version);
    }

    // ── core ─────────────────────────────────────────────────────────────
    if (want('core')) {
      ctx.progress?.(25, '检查 OpenClaw 依赖');
      const entry = join(p.coreDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      if (existsSync(entry)) {
        const pkg = readJson(join(p.coreDir, 'node_modules', 'openclaw', 'package.json'));
        add('ok', 'core.openclaw', 'OpenClaw 已安装', `version=${pkg?.version ?? '未知'}`);
        const pinned = existsSync(p.versionFile) ? readFileSync(p.versionFile, 'utf8').trim() : null;
        if (pinned && pkg?.version && pinned !== pkg.version) {
          add('warn', 'core.version-drift', '实装版本与 OPENCLAW_VERSION 不一致', `pin=${pinned} 实装=${pkg.version}`);
        }
      } else {
        add('error', 'core.openclaw', 'OpenClaw 未安装', entry, '运行 setup.sh，或重新下载完整发行包');
      }
    }

    // ── config ───────────────────────────────────────────────────────────
    if (want('config')) {
      ctx.progress?.(40, '检查配置');
      if (!existsSync(p.configPath)) {
        add('warn', 'config.missing', '配置文件不存在（首次启动属正常）', p.configPath, '打开配置中心选模型填 Key');
      } else {
        const cfg = readJson(p.configPath);
        if (!cfg) {
          add('error', 'config.corrupt', '配置文件解析失败', p.configPath, `从 ${p.backupsDir} 恢复一份备份`);
        } else {
          add('ok', 'config.readable', '配置文件可读', p.configPath);
          const primary = cfg?.agents?.defaults?.model?.primary;
          if (primary) add('ok', 'config.model', '已配置主模型', String(primary));
          else add('warn', 'config.model', '未配置主模型', '缺 agents.defaults.model.primary', '打开配置中心选一个模型');

          const providers = Object.keys(cfg?.models?.providers || {});
          add('info', 'config.providers', '已配置的 provider', providers.length ? providers.join(', ') : '（无）');
          const channels = Object.keys(cfg?.channels || {});
          if (channels.length) add('info', 'config.channels', '已接入渠道', channels.join(', '));
          const plugins = Object.keys(cfg?.plugins?.entries || {});
          if (plugins.length) add('info', 'config.plugins', '已启用插件', plugins.join(', '));
        }
      }
    }

    // ── gateway ──────────────────────────────────────────────────────────
    let gatewayPort = null;
    if (want('gateway')) {
      ctx.progress?.(60, '探测网关端口');
      gatewayPort = await firstOpenPort(GATEWAY_PORTS);
      if (gatewayPort) add('ok', 'gateway.listening', '网关正在监听', `127.0.0.1:${gatewayPort}`);
      else add('warn', 'gateway.listening', '网关未运行', `${GATEWAY_PORTS[0]}-${GATEWAY_PORTS.at(-1)} 均无监听`, '双击启动脚本，或跑 gateway.start');

      const cfgPort = await firstOpenPort(CONFIG_PORTS);
      if (cfgPort) add('ok', 'gateway.config-server', '配置中心正在监听', `127.0.0.1:${cfgPort}`);
      else add('info', 'gateway.config-server', '配置中心未运行', '未监听 18788-18798');
    }

    // ── plugin ───────────────────────────────────────────────────────────
    if (want('plugin')) {
      ctx.progress?.(75, '检查微信插件');
      const dst = join(p.extensionsDir, 'openclaw-weixin');
      const manifest = join(dst, 'openclaw.plugin.json');
      if (!existsSync(manifest)) {
        add('info', 'plugin.wechat', '微信插件未铺设', dst, '跑 plugin.wechat.install，或重新双击启动脚本');
      } else {
        const v = readJson(manifest)?.version ?? '未知';
        if (existsSync(join(dst, 'node_modules', 'zod'))) {
          add('ok', 'plugin.wechat', '微信插件已就绪', `version=${v}，zod 依赖齐全`);
        } else {
          add('error', 'plugin.wechat.zod', '微信插件缺 zod，渠道会整个加载失败', `version=${v}`, '跑 plugin.wechat.install 自愈');
        }
      }
    }

    // ── lock ─────────────────────────────────────────────────────────────
    if (want('lock')) {
      ctx.progress?.(90, '检查残留网关锁');
      try {
        const dir = lockDir();
        const locks = readdirSync(dir).filter((f) => /^gateway\..*\.lock$/.test(f));
        let stale = 0;
        for (const name of locks) {
          const payload = readJson(join(dir, name));
          const pid = payload ? Number(payload.pid) : NaN;
          if (!payload || !Number.isFinite(pid) || !pidAlive(pid)) stale++;
        }
        if (stale) add('warn', 'lock.stale', '存在失效网关锁', `${stale} 个（共 ${locks.length} 个）`, '跑 lock.clean，或重新双击启动脚本');
        else add('ok', 'lock.stale', '无失效网关锁', `共 ${locks.length} 个锁，持有进程均存活`);
      } catch {
        add('ok', 'lock.stale', '无残留锁目录', lockDir());
      }
    }

    // ── 磁盘 ─────────────────────────────────────────────────────────────
    try {
      const st = statSync(p.root);
      add('info', 'disk.root', 'U-Claw 根目录', `${p.root}（mtime ${st.mtime.toISOString()}）`);
    } catch { /* 拿不到就算了 */ }

    const summary = {
      error: findings.filter((f) => f.level === 'error').length,
      warn: findings.filter((f) => f.level === 'warn').length,
      ok: findings.filter((f) => f.level === 'ok').length,
      info: findings.filter((f) => f.level === 'info').length,
      gateway_port: gatewayPort,
    };
    return { healthy: summary.error === 0, platform: platform(), findings, summary };
  },
});

export default [doctorDiagnose];
