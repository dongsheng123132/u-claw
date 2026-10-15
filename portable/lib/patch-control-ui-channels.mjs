// Removes channel entry points and routes model setup through the native wallet.
// Native plugin navigation, chat, and advanced raw config stay intact.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const EXPECTED_VERSION = '2026.10.2';
export const UI_PATCHES = [
  {
    file: 'control-ui-core-D6S2prEk.js', size: 425573, sha256: '065400f4944b8611659557dd9a128c20f3a1659a27982108fe48732f1f78bd42',
    replacements: [
      ['routes:[`connection`,`channels`,`communications`,`talk`,`devices`,`cloud-workers`]', 'routes:[`connection`,`communications`,`talk`,`devices`,`cloud-workers`]'],
      ['routes:[`agents`,`model-providers`,`search`,`plugin-settings`,`skill-settings`,`mcp`,`memory`,`automation`]', 'routes:[`agents`,`search`,`plugin-settings`,`skill-settings`,`mcp`,`memory`,`automation`]'],
    ],
  },
  {
    file: 'control-ui-core-CExunQhD.js', size: 466078, sha256: 'd647096b85fd9d9fac0d8c42e002ee74dac7838e2925986e98b887062586c09e',
    replacements: [['xr=[`overview`,`files`,`tools`,`skills`,`channels`,`cron`,`memory`]', 'xr=[`overview`,`files`,`tools`,`skills`,`cron`,`memory`]']],
  },
  {
    file: 'settings-targets-B7TZ3ZqH.js', size: 12246, sha256: '97939fa3dc897f9ffa2de73ec50b4d5c5ae52164dc67a3b60d095c1b54225086',
    replacements: [
      ['channels:{routeId:`channels`,labelKey:`quickSettings.channels.title`,hash:``,searchKeys:[`quickSettings.channels.connect`],aliases:`telegram discord slack whatsapp signal imessage`},', ''],
      ['modelBehavior:{...r.modelBehavior,labelKey:`quickSettings.model.title`,searchKeys:[`quickSettings.model.model`,`quickSettings.model.thinking`,`quickSettings.model.fastMode`,`quickSettings.model.thinkingLevels.off`,`quickSettings.model.thinkingLevels.low`,`quickSettings.model.thinkingLevels.medium`,`quickSettings.model.thinkingLevels.high`,`quickSettings.model.fastModes.auto`,`quickSettings.model.fastModes.fast`,`quickSettings.model.fastModes.standard`]},', ''],
    ],
  },
  {
    file: 'custodian-surface-Cug5fuzZ.js', size: 42285, sha256: 'b825725585205123add0041694add39cd18f247b4c9d6107eab8701f39b4eeec',
    replacements: [['function wt(e){return _`<div\n    class="custodian__nudge custodian__nudge--channel-onboarding"', 'function wt(e){return _``;return _`<div\n    class="custodian__nudge custodian__nudge--channel-onboarding"']],
  },
  {
    file: 'control-ui-boot-shared-5tr2Rgvy.js', size: 699785, sha256: '8f8757ecf35680f3eae059dc022bf2b04fa8bf3693688c0c31ae4a7808582b0d',
    replacements: [
      ['$B=[`chat.welcome.suggestions.whatCanYouDo`,`chat.welcome.suggestions.summarizeRecentSessions`,`chat.welcome.suggestions.configureChannel`,`chat.welcome.suggestions.checkSystemHealth`]', '$B=[`chat.welcome.suggestions.whatCanYouDo`,`chat.welcome.suggestions.summarizeRecentSessions`,`chat.welcome.suggestions.checkSystemHealth`]'],
      ['function jO(e,t=M(`modelSetup.required.body`)){return{kind:`above-composer`,text:`${t} ${M(`modelSetup.commandHint`)}`,actionLabel:M(`modelSetup.required.action`),onAction:e}}', 'function jO(e,t=M(`modelSetup.required.body`)){return{kind:`above-composer`,text:`打开设备钱包，领取额度或启用已有虾盘云密钥。`,actionLabel:`打开设备钱包`,onAction:e}}'],
      ['function tD(e,t,n){e?.settingsAgentSelection.set(t),e?.navigate(`model-providers`,{search:`?provider=${encodeURIComponent(n)}`})}', 'function tD(e,t,n){e?.plugins?.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`})}'],
      ['<h2>${M(`modelSetup.required.title`)}</h2>\n        <p class="agent-chat__hint">${M(`modelSetup.required.body`)}</p>', '<h2>启用设备钱包</h2>\n        <p class="agent-chat__hint">打开设备钱包，领取额度或启用已有虾盘云密钥。</p>'],
      ['${M(`modelSetup.required.action`)}\n              </button>', '打开设备钱包\n              </button>'],
    ],
  },
  {
    file: 'control-ui-boot-chat-IjjYAD6-.js', size: 428923, sha256: '226d612a4af5b9a237bf58f6bf5a0bbfa56e975f07bb2e995c7687d9c15896c6',
    replacements: [
      ['modelSetupRequired?tm(()=>this.context.navigate(`model-providers`,{search:`?connect=1`}))', 'modelSetupRequired?tm(()=>this.context.plugins.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`}))'],
      ['onModelSetup:()=>this.context.navigate(`model-setup`),onProviderSettings:', 'onModelSetup:()=>this.context.plugins.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`}),onProviderSettings:'],
      ['onModelSetup:()=>this.context.navigate(`model-setup`),error:', 'onModelSetup:()=>this.context.plugins.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`}),error:'],
      ['onSetup:()=>this.context.navigate(`model-setup`)', 'onSetup:()=>this.context.plugins.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`})'],
    ],
  },
  {
    file: 'control-ui-boot-new-DX1IjXFt.js', size: 342878, sha256: '4fa4e7eccb4e3f25df56409e02a603a0a726393326cf12170cc1bcfe7de02040',
    replacements: [
      ['onModelSetup:()=>e.context?.navigate(`model-setup`)', 'onModelSetup:()=>e.context?.plugins?.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`})'],
      ['onModelSetup:()=>this.context?.navigate(`model-setup`)', 'onModelSetup:()=>this.context?.plugins?.registrations(`pages`).find(e=>e.pluginId===`uclaw-wallet`&&e.value.id===`wallet`)?.host.navigation.openPage({id:`wallet`})'],
    ],
  },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
function manifestGeneration(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.size}\0${entry.sha256}\n`);
  return hash.digest('hex');
}

function addIntegrityMetadataWrites(coreDir, writes) {
  const ui = resolve(coreDir, 'node_modules/openclaw/dist/control-ui');
  const manifestFile = resolve(ui, 'asset-manifest.json');
  const rawManifest = readFileSync(manifestFile);
  const manifest = JSON.parse(rawManifest.toString('utf8'));
  if (!Array.isArray(manifest.assets) || manifest.generation !== manifestGeneration(manifest.assets)) {
    throw new Error('Refuse channels UI patch: invalid asset manifest generation');
  }
  const patchedAssets = new Map(UI_PATCHES.map(patch => [
    'assets/' + patch.file, writes.find(write => write.file === resolve(ui, 'assets', patch.file)).after,
  ]));
  const reviewed = new Map(UI_PATCHES.map(patch => ['assets/' + patch.file, patch]));
  const originalManifest = structuredClone(manifest);
  let found = 0;
  for (const entry of originalManifest.assets) {
    const patch = reviewed.get(entry.path);
    if (!patch) continue;
    const output = patchedAssets.get(entry.path);
    const accepted = [[patch.sha256, patch.size], [sha256(output), output.length]];
    if (LEGACY_OUTPUTS[patch.file]) accepted.push([LEGACY_OUTPUTS[patch.file].sha256, LEGACY_OUTPUTS[patch.file].size]);
    if (!accepted.some(([hash, size]) => entry.sha256 === hash && entry.size === size)) {
      throw new Error(`Refuse channels UI patch: manifest entry drift for ${entry.path}`);
    }
    entry.sha256 = patch.sha256;
    entry.size = patch.size;
    found++;
  }
  originalManifest.generation = manifestGeneration(originalManifest.assets);
  if (found !== UI_PATCHES.length || sha256(JSON.stringify(originalManifest)) !== 'd61717fe6ab57d7fd2b567c54b5fbf64527fcb1dce0abc3a7da1546eb4647784') {
    throw new Error('Refuse channels UI patch: unreviewed asset manifest');
  }
  for (const entry of manifest.assets) if (patchedAssets.has(entry.path)) {
    const output = patchedAssets.get(entry.path);
    entry.sha256 = sha256(output);
    entry.size = output.length;
  }
  manifest.generation = manifestGeneration(manifest.assets);
  writes.push({ file: manifestFile, before: rawManifest, after: Buffer.from(JSON.stringify(manifest) + '\n') });

  const workerFile = resolve(ui, 'sw.js');
  const worker = readFileSync(workerFile, 'utf8');
  let baseline = worker;
  let patchedWorker = worker;
  for (const patch of UI_PATCHES) {
    const oldHash = Buffer.from(patch.sha256, 'hex').toString('base64');
    const newHash = Buffer.from(EXPECTED_OUTPUT_SHA256[patch.file], 'hex').toString('base64');
    const prefix = `"path":"assets/${patch.file}","integrity":"sha256-`;
    baseline = baseline.replace(prefix + newHash, prefix + oldHash);
    const legacy = LEGACY_OUTPUTS[patch.file];
    if (legacy) {
      const legacyHash = Buffer.from(legacy.sha256, 'hex').toString('base64');
      baseline = baseline.replace(prefix + legacyHash, prefix + oldHash);
      patchedWorker = patchedWorker.replace(prefix + legacyHash, prefix + newHash);
    }
    patchedWorker = patchedWorker.replace(prefix + oldHash, prefix + newHash);
  }
  const build = '2026.10.2-release-b8952d477f0c-2026-10-11T22-38-10.004Z';
  const originalVersion = `const EMBEDDED_CACHE_VERSION = "${build}";`;
  const legacyVersion = `const EMBEDDED_CACHE_VERSION = "${build}-uclaw-channels-v1";`;
  const previousVersion = `const EMBEDDED_CACHE_VERSION = "${build}-uclaw-single-model-v2";`;
  const nextVersion = `const EMBEDDED_CACHE_VERSION = "${build}-uclaw-single-model-v3";`;
  baseline = baseline.replace(nextVersion, originalVersion);
  baseline = baseline.replace(legacyVersion, originalVersion);
  baseline = baseline.replace(previousVersion, originalVersion);
  patchedWorker = patchedWorker.replace(originalVersion, nextVersion);
  patchedWorker = patchedWorker.replace(legacyVersion, nextVersion);
  patchedWorker = patchedWorker.replace(previousVersion, nextVersion);
  if (sha256(baseline) !== '76173fe8dbb2c5e65ef122c04d9d3c522c865105839d8ad1a659c135741ff08e') {
    throw new Error('Refuse channels UI patch: unreviewed service worker');
  }
  writes.push({ file: workerFile, before: Buffer.from(worker), after: Buffer.from(patchedWorker) });
  for (const [suffix, decode, encode] of [['.gz', gunzipSync, gzipSync], ['.br', brotliDecompressSync, brotliCompressSync]]) {
    if (!existsSync(workerFile + suffix)) continue;
    const before = readFileSync(workerFile + suffix);
    const decoded = decode(before, { maxOutputLength: 1048576 }).toString('utf8');
    if (decoded !== worker && decoded !== patchedWorker) throw new Error('Refuse channels UI patch: compressed service worker drift');
    writes.push({ file: workerFile + suffix, before, after: encode(Buffer.from(patchedWorker)) });
  }
}
function atomicWrite(file, value) {
  const temp = file + '.uclaw-ui-tmp';
  try { writeFileSync(temp, value); renameSync(temp, file); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function patchControlUiChannels(coreDir) {
  const version = JSON.parse(readFileSync(resolve(coreDir, 'node_modules/openclaw/package.json'), 'utf8')).version;
  if (version !== EXPECTED_VERSION) throw new Error(`Refuse channels UI patch: expected OpenClaw ${EXPECTED_VERSION}, got ${version}`);
  const assets = resolve(coreDir, 'node_modules/openclaw/dist/control-ui/assets');
  const writes = [];
  for (const patch of UI_PATCHES) {
    const file = resolve(assets, patch.file);
    const source = readFileSync(file, 'utf8');
    let replacements = patch.replacements;
    // Pin each reviewed migration state; removed objects have no reverse anchor.
    if (sha256(source) !== patch.sha256) {
      const expectedOutput = EXPECTED_OUTPUT_SHA256[patch.file];
      if (sha256(source) === expectedOutput) replacements = [];
      else if (sha256(source) === LEGACY_OUTPUTS[patch.file]?.sha256) replacements = replacements.slice(LEGACY_OUTPUTS[patch.file].skip ?? 1);
      else throw new Error(`Refuse channels UI patch: unexpected input SHA-256 for ${file}`);
    }
    let patched = source;
    for (const [before, after] of replacements) {
      if (patched.split(before).length - 1 !== 1) throw new Error(`Refuse channels UI patch: expected one anchor for ${patch.file}`);
      patched = patched.replace(before, after);
    }
    if (sha256(patched) !== EXPECTED_OUTPUT_SHA256[patch.file]) throw new Error(`Refuse channels UI patch: unreviewed output SHA-256 for ${file}`);
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8', timeout: 10000 });
    if (syntax.status !== 0) throw new Error(`Refuse channels UI patch: syntax check failed for ${patch.file}: ${syntax.stderr}`);
    writes.push({ file, before: Buffer.from(source), after: Buffer.from(patched) });
    for (const [suffix, decode, encode] of [['.gz', gunzipSync, gzipSync], ['.br', brotliDecompressSync, brotliCompressSync]]) {
      if (!existsSync(file + suffix)) continue;
      const before = readFileSync(file + suffix);
      const content = decode(before, { maxOutputLength: Math.max(source.length * 4, 1048576) }).toString('utf8');
      if (content !== source && content !== patched) throw new Error(`Refuse channels UI patch: compressed asset drift for ${patch.file}${suffix}`);
      writes.push({ file: file + suffix, before, after: encode(Buffer.from(patched)) });
    }
  }
  addIntegrityMetadataWrites(coreDir, writes);
  const applied = [];
  try {
    for (const write of writes) { atomicWrite(write.file, write.after); applied.push(write); }
  } catch (error) {
    for (const write of applied.reverse()) atomicWrite(write.file, write.before);
    throw error;
  }
  return { ok: true, version, files: writes.length };
}

const EXPECTED_OUTPUT_SHA256 = {
  'control-ui-core-D6S2prEk.js': '64bf7049f3b9174bfb215958038856c0d16501f890d3731b19fa1514b7fc5108',
  'control-ui-core-CExunQhD.js': 'ccdbc8fba3795c7827d36795fb0940a384e439179c29f04e2cf556535ab6b1fa',
  'settings-targets-B7TZ3ZqH.js': '27f8c2dd3656cccd212ec8b2f11a21a971c2685bf7305c15fba69cc33ff6f144',
  'custodian-surface-Cug5fuzZ.js': '4a1cff964f5a5d6f6d404b99cb2ee086446ff2bda3e49a0835fc5337ba630489',
  'control-ui-boot-shared-5tr2Rgvy.js': '1d2e80b92ccb20c7b482f27df8823e5d032e2bea01170d60d881a9123e8e879e',
  'control-ui-boot-chat-IjjYAD6-.js': '46f66678701310ad9b79e38ef61bdc1f179d8d0668e400d3ed88ce30483e8d26',
  'control-ui-boot-new-DX1IjXFt.js': '7141f5b653a328cdf072b7c82a45154790632bc68d0139c58dbad436d59d1a92',
};
const LEGACY_OUTPUTS = {
  'control-ui-core-D6S2prEk.js': { sha256: 'cc82447e5cfd5b24baafe29fc222707f5398ab0c4e6188fac1b7eec2d6ba7a8f', size: 425562 },
  'settings-targets-B7TZ3ZqH.js': { sha256: 'e10adf7741db63e04521b38fdecd3d59f723bc17946e293c826c4e7949defd73', size: 12064 },
  'control-ui-boot-chat-IjjYAD6-.js': { sha256: '3964b49668a6208c73d7350f0e89ab8a39393ecca518f313f58750b0d4935161', size: 429221, skip: 3 },
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = patchControlUiChannels(resolve(process.argv[2] || process.cwd()));
  process.stdout.write(`patched channel UI entry points: ${JSON.stringify(result)}\n`);
}
