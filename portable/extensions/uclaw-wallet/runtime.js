import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createWalletHandlers(config, injectedWallet) {
  let loaded;
  async function wallet() {
    return injectedWallet || (loaded ||= import(pathToFileURL(path.join(config.portableRoot, 'lib', 'wallet-client.mjs')).href));
  }
  async function deps() {
    const core = await wallet();
    return { store: core.createFileWalletStore(path.join(config.stateDir, 'uclaw-device.json')), configPath: path.join(config.stateDir, 'openclaw.json'), portableRoot: config.portableRoot };
  }
  const call = async (name, ...args) => {
    const core = await wallet();
    return core[name](...args, await deps());
  };
  const withoutSecrets = (result) => {
    const copy = { ...result };
    for (const key of ['apiKey', 'key', 'pendingKey', 'pendingFrom']) delete copy[key];
    return copy;
  };
  return {
    async status() {
      const state = await call('getStatus');
      const key = state.apiKey || '';
      return { ok: state.ok !== false, hasWallet: !!state.hasWallet, maskedKey: key ? (key.length <= 10 ? '***' : key.slice(0, 6) + '…' + key.slice(-4)) : '', model: 'deepseek-v4-flash', ...(state.error ? { error: state.error } : {}) };
    },
    balance: () => call('getBalance'),
    claim: async () => withoutSecrets(await call('claimWallet')),
    async recharge() {
      const state = await call('getStatus');
      if (!state.hasWallet || !state.apiKey) return { ok: false, error: '请先领取或启用设备钱包' };
      const core = await wallet();
      return { ok: true, url: core.payBaseUrl() + '/recharge?key=' + encodeURIComponent(state.apiKey) };
    },
    async 'copy-key'() {
      const state = await call('getStatus');
      return state.apiKey ? { ok: true, key: state.apiKey } : { ok: false, error: '还没有可复制的密钥' };
    },
    rotate: async ({ confirmed }) => confirmed === true ? withoutSecrets(await call('rotateWallet')) : { ok: false, error: '请先确认轮换密钥' },
    adopt: async ({ key }) => withoutSecrets(await call('adoptWallet', key)),
    reset: ({ confirmed }) => confirmed === true ? call('resetLocalWallet') : { ok: false, error: '请先确认已备份密钥' },
  };
}
