const empty = { type: 'object', additionalProperties: false, properties: {} };
const confirmation = { type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { const: true } } };
const output = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, error: { type: 'string', maxLength: 4096 } }, additionalProperties: true };
const operation = (kind, description, input = empty) => ({ kind, description, input, output });
export const contract = {
  pluginId: 'uclaw-wallet', events: {}, operations: {
    status: operation('query', '读取本地钱包状态，不联网，不返回完整密钥'),
    balance: operation('query', '点击后查询钱包余额'),
    claim: operation('action', '点击后一键领取并配置唯一默认模型'),
    recharge: operation('action', '用户点击后取得当前钱包的一键充值链接'),
    'copy-key': operation('action', '用户点击复制后读取钱包密钥以便备份'),
    rotate: operation('action', '确认后轮换钱包密钥', confirmation),
    adopt: operation('action', '验证并启用用户输入的已有钱包密钥', {
      type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 1, maxLength: 4096 } },
    }),
    reset: operation('action', '用户确认备份后移除本地钱包记录', confirmation),
  },
};
