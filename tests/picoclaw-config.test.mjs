// 守卫测试：钱包双写两核（OpenClaw + PicoClaw/Lite）与 PicoClaw 配置读写。
//
// 真实 .security.yml schema（上游 v0.3.1 源码核实：根层 model_list，别名 map 挂在它下面，
// 别名形如 `xiapan-v4-flash:0`，key 存块序列 api_keys 列表）：
//   model_list:
//     xiapan-v4-flash:0:
//       api_keys:
//         - "sk-..."
//
// 锁六件事：
//   1. applyKey 同一 key 同时写进 openclaw.json 与 data/picoclaw/.security.yml（无条件双写，
//      picoHome 默认从 configPath 推导）；config.json 不含明文 key；apiBase 两核一致（不漂 .cn 默认）。
//   2. removeKey 双清：OpenClaw 删 provider + PicoClaw 删钱包别名块（整块消失，无旧凭据字段残留）。
//   3. 轮换（applyKey 第二次写不同 key）：两核同时更新，用户块保留，别名块无旧 key 残留。
//   4. 保守 block YAML 子集：解析/序列化对称；锚点/别名/标签/非空 flow/重复 key/Tab/多文档
//      一律 fail-closed 拒绝且原文件一字不动；用户的其它 YAML 块在写/删后原样保留。
//   5. key 经 JSON.stringify 转义（引号/反斜杠安全）；hasPicoclawWalletKey 只回布尔不回显。
//   6. config.json：version:3、provider=deepseek 强制修复、历史遗留 api_key/api_keys 字段清掉。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyKey,
  removeKey,
  CLOUD_PROVIDER_ID,
} from '../portable/lib/wallet-client.mjs';
import {
  writePicoclawWalletConfig,
  removePicoclawWalletKey,
  hasPicoclawWalletKey,
  readPicoclawWalletKey,
  parseYamlSubset,
  serializeYamlSubset,
  PICO_MODEL_ALIAS,
  PICO_MODEL_NAME,
  PICO_PROVIDER,
  PICO_CONFIG_VERSION,
} from '../portable/lib/picoclaw-config.mjs';

