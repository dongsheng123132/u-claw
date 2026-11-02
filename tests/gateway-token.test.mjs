// 回归测试：P1 gateway token 随机化 + gateway 网络暴露面显式收敛。
//
// 覆盖 portable/lib/gateway-token.mjs 的契约：
//   - 首次启动生成 32 字节随机 hex（POSIX 0600），写 token 文件与 openclaw.json；
//   - 幂等：第二次调用不重写文件、token 不变；
//   - 旧版固定值 "uclaw"（配置或 token 文件里）自动升级为随机值，写前留 .bak；
//   - 用户自定义 token 不被轮换；
//   - JSON 损坏 / 磁盘不可写时静默返回原值或 null，绝不抛给启动脚本；
//   - normalizeGatewayBinding 缺省补全、显式设置不覆盖、不改入参；
//   - readGatewayToken 文件优先 → 配置兜底 → null。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureGatewayToken,
  readGatewayToken,
  normalizeGatewayBinding,
  GATEWAY_TOKEN_FILE,
  OPENCLAW_CONFIG_FILE,
  GATEWAY_TOKEN_BACKUP,
  LEGACY_GATEWAY_TOKEN,
} from '../portable/lib/gateway-token.mjs';

const modulePath = fileURLToPath(new URL('../portable/lib/gateway-token.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultConfigPath = join(repoRoot, 'portable', 'default-config.json');
const HEX64 = /^[0-9a-f]{64}$/;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-gateway-token-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function configPathOf(dir) {
  return join(dir, OPENCLAW_CONFIG_FILE);
}

function writeConfig(dir, config) {
  writeFileSync(configPathOf(dir), JSON.stringify(config, null, 2));
}

function readConfig(dir) {
  return JSON.parse(readFileSync(configPathOf(dir), 'utf8'));
}

function readTokenFile(dir) {
  return readFileSync(join(dir, GATEWAY_TOKEN_FILE), 'utf8');
}

// ── ensureGatewayToken：生成 / 幂等 ──────────────────────────────────────

test('ensureGatewayToken: 首次启动生成 32 字节随机 hex，写 token 文件并注入 openclaw.json', () => {
  withTempDir((dir) => {
    const result = ensureGatewayToken(dir);

    assert.equal(result.source, 'created');
    assert.equal(result.changed, true);
    assert.match(result.token, HEX64);
    assert.equal(readTokenFile(dir).trim(), result.token);

    const config = readConfig(dir);
    assert.deepEqual(config.gateway.auth, { mode: 'token', token: result.token });
    assert.equal(config.gateway.bind, 'loopback');
    assert.deepEqual(config.gateway.tailscale, { mode: 'off' });
    assert.equal(existsSync(join(dir, GATEWAY_TOKEN_BACKUP)), false, '首次创建没有旧配置，不该有备份');
  });
});

test('ensureGatewayToken: 用新 default-config 种子（token 为空）首次启动时注入随机 token', () => {
  withTempDir((dir) => {
    copyFileSync(defaultConfigPath, configPathOf(dir));
    const seeded = JSON.parse(readFileSync(configPathOf(dir), 'utf8'));

    const result = ensureGatewayToken(dir);

    assert.equal(result.source, 'created');
    assert.match(result.token, HEX64);
    const config = readConfig(dir);
    assert.equal(config.gateway.auth.mode, 'token');
    assert.equal(config.gateway.auth.token, result.token);
    // 其它字段一个都不能动
    assert.deepEqual(config.agents, seeded.agents);
    assert.deepEqual(config.plugins, seeded.plugins);
    assert.deepEqual(config.update, seeded.update);
  });
});

test('ensureGatewayToken: token 文件在 POSIX 上是 0600', { skip: process.platform === 'win32' }, () => {
  withTempDir((dir) => {
    ensureGatewayToken(dir);
    assert.equal(statSync(join(dir, GATEWAY_TOKEN_FILE)).mode & 0o777, 0o600);
  });
});

test('ensureGatewayToken: 第二次调用幂等——token 不变、changed=false、文件字节不变', () => {
  withTempDir((dir) => {
    const first = ensureGatewayToken(dir);
    const configBefore = readFileSync(configPathOf(dir), 'utf8');
    const tokenBefore = readTokenFile(dir);

    const second = ensureGatewayToken(dir);

    assert.equal(second.token, first.token);
    assert.equal(second.changed, false);
    assert.equal(second.source, 'existing');
    assert.equal(readFileSync(configPathOf(dir), 'utf8'), configBefore, '幂等调用不应重写配置');
    assert.equal(readTokenFile(dir), tokenBefore, '幂等调用不应重写 token 文件');
  });
});

// ── 迁移：旧版固定值 "uclaw" ────────────────────────────────────────────

test('ensureGatewayToken: 旧版固定 token "uclaw" 升级为随机值，并备份旧配置', () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      gateway: { mode: 'local', auth: { mode: 'token', token: LEGACY_GATEWAY_TOKEN } },
      plugins: { allow: ['uclaw-wallet'] },
      models: { mode: 'replace', providers: { 'uclaw-cloud': { baseUrl: 'https://api.u-claw.org/v1' } } },
    });

    const result = ensureGatewayToken(dir);

    assert.equal(result.source, 'migrated');
    assert.equal(result.changed, true);
    assert.match(result.token, HEX64);
    assert.notEqual(result.token, LEGACY_GATEWAY_TOKEN);

    const config = readConfig(dir);
    assert.equal(config.gateway.auth.mode, 'token');
    assert.equal(config.gateway.auth.token, result.token);
    // 升级 token 不能顺手把用户其它配置冲掉
    assert.deepEqual(config.plugins, { allow: ['uclaw-wallet'] });
    assert.equal(config.models.providers['uclaw-cloud'].baseUrl, 'https://api.u-claw.org/v1');
    assert.equal(readTokenFile(dir).trim(), result.token);

    // 写前备份：备份里保留的是迁移前的旧值
    const backupPath = join(dir, GATEWAY_TOKEN_BACKUP);
    assert.ok(existsSync(backupPath), '迁移前必须留 openclaw.json.bak-gateway-token');
    assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).gateway.auth.token, LEGACY_GATEWAY_TOKEN);
  });
});

