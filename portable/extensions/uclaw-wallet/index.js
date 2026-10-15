import { defineFeaturePlugin } from 'openclaw/plugin-sdk/feature-plugin';
import { contract } from './contract.js';
import { createWalletHandlers } from './runtime.js';

const plugin = defineFeaturePlugin({
  contract, name: '虾盘云设备钱包', description: '设备钱包、一键充值与唯一默认模型。',
  setup(api) { return createWalletHandlers(api.pluginConfig); },
});
const registerFeature = plugin.register;
plugin.register = (api) => {
  registerFeature(api);
  api.session.controls.registerControlUiDescriptor({
    surface: 'tab', id: 'wallet', label: '设备钱包', icon: 'wallet', group: 'control', requiredScopes: ['operator.read'],
  });
};
export default plugin;