const root = mkdtempSync(join(tmpdir(), 'uclaw-dualwrite-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

function freshConfig() {
  const d = mkdtempSync(join(root, 'cfg-'));
  return join(d, 'openclaw.json');
}

// configPath 与 picoHome 同临时根（模拟 sandbox/生产 data/ 布局）：验证默认 picoHome 推导
// （configPath basename 不是 .openclaw → 同目录 picoclaw/）也能正确落点。
function freshSandbox() {
  const d = mkdtempSync(join(root, 'sb-'));
  return { configPath: join(d, 'openclaw.json'), picoHome: join(d, 'picoclaw') };
}

const WALLET_BLOCK = `${PICO_MODEL_ALIAS}:\n    api_keys:\n      -`;

test('applyKey 双写：默认 picoHome 推导下，openclaw.json 与 picoclaw .security.yml 同一 key，config.json 无明文 key', () => {
  const sb = freshSandbox();
  const apiKey = 'sk-dualwrite-test-key-123456';

  applyKey(sb.configPath, apiKey);

  // OpenClaw 侧：provider 写入且持有 key
  const oc = JSON.parse(readFileSync(sb.configPath, 'utf8'));
  assert.equal(oc.models.providers[CLOUD_PROVIDER_ID].apiKey, apiKey, 'OpenClaw 应有 wallet key');

  // PicoClaw 侧：.security.yml 是真实 schema（根层 model_list + 别名块 + api_keys 块序列）
  const sec = readFileSync(join(sb.picoHome, '.security.yml'), 'utf8');
  assert.match(sec, /^model_list:\n/m, '根层必须有 model_list');
  assert.ok(sec.includes(WALLET_BLOCK), '应有真实 schema 的钱包别名块（含 api_keys 块序列）');
  const parsed = parseYamlSubset(sec);
  assert.deepEqual(parsed.model_list[PICO_MODEL_ALIAS].api_keys, [apiKey], '解析出的 key 应一致');
  assert.equal(parsed.model_list[PICO_MODEL_ALIAS].provider, undefined, 'security 侧不放多余字段');

  // config.json 不含明文 key
  const cfg = JSON.parse(readFileSync(join(sb.picoHome, 'config.json'), 'utf8'));
  assert.ok(!JSON.stringify(cfg).includes(apiKey), 'config.json 不应含明文 key');
  assert.ok(cfg.model_list.some((m) => m.model_name === PICO_MODEL_NAME), 'config.json 应有钱包模型项');
  assert.equal(cfg.version, PICO_CONFIG_VERSION, '应生成 version:3（避免上游 V0 迁移改写）');
  const entry = cfg.model_list.find((m) => m.model_name === PICO_MODEL_NAME);
  assert.equal(entry.provider, PICO_PROVIDER, 'provider 必须是 deepseek（上游必填）');
  assert.equal(cfg.agents.defaults.model_name, PICO_MODEL_NAME);
});

test('applyKey 双写（显式 picoHome 覆盖仍有效）', () => {
  const configPath = freshConfig();
  const picoHome = mkdtempSync(join(root, 'pico-explicit-'));
  const apiKey = 'sk-explicit-pico-1234';

  applyKey(configPath, apiKey, { picoHome });

  const oc = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(oc.models.providers[CLOUD_PROVIDER_ID].apiKey, apiKey);
  assert.equal(hasPicoclawWalletKey({ picoHome }), true);
  // 同目录不应被误写（默认推导没被用到）
  assert.equal(existsSync(join(configPath, '..', 'picoclaw')), false, '显式 picoHome 时不应另写推导位置');
});

test('applyKey 两核 apiBase 一致（不漂 .cn 默认）', () => {
  const sb = freshSandbox();
  const apiKey = 'sk-baseurl-test-123456';
  const apiBase = 'https://api.example.com/v1';

  applyKey(sb.configPath, apiKey, { picoHome: sb.picoHome, apiBase });

  const oc = JSON.parse(readFileSync(sb.configPath, 'utf8'));
  assert.equal(oc.models.providers[CLOUD_PROVIDER_ID].baseUrl, apiBase, 'OpenClaw baseUrl 应取传入值');
  const cfg = JSON.parse(readFileSync(join(sb.picoHome, 'config.json'), 'utf8'));
  const m = cfg.model_list.find((x) => x.model_name === PICO_MODEL_NAME);
  assert.equal(m.api_base, apiBase, 'PicoClaw api_base 应与 OpenClaw 一致');
});

test('removeKey 双清：OpenClaw provider 与 PicoClaw 钱包别名块（整块）同时消失', () => {
  const sb = freshSandbox();
  const apiKey = 'sk-remove-test-key-1234';
  applyKey(sb.configPath, apiKey, { picoHome: sb.picoHome });
  assert.equal(hasPicoclawWalletKey({ picoHome: sb.picoHome }), true, '写后应有 key');

  removeKey(sb.configPath, { picoHome: sb.picoHome });

  const oc = JSON.parse(readFileSync(sb.configPath, 'utf8'));
  assert.ok(!(CLOUD_PROVIDER_ID in (oc.models?.providers || {})), 'OpenClaw provider 应被删除');
  const sec = readFileSync(join(sb.picoHome, '.security.yml'), 'utf8');
  const parsed = parseYamlSubset(sec);
  assert.ok(!(PICO_MODEL_ALIAS in (parsed.model_list || {})), '钱包别名块应整体消失（无旧凭据字段残留）');
  assert.equal(hasPicoclawWalletKey({ picoHome: sb.picoHome }), false);
});

test('双写轮换：第二次 applyKey 换 key，两核同步更新，别名块无旧 key 残留', () => {
  const sb = freshSandbox();
  applyKey(sb.configPath, 'sk-rotate-old-0001', { picoHome: sb.picoHome });
  applyKey(sb.configPath, 'sk-rotate-new-0002', { picoHome: sb.picoHome });

  const oc = JSON.parse(readFileSync(sb.configPath, 'utf8'));
  assert.equal(oc.models.providers[CLOUD_PROVIDER_ID].apiKey, 'sk-rotate-new-0002');
  const sec = readFileSync(join(sb.picoHome, '.security.yml'), 'utf8');
  assert.ok(!sec.includes('sk-rotate-old-0001'), '旧 key 不得残留在 .security.yml（含别名块其它字段）');
  assert.equal(readPicoclawWalletKey({ picoHome: sb.picoHome }), 'sk-rotate-new-0002');
  // 别名块整体替换后不残留任意旧字段
  const parsed = parseYamlSubset(sec);
  assert.deepEqual(Object.keys(parsed.model_list[PICO_MODEL_ALIAS]), ['api_keys']);
});

test('writePicoclawWalletConfig 只动钱包别名块，保留用户其它 YAML 块（写与删两个方向）', () => {
  const picoHome = mkdtempSync(join(root, 'pico-keep-'));
  mkdirSync(picoHome, { recursive: true });
  const userYml = [
    'model_list:',
    '  xiapan-v4-flash:0:',
    '    api_keys:',
    '      - "sk-old-wallet"',
    '  my-other-model:0:',
    '    api_keys:',
    '      - "sk-user-own-key"',
  ].join('\n') + '\n';
  writeFileSync(join(picoHome, '.security.yml'), userYml, 'utf8');
  const apiKey = 'sk-wallet-overlay-1234';

  writePicoclawWalletConfig({ picoHome, apiKey });

  const sec = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.ok(sec.includes('my-other-model:0:'), '用户的其它模型块应保留');
  assert.ok(sec.includes('sk-user-own-key'), '用户的其它 key 应保留');
  assert.ok(!sec.includes('sk-old-wallet'), '旧钱包 key 不应残留');
  assert.ok(sec.includes(`${PICO_MODEL_ALIAS}:`), '应有钱包别名块');

  removePicoclawWalletKey({ picoHome });
  const afterRemove = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.ok(afterRemove.includes('my-other-model:0:'), '删除后用户块仍保留');
  assert.ok(afterRemove.includes('sk-user-own-key'), '删除后用户 key 仍保留');
  assert.ok(!afterRemove.includes(PICO_MODEL_ALIAS), '删除后钱包别名块消失');
  assert.ok(afterRemove.startsWith('model_list:'), 'model_list 根键保留（还有别的块）');
});

test('损坏/未知结构 .security.yml fail-closed：抛错且原文件一字不动', () => {
  const picoHome = mkdtempSync(join(root, 'pico-bad-'));
  mkdirSync(picoHome, { recursive: true });
  const cases = {
    anchor: 'model_list: &anchor\n  x:0:\n    api_keys: []\n',
    alias: 'model_list: *anchor\n',
    tag: 'model_list: !!map\n  x:0:\n    api_keys: []\n',
    nonEmptyFlow: 'model_list: {a: 1}\n',
    duplicateKey: 'model_list:\n  a:0:\n    api_keys: []\n  a:0:\n    api_keys: []\n',
    tabIndent: 'model_list:\n\tx:0:\n',
    multiDoc: '---\nmodel_list: {}\n',
    inlineComment: 'model_list:\n  x:0: # hi\n    api_keys: []\n',
    blockScalar: 'model_list:\n  x:0:\n    api_keys: |\n      a\n',
    unrecognized: 'this: is: not: valid\n',
    noStructure: 'random text without structure\n',
    rootSequence: '- a\n- b\n',
  };
  for (const [name, content] of Object.entries(cases)) {
    writeFileSync(join(picoHome, '.security.yml'), content, 'utf8');
    assert.throws(
      () => writePicoclawWalletConfig({ picoHome, apiKey: 'sk-x-1' }),
      (err) => /fail-closed/.test(err.message),
      `应 fail-closed 拒绝: ${name}`
    );
    assert.equal(
      readFileSync(join(picoHome, '.security.yml'), 'utf8'),
      content,
      `${name}: 原文件不应被改动`
    );
    // remove 与 has 同样 fail-closed：remove 抛错不删文件，has 不误报有 key
    assert.throws(() => removePicoclawWalletKey({ picoHome }), /fail-closed|mapping|subset/, `${name}: remove 也应 fail-closed`);
    assert.equal(existsSync(join(picoHome, '.security.yml')), true, `${name}: remove 不应删文件`);
  }
});

test('顶层裸别名（我们旧版错误输出）被识别并规范化为真实 schema，不丢用户块', () => {
  const picoHome = mkdtempSync(join(root, 'pico-legacy-'));
  mkdirSync(picoHome, { recursive: true });
  // 旧版实现写出的错误形状：顶层裸别名（无 model_list 根层）+ 单行 flow 数组
  const legacy = 'xiapan-v4-flash:0:\n  api_keys: ["sk-legacy"]\nmy-own:0:\n  api_keys: ["sk-user"]\n';
  writeFileSync(join(picoHome, '.security.yml'), legacy, 'utf8');

  writePicoclawWalletConfig({ picoHome, apiKey: 'sk-migrated-1' });

  const sec = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.match(sec, /^model_list:\n/m, '应规范化出 model_list 根层');
  const parsed = parseYamlSubset(sec);
  assert.deepEqual(parsed.model_list[PICO_MODEL_ALIAS].api_keys, ['sk-migrated-1']);
  assert.deepEqual(parsed.model_list['my-own:0'].api_keys, ['sk-user'], '用户块迁移后保留');
  assert.ok(!sec.includes('sk-legacy'));
});

test('旧版单行 flow 数组（api_keys: ["..."]）在别名键行上可读：upsert 后规范化为块序列', () => {
  const picoHome = mkdtempSync(join(root, 'pico-flow-legacy-'));
  mkdirSync(picoHome, { recursive: true });
  // 旧版 ALIAS_BLOCK_RE 形状：别名块下的 api_keys 是单行 flow 数组
  writeFileSync(join(picoHome, '.security.yml'), 'model_list:\n  xiapan-v4-flash:0:\n    api_keys: ["sk-flow-legacy"]\n');
  writePicoclawWalletConfig({ picoHome, apiKey: 'sk-flow-new-1' });
  const sec = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.ok(!sec.includes('sk-flow-legacy'), '旧 key 应被替换');
  assert.equal(readPicoclawWalletKey({ picoHome }), 'sk-flow-new-1');
  const parsed = parseYamlSubset(sec);
  assert.deepEqual(parsed.model_list[PICO_MODEL_ALIAS].api_keys, ['sk-flow-new-1']);
});

test('parse/serialize 对称（往返一致）与 key 转义', () => {
  const tricky = 'sk-a"b\\c:d #e';
  const doc = { model_list: { [PICO_MODEL_ALIAS]: { api_keys: [tricky] }, 'x:0': { api_keys: [] } } };
  const yml = serializeYamlSubset(doc);
  const back = parseYamlSubset(yml);
  assert.deepEqual(back, doc, '序列化→解析应往返一致');
  assert.equal(back.model_list[PICO_MODEL_ALIAS].api_keys[0], tricky, '特殊字符 key 应原样读回');

  // JSON 子集等价：PicoClaw 的 YAML 是 JSON 子集，我们生成的引号标量可直接 JSON.parse
  const quoted = yml.split('\n').find((l) => l.trim().startsWith('- '));
  const value = JSON.parse(quoted.trim().slice(2));
  assert.equal(value, tricky);
});

test('removePicoclawWalletKey 幂等：无 key / 无文件时安全返回', () => {
  const picoHome = mkdtempSync(join(root, 'pico-idem-'));
  const r1 = removePicoclawWalletKey({ picoHome });
  assert.equal(r1.removed, false, '无文件应返回 removed=false 不报错');
  assert.equal(existsSync(join(picoHome, '.security.yml')), false);

  mkdirSync(picoHome, { recursive: true });
  writeFileSync(join(picoHome, '.security.yml'), 'model_list:\n  other:0:\n    api_keys:\n      - "sk-x"\n');
  const r2 = removePicoclawWalletKey({ picoHome });
  assert.equal(r2.removed, false, '无钱包块时幂等返回');
  const r3 = removePicoclawWalletKey({ picoHome });
  assert.equal(r3.removed, false);
});

test('hasPicoclawWalletKey 只回布尔，不回显 key；读不到 key 返回空串', () => {
  const picoHome = mkdtempSync(join(root, 'pico-bool-'));
  assert.equal(hasPicoclawWalletKey({ picoHome }), false);
  assert.equal(readPicoclawWalletKey({ picoHome }), '');
  writePicoclawWalletConfig({ picoHome, apiKey: 'sk-bool-test-1234' });
  assert.equal(hasPicoclawWalletKey({ picoHome }), true);
  assert.equal(readPicoclawWalletKey({ picoHome }), 'sk-bool-test-1234');
  const sec = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.ok(sec.includes('sk-bool-test-1234'), 'key 确实在文件里（函数只是不回显）');
});

test('config.json 历史遗留 api_key/api_keys 字段被清掉，provider 空缺被修复；key 泄漏进 config.json 时拒绝写', () => {
  const picoHome = mkdtempSync(join(root, 'pico-cfg-'));
  mkdirSync(picoHome, { recursive: true });
  writeFileSync(
    join(picoHome, 'config.json'),
    JSON.stringify({ model_list: [{ model_name: PICO_MODEL_NAME, provider: '', api_key: 'sk-leak-1', api_keys: ['sk-leak-2'], enabled: false }] })
  );

  writePicoclawWalletConfig({ picoHome, apiKey: 'sk-fix-1' });

  const cfg = JSON.parse(readFileSync(join(picoHome, 'config.json'), 'utf8'));
  const entry = cfg.model_list.find((m) => m.model_name === PICO_MODEL_NAME);
  assert.equal(entry.provider, PICO_PROVIDER, 'provider 空缺应强制 deepseek');
  assert.ok(!('api_key' in entry) && !('api_keys' in entry), '历史遗留明文字段应清掉');
  assert.ok(!JSON.stringify(cfg).includes('sk-leak-1') && !JSON.stringify(cfg).includes('sk-leak-2'));

  // 防御：若用户在钱包项里手工塞了与本次相同的 key，拒绝写 config.json
  const hostile = mkdtempSync(join(root, 'pico-hostile-'));
  mkdirSync(hostile, { recursive: true });
  writeFileSync(
    join(hostile, 'config.json'),
    JSON.stringify({ model_list: [{ model_name: PICO_MODEL_NAME, provider: 'deepseek', note: 'sk-hostile-1' }] })
  );
  assert.throws(() => writePicoclawWalletConfig({ picoHome: hostile, apiKey: 'sk-hostile-1' }), /refusing to write/);
});

test('原子写失败不留临时文件（损坏 config.json 时抛错且 .security.yml 未被动过）', () => {
  const picoHome = mkdtempSync(join(root, 'pico-atomic-'));
  mkdirSync(picoHome, { recursive: true });
  writeFileSync(join(picoHome, 'config.json'), '{ not json');
  writeFileSync(join(picoHome, '.security.yml'), 'model_list:\n  other:0:\n    api_keys:\n      - "sk-user"\n');

  assert.throws(() => writePicoclawWalletConfig({ picoHome, apiKey: 'sk-x-9' }), /corrupt|fail-closed/);
  const leftovers = readFileSync(join(picoHome, '.security.yml'), 'utf8');
  assert.ok(leftovers.includes('sk-user'), 'config.json 损坏时 .security.yml 不应被先写坏');
});