test('ensureGatewayToken: token 文件里是旧值 "uclaw" 时同样升级', () => {
  withTempDir((dir) => {
    writeConfig(dir, { gateway: { mode: 'local', auth: { mode: 'token', token: LEGACY_GATEWAY_TOKEN } } });
    writeFileSync(join(dir, GATEWAY_TOKEN_FILE), LEGACY_GATEWAY_TOKEN + '\n');

    const result = ensureGatewayToken(dir);

    assert.equal(result.source, 'migrated');
    assert.match(result.token, HEX64);
    assert.equal(readTokenFile(dir).trim(), result.token);
    assert.equal(readConfig(dir).gateway.auth.token, result.token);
  });
});

test('ensureGatewayToken: token 文件里的有效 token 优先，配置里的旧固定值被同步', () => {
  withTempDir((dir) => {
    const custom = 'f'.repeat(64);
    writeConfig(dir, { gateway: { mode: 'local', auth: { mode: 'token', token: LEGACY_GATEWAY_TOKEN } } });
    writeFileSync(join(dir, GATEWAY_TOKEN_FILE), custom + '\n');

    const result = ensureGatewayToken(dir);

    assert.equal(result.token, custom);
    assert.equal(result.source, 'migrated');
    assert.equal(readConfig(dir).gateway.auth.token, custom);
  });
});

test('ensureGatewayToken: 用户自定义 token 不轮换，只补落 token 文件', () => {
  withTempDir((dir) => {
    writeConfig(dir, { gateway: { mode: 'local', auth: { mode: 'token', token: 'my-own-token-123' } } });

    const result = ensureGatewayToken(dir);

    assert.equal(result.token, 'my-own-token-123');
    assert.equal(result.source, 'existing');
    assert.equal(result.changed, true, 'token 文件是本次补写的');
    assert.equal(readTokenFile(dir).trim(), 'my-own-token-123');
    assert.equal(readConfig(dir).gateway.auth.token, 'my-own-token-123');
  });
});

// ── 静默失败：坏 JSON / 磁盘不可写 ─────────────────────────────────────

test('ensureGatewayToken: 配置 JSON 损坏时不抛、不覆盖坏文件，token 仍落 token 文件', () => {
  withTempDir((dir) => {
    const broken = '{ this is not valid json ';
    writeFileSync(configPathOf(dir), broken);

    let result;
    assert.doesNotThrow(() => { result = ensureGatewayToken(dir); });

    assert.match(result.token, HEX64);
    assert.equal(result.source, 'created');
    assert.equal(readFileSync(configPathOf(dir), 'utf8'), broken, '损坏的配置不能被静默覆盖');
    assert.equal(readTokenFile(dir).trim(), result.token);
  });
});

test('ensureGatewayToken / readGatewayToken: 磁盘不可写时静默返回 null，不抛', () => {
  withTempDir((dir) => {
    const bogus = join(dir, 'not-a-directory');
    writeFileSync(bogus, 'plain file used as state dir');

    let result;
    assert.doesNotThrow(() => { result = ensureGatewayToken(bogus); });
    assert.equal(result.token, null);
    assert.equal(result.changed, false);

    assert.equal(readGatewayToken(bogus), null);
    assert.equal(readGatewayToken(null), null);
    assert.equal(readGatewayToken(join(dir, 'missing-dir')), null);
  });
});

// ── readGatewayToken：文件优先 → 配置兜底 → null ────────────────────────

