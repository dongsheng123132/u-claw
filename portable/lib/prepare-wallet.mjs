#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUsableModel, simplifyPortableConfig, writeConfigAtomic } from './merge-config.mjs';
import { configWithWalletKey } from './wallet-client.mjs';
import { copyDirSync } from './copy-dir.mjs';

export function prepareWallet(portableRoot, stateDir) {
  portableRoot = path.resolve(portableRoot);
  stateDir = path.resolve(stateDir);
  const configPath = path.join(stateDir, 'openclaw.json');
  const sourceConfigPath = fs.existsSync(configPath) ? configPath : path.join(portableRoot, 'default-config.json');
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('object required');
  } catch {
    // 在创建目录或复制插件之前拒绝坏配置，保留客户文件原字节供其修复。
    throw new Error('OpenClaw config is invalid; repair it before starting U-Claw');
  }
  let consumerConfig = existing;
  const walletPath = path.join(stateDir, 'uclaw-device.json');
  // v2.3.2：用户已经配好可用模型（含第三方 / 自定义 Key）时，启动不再用本地钱包覆盖；
  // 钱包领取 / 换钥仍是显式动作。旧逻辑只看「虾盘云有没有 Key」，会把自定义配置冲掉。
  if (!hasUsableModel(existing) && fs.existsSync(walletPath)) {
    let wallet;
    try {
      wallet = JSON.parse(fs.readFileSync(walletPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) throw new Error('object required');
      if (wallet.apiKey && (typeof wallet.apiKey !== 'string' || /\s|\.\.\.|…|\*|__OPENCLAW_REDACTED__/.test(wallet.apiKey))) throw new Error('invalid key');
    } catch {
      throw new Error('Local wallet is invalid; repair it before starting U-Claw');
    }
    if (wallet.apiKey) consumerConfig = configWithWalletKey(existing, wallet.apiKey);
  }
  const source = path.join(portableRoot, 'extensions', 'uclaw-wallet');
  // 放在 core/node_modules 下，让官方 SDK 的 bare imports 在 exFAT 上也能正常解析。
  const pluginDir = path.join(portableRoot, 'app', 'core', 'node_modules', '@uclaw', 'wallet');
  if (!fs.existsSync(path.join(source, 'openclaw.plugin.json'))) throw new Error('U-Claw wallet plugin is missing');
  fs.mkdirSync(pluginDir, { recursive: true });
  // 用安全的同步复制（cpSync 在 Windows+Node 22 复制该目录会栈溢出崩溃）。
  copyDirSync(source, pluginDir);
  const next = simplifyPortableConfig(consumerConfig);
  next.gateway = next.gateway || { mode: 'local', auth: { mode: 'token', token: 'uclaw' } };
  next.gateway.controlUi = { ...next.gateway.controlUi, experimental: { ...next.gateway.controlUi?.experimental, customPlugins: true } };
  next.plugins = { ...next.plugins, allow: ['uclaw-wallet'],
    load: { ...next.plugins?.load, paths: [pluginDir] },
    entries: { ...next.plugins?.entries, 'uclaw-wallet': { enabled: true, config: { portableRoot, stateDir } } } };
  if (JSON.stringify(existing) !== JSON.stringify(next)) writeConfigAtomic(configPath, next);
  return { ok: true, pluginDir, configPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const portableRoot = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
    const stateDir = process.argv[3] || path.join(portableRoot, 'data', '.openclaw');
    console.log(JSON.stringify(prepareWallet(portableRoot, stateDir)));
  } catch (error) {
    console.error('Wallet setup failed: ' + error.message);
    process.exitCode = 1;
  }
}