test('readGatewayToken: token 文件优先、坏文件退回配置、都坏返回 null', () => {
  withTempDir((dir) => {
    assert.equal(readGatewayToken(dir), null, '什么都没有时返回 null');

    writeConfig(dir, { gateway: { mode: 'local', auth: { mode: 'token', token: 'config-only-token' } } });
    assert.equal(readGatewayToken(dir), 'config-only-token', '没有 token 文件时退回配置');

    writeFileSync(join(dir, GATEWAY_TOKEN_FILE), '   \n\t ');
    assert.equal(readGatewayToken(dir), 'config-only-token', '空白 token 文件视为损坏，退回配置');

    writeFileSync(join(dir, GATEWAY_TOKEN_FILE), 'file-token-ok');
    assert.equal(readGatewayToken(dir), 'file-token-ok', 'token 文件优先');

    writeFileSync(configPathOf(dir), '{broken json');
    assert.equal(readGatewayToken(dir), 'file-token-ok', '配置坏了但 token 文件还在');

    rmSync(join(dir, GATEWAY_TOKEN_FILE));
    assert.equal(readGatewayToken(dir), null, '两边都坏时返回 null');
  });
});

// ── normalizeGatewayBinding：缺省补全 / 显式不覆盖 / 不改入参 ───────────

test('normalizeGatewayBinding: 缺省补全 loopback + tailscale off，且不改入参', () => {
  const input = {};
  const out = normalizeGatewayBinding(input);

  assert.equal(out.gateway.bind, 'loopback');
  assert.deepEqual(out.gateway.tailscale, { mode: 'off' });
  assert.deepEqual(input, {}, '不得修改入参');
  assert.notEqual(out, input);

  // 没有 gateway 段也能补
  assert.equal(normalizeGatewayBinding({ models: {} }).gateway.bind, 'loopback');

  // 非法入参不抛，按空配置补默认
  assert.doesNotThrow(() => normalizeGatewayBinding(null));
  assert.deepEqual(normalizeGatewayBinding(null), {
    gateway: { bind: 'loopback', tailscale: { mode: 'off' } },
  });
});

test('normalizeGatewayBinding: 用户显式设置一律不覆盖', () => {
  const input = {
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: 19001,
      auth: { mode: 'token', token: 'keep-me' },
      tailscale: { mode: 'on', resetOnExit: true, extra: 'kept' },
      controlUi: { experimental: { customPlugins: true } },
    },
    unknown: { retained: true },
  };

  const out = normalizeGatewayBinding(input);

  // 显式值不覆盖，只剔除上游已废弃的 resetOnExit（保留其它未知键）
  const expected = JSON.parse(JSON.stringify(input));
  delete expected.gateway.tailscale.resetOnExit;
  assert.deepEqual(out, expected);
  assert.equal(input.gateway.bind, 'lan', '输入对象本身不被改动');
  assert.equal(input.gateway.tailscale.resetOnExit, true, '不得修改入参对象');
});

test('normalizeGatewayBinding: tailscale 部分显式时只补缺失键', () => {
  const out = normalizeGatewayBinding({ gateway: { tailscale: { mode: 'on' } } });
  assert.equal(out.gateway.tailscale.mode, 'on');
  assert.equal(Object.prototype.hasOwnProperty.call(out.gateway.tailscale, 'resetOnExit'), false, 'retired resetOnExit must be dropped');

  const withExtra = normalizeGatewayBinding({ gateway: { tailscale: { mode: 'on', extra: 'kept' } } });
  assert.equal(withExtra.gateway.tailscale.extra, 'kept', 'user keys are preserved');

  assert.equal(normalizeGatewayBinding({ gateway: { bind: '0.0.0.0' } }).gateway.bind, '0.0.0.0');
  assert.equal(normalizeGatewayBinding({ gateway: { bind: '' } }).gateway.bind, 'loopback');
  assert.deepEqual(
    normalizeGatewayBinding({ gateway: { tailscale: null } }).gateway.tailscale,
    { mode: 'off' },
  );
});

// ── 配置种子与 CLI（Lead 接线契约） ─────────────────────────────────────

test('default-config.json: gateway.auth.token 改为空占位，不再写死 "uclaw"', () => {
  const raw = readFileSync(defaultConfigPath, 'utf8');
  const config = JSON.parse(raw);

  assert.equal(config.gateway.mode, 'local');
  assert.equal(config.gateway.auth.mode, 'token');
  assert.equal(config.gateway.auth.token, '');
  assert.notEqual(config.gateway.auth.token, LEGACY_GATEWAY_TOKEN);
  assert.doesNotMatch(raw, /"token"\s*:\s*"uclaw"/, 'default-config 里不能继续写死旧 token');
});

test('CLI: node lib/gateway-token.mjs <stateDir> 输出可被启动脚本捕获的 KEY=VALUE', () => {
  withTempDir((dir) => {
    const out = execFileSync(process.execPath, [modulePath, dir], { encoding: 'utf8', timeout: 20_000 });
    const tokenLine = out.split('\n').find((line) => line.startsWith('UCLAW_GATEWAY_TOKEN='));

    assert.ok(tokenLine, '必须输出 UCLAW_GATEWAY_TOKEN=<token>');
    const token = tokenLine.slice('UCLAW_GATEWAY_TOKEN='.length).trim();
    assert.match(token, HEX64);
    assert.match(out, /UCLAW_GATEWAY_TOKEN_SOURCE=created/);
    assert.equal(readGatewayToken(dir), token, 'CLI 输出的 token 必须就是落盘的那个');
  });
});
