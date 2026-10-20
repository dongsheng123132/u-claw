#!/usr/bin/env node
// Keep OpenClaw's external-provider auto-installer off portable media. The
// on-disk wrapper is deliberately fail-open; the transform is reused by
// config-server so one config save produces one gateway hot-reload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PROVIDER_ENV_VARS } from './strip-provider-env.mjs';

// 2026.8.1 official-external-provider-catalog.json snapshot. Keep this
// literal: startup must not depend on OpenClaw being installed or readable.
// 2026.9.1 起 catalog 改结构（providers 下沉到 openclaw.providers），
// 守卫用 readCatalogProviders() 做新旧双格式兼容，见该函数。
export const OFFICIAL_PROVIDER_SNAPSHOT = Object.freeze([
  ['amazon-bedrock', '@openclaw/amazon-bedrock-provider'],
  ['amazon-bedrock-mantle', '@openclaw/amazon-bedrock-mantle-provider'],
  ['anthropic-vertex', '@openclaw/anthropic-vertex-provider'],
  ['arcee', '@openclaw/arcee-provider'],
  ['bailian-token-plan', '@openclaw/qwen-provider'],
  ['baseten', '@openclaw/baseten-provider'],
  ['byteplus', '@openclaw/byteplus-provider'],
  ['cerebras', '@openclaw/cerebras-provider'],
  ['chutes', '@openclaw/chutes-provider'],
  ['cloudflare-ai-gateway', '@openclaw/cloudflare-ai-gateway-provider'],
  ['cohere', '@openclaw/cohere-provider'],
  ['comfy', '@openclaw/comfy-provider'],
  ['deepinfra', '@openclaw/deepinfra-provider'],
  ['deepseek', '@openclaw/deepseek-provider'],
  ['featherless', '@openclaw/featherless-provider'],
  ['fireworks', '@openclaw/fireworks-provider'],
  ['gmi', '@openclaw/gmi-provider'],
  ['groq', '@openclaw/groq-provider'],
  ['kilocode', '@openclaw/kilocode-provider'],
  ['kimi', '@openclaw/kimi-provider'],
  ['longcat', '@openclaw/longcat-provider'],
  ['meta', '@openclaw/meta-provider'],
  ['mistral', '@openclaw/mistral-provider'],
  ['moonshot', '@openclaw/moonshot-provider'],
  ['novita', '@openclaw/novita-provider'],
  ['opencode', '@openclaw/opencode-provider'],
  ['opencode-go', '@openclaw/opencode-go-provider'],
  ['pixverse', '@openclaw/pixverse-provider'],
  ['qianfan', '@openclaw/qianfan-provider'],
  ['qwen', '@openclaw/qwen-provider'],
  ['qwen-token-plan', '@openclaw/qwen-provider'],
  ['stepfun', '@openclaw/stepfun-provider'],
  ['stepfun-plan', '@openclaw/stepfun-provider'],
  ['synthetic', '@openclaw/synthetic-provider'],
  ['tencent-tokenhub', '@openclaw/tencent-provider'],
  ['tencent-tokenplan', '@openclaw/tencent-provider'],
  ['venice', '@openclaw/venice-provider'],
  ['vercel-ai-gateway', '@openclaw/vercel-ai-gateway-provider'],
  ['volcengine', '@openclaw/volcengine-provider'],
  ['volcengine-plan', '@openclaw/volcengine-provider'],
  ['voyage', '@openclaw/voyage-provider'],
  ['vydra', '@openclaw/vydra-provider'],
  ['xiaomi', '@openclaw/xiaomi-provider'],
  ['xiaomi-token-plan', '@openclaw/xiaomi-provider'],
  ['zai', '@openclaw/zai-provider'],
]);

const CORE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'core');
const DEFAULT_CATALOG_PATH = path.join(CORE_DIR, 'node_modules', 'openclaw', 'scripts', 'lib', 'official-external-provider-catalog.json');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readCatalogProviders(catalogPath) {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const providers = new Map();
    for (const entry of catalog.entries || []) {
      if (entry?.kind && entry.kind !== 'provider') continue;
      const openclaw = entry?.openclaw || {};
      const npmSpec = openclaw?.install?.npmSpec || entry?.name || '';
      for (const provider of openclaw?.providers || []) {
        if (provider?.kind && provider.kind !== 'provider') continue;
        if (typeof provider?.id === 'string' && provider.id && !providers.has(provider.id)) providers.set(provider.id, npmSpec);
      }
    }
    return providers;
  } catch {
    return new Map();
  }
}

function officialProviders(options = {}) {
  const snapshot = options.snapshot === undefined ? OFFICIAL_PROVIDER_SNAPSHOT : options.snapshot;
  const providers = new Map((Array.isArray(snapshot) ? snapshot : []).map(([id, spec]) => [id, spec || '']));
  if (options.catalogPath !== false) {
    for (const [id, spec] of readCatalogProviders(options.catalogPath || DEFAULT_CATALOG_PATH)) providers.set(id, spec);
  }
  return providers;
}

function timestampForBackup(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, '0')).join('');
}

function writeAtomic(configPath, content) {
  const dir = path.dirname(configPath);
  const tempPath = path.join(dir, `.${path.basename(configPath)}.provider-guard-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, configPath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
    throw err;
  }
}

function appendLog(configPath, message) {
  const logPath = path.resolve(path.dirname(configPath), '..', 'logs', 'provider-guard.log');
  if (!fs.existsSync(path.dirname(logPath))) return;
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

function pluginInstalled(npmSpec, coreDir) {
  if (!npmSpec) return false;
  const isScoped = npmSpec.startsWith('@');
  const at = npmSpec.lastIndexOf('@');
  const packageDir = at > (isScoped ? 0 : -1) && at > 0 ? npmSpec.slice(0, at) : npmSpec;
  if (!packageDir) return false;
  try {
    return fs.existsSync(path.join(coreDir, 'node_modules', packageDir, 'package.json'));
  } catch {
    return false;
  }
}

export function ensureGatewayOnConfig(config) {
  const defaultGateway = { mode: 'local', auth: { mode: 'token', token: 'uclaw' } };
  if (!isPlainObject(config.gateway)) {
    config.gateway = defaultGateway;
    return true;
  }
  if (!isPlainObject(config.gateway.auth)) {
    config.gateway.auth = { ...defaultGateway.auth };
    return true;
  }
  const auth = config.gateway.auth;
  if ((!auth.mode || auth.mode === 'token') && (typeof auth.token !== 'string' || auth.token === '')) {
    auth.token = defaultGateway.auth.token;
    return true;
  }
  return false;
}

function ensureProviderObject(config) {
  if (!isPlainObject(config.models)) config.models = {};
  if (!isPlainObject(config.models.providers)) config.models.providers = {};
  return config.models.providers;
}

function replaceModelRef(value, oldId, newId) {
  return typeof value === 'string' && value.startsWith(`${oldId}/`)
    ? `${newId}/${value.slice(oldId.length + 1)}` : value;
}

function replaceModelKeys(models, oldId, newId, actions) {
  if (!isPlainObject(models)) return false;
  let changed = false;
  for (const key of Object.keys(models)) {
    const replacement = replaceModelRef(key, oldId, newId);
    if (replacement === key) continue;
    // Never overwrite a separately configured model alias.  Keeping the old
    // key is safer than silently discarding the user's definition.
    if (has(models, replacement)) {
      actions?.push(`model key conflict kept: ${key}`);
      continue;
    }
    models[replacement] = models[key];
    delete models[key];
    changed = true;
  }
  return changed;
}

/** Rewrite all supported config references from an official provider ID. */
export function replaceAllModelRefs(config, oldId, newId, actions) {
  let changed = false;
  const defaults = config.agents?.defaults;
  const defaultModel = defaults?.model;
  if (isPlainObject(defaultModel)) {
    for (const key of ['primary']) {
      const replacement = replaceModelRef(defaultModel[key], oldId, newId);
      if (replacement !== defaultModel[key]) { defaultModel[key] = replacement; changed = true; }
    }
    if (Array.isArray(defaultModel.fallbacks)) defaultModel.fallbacks = defaultModel.fallbacks.map((value) => {
      const replacement = replaceModelRef(value, oldId, newId);
      if (replacement !== value) changed = true;
      return replacement;
    });
  }
  if (replaceModelKeys(defaults?.models, oldId, newId, actions)) changed = true;
  const entries = config.agents?.entries;
  if (isPlainObject(entries)) for (const entry of Object.values(entries)) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.model === 'string') {
      const replacement = replaceModelRef(entry.model, oldId, newId);
      if (replacement !== entry.model) { entry.model = replacement; changed = true; }
    } else if (isPlainObject(entry.model)) {
      const replacement = replaceModelRef(entry.model.primary, oldId, newId);
      if (replacement !== entry.model.primary) { entry.model.primary = replacement; changed = true; }
      if (Array.isArray(entry.model.fallbacks)) entry.model.fallbacks = entry.model.fallbacks.map((value) => {
        const replacementValue = replaceModelRef(value, oldId, newId);
        if (replacementValue !== value) changed = true;
        return replacementValue;
      });
    }
    if (Array.isArray(entry.fallbacks)) entry.fallbacks = entry.fallbacks.map((value) => {
      const replacement = replaceModelRef(value, oldId, newId);
      if (replacement !== value) changed = true;
      return replacement;
    });
    if (replaceModelKeys(entry.models, oldId, newId, actions)) changed = true;
  }
  return changed;
}

function zaiProvider(apiKey) {
  return {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    apiKey,
    models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 204800, maxTokens: 16384 }],
  };
}

function readQuarantine(quarantinePath) {
  if (!quarantinePath) return { quarantine: null, recovered: false };
  try {
    const current = JSON.parse(fs.readFileSync(quarantinePath, 'utf8'));
    return { quarantine: isPlainObject(current) ? current : {}, recovered: false };
  } catch (err) {
    // A broken sidecar is rebuilt when possible, but it is not a trustworthy
    // transaction destination for this run: retain source credentials.
    return err?.code === 'ENOENT'
      ? { quarantine: {}, recovered: false }
      : { quarantine: {}, recovered: true };
  }
}

function writeQuarantine(quarantinePath, additions) {
  if (!quarantinePath || (!Object.keys(additions.env).length && !Object.keys(additions.providers).length)) return { safeToRemove: true, wrote: false };
  try {
    const { quarantine, recovered } = readQuarantine(quarantinePath);
    if (!isPlainObject(quarantine.env)) quarantine.env = {};
    if (!isPlainObject(quarantine.providers)) quarantine.providers = {};
    Object.assign(quarantine.env, additions.env);
    Object.assign(quarantine.providers, additions.providers);
    quarantine.quarantinedAt = new Date().toISOString();
    writeAtomic(quarantinePath, JSON.stringify(quarantine, null, 2));
    return { safeToRemove: !recovered, wrote: true };
  } catch (err) {
    try { appendLog(quarantinePath, `quarantine write failed: ${err?.message || 'unknown'}`); } catch { /* diagnostic only */ }
    return { safeToRemove: false, wrote: false };
  }
}

function legacyQuarantine(config, additions) {
  if (!isPlainObject(config.meta) || !has(config.meta, 'uclawQuarantinedEnv')) return null;
  if (isPlainObject(config.meta.uclawQuarantinedEnv)) Object.assign(additions.env, config.meta.uclawQuarantinedEnv);
  return config.meta;
}

function addZaiProvider(config, value, actions) {
  const providers = ensureProviderObject(config);
  if (!has(providers, 'zai-api')) {
    providers['zai-api'] = zaiProvider(value);
    actions.push('created zai-api provider from zai env');
  }
  if (replaceAllModelRefs(config, 'zai', 'zai-api', actions)) actions.push('model refs zai/ -> zai-api/');
}

function collectOfficialEnv(config, additions) {
  const sources = [];
  if (isPlainObject(config.env)) {
    sources.push(config.env);
    if (isPlainObject(config.env.vars)) sources.push(config.env.vars);
  }
  let zaiValue;
  let foundZai = false;
  for (const source of sources) {
    for (const name of OFFICIAL_PROVIDER_ENV_VARS) {
      if (!has(source, name)) continue;
      const value = source[name];
      if (name === 'ZAI_API_KEY' || name === 'Z_AI_API_KEY') {
        if (!foundZai) zaiValue = value;
        foundZai = true;
        continue;
      }
      additions.env[name] = value;
    }
  }
  const removals = [];
  for (const source of sources) for (const name of OFFICIAL_PROVIDER_ENV_VARS) {
    if (has(source, name)) removals.push({ source, name });
  }
  return { removals, zaiValue, foundZai };
}

function applyOfficialEnv(plan, config, actions) {
  for (const { source, name } of plan.removals) {
    delete source[name];
    if (name !== 'ZAI_API_KEY' && name !== 'Z_AI_API_KEY') actions.push(`quarantined official env ${name}`);
  }
  if (plan.foundZai) {
    addZaiProvider(config, plan.zaiValue, actions);
    actions.push('zai env -> zai-api provider');
  }
  return plan.removals.length > 0;
}

function dotenvValue(rawValue) {
  let value = rawValue.trim();
  if ((value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    const close = value.indexOf(quote, 1);
    if (close > 0 && /^\s*(?:#.*)?$/.test(value.slice(close + 1))) return value.slice(1, close).trim();
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function collectStateEnv(stateDir, additions) {
  if (!stateDir) return false;
  const envPath = path.join(stateDir, '.env');
  let original;
  try {
    if (!fs.existsSync(envPath)) return false;
    original = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return false;
  }
  const parsed = [];
  for (const line of original.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) { parsed.push({ line }); continue; }
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match) return false;
    parsed.push({ line, name: match[2], value: dotenvValue(match[4]) });
  }
  const names = new Set(OFFICIAL_PROVIDER_ENV_VARS);
  const removed = parsed.filter((item) => item.name && names.has(item.name));
  if (!removed.length) return null;
  const nonZai = removed.filter((item) => item.name !== 'ZAI_API_KEY' && item.name !== 'Z_AI_API_KEY');
  let zaiValue;
  for (const item of removed) {
    if (item.name === 'ZAI_API_KEY' || item.name === 'Z_AI_API_KEY') {
      if (zaiValue === undefined) zaiValue = item.value;
      continue;
    }
    additions.env[item.name] = item.value;
  }
  return { envPath, original, parsed, names, removed, nonZai, zaiValue };
}

function applyStateEnv(plan, config, actions) {
  try {
    // Back up whenever *any* official line is removed, including ZAI-only.
    fs.copyFileSync(plan.envPath, `${plan.envPath}.provider-guard-bak-${timestampForBackup()}`);
    writeAtomic(plan.envPath, plan.parsed.filter((item) => !item.name || !plan.names.has(item.name)).map((item) => item.line).join('\n'));
  } catch (err) {
    try { appendLog(path.join(path.dirname(plan.envPath), 'openclaw.json'), `.env guard failed: ${err?.message || 'unknown'}`); } catch { /* diagnostic only */ }
    return false;
  }
  for (const item of plan.nonZai) actions.push(`quarantined official .env ${item.name}`);
  if (plan.zaiValue !== undefined) {
    addZaiProvider(config, plan.zaiValue, actions);
    actions.push('zai .env -> zai-api provider; re-save in Config to encrypt');
  }
  return true;
}

/** Transform config and, when requested, its explicit sidecar/.env transaction. */
export function guardOfficialProvidersInMemory(config, options = {}) {
  const result = { changed: false, actions: [], config };
  try {
    if (!isPlainObject(config)) return result;
    const official = officialProviders(options);
    // If neither the shipped snapshot nor a runtime catalog is available, the
    // guard has no authoritative T1 source. Preserve the old fail-open contract
    // and leave the file entirely untouched.
    if (!official.size) return result;
    const additions = { env: {}, providers: {} };
    const legacyMeta = legacyQuarantine(config, additions);
    const providers = isPlainObject(config.models?.providers) ? config.models.providers : null;
    const coreDir = options.coreDir || CORE_DIR;
    const conflictRemovals = [];
    if (providers) {
      for (const [id, npmSpec] of official) {
        if (!has(providers, id)) continue;
        if (pluginInstalled(npmSpec, coreDir)) continue;
        const target = `${id}-api`;
        if (has(providers, target)) {
          additions.providers[id] = providers[id];
          if (options.quarantinePath) {
            conflictRemovals.push({ id, target });
          } else {
            delete additions.providers[id];
            result.actions.push(`conflict kept: pass quarantinePath to remove (${id})`);
          }
          continue;
        }
        const entry = providers[id];
        const renamable = isPlainObject(entry) && typeof entry.baseUrl === 'string' && entry.baseUrl && typeof entry.api === 'string' && entry.api;
        if (!renamable) {
          result.actions.push(`skip ${id}: missing baseUrl/api`);
          continue;
        }
        providers[target] = entry;
        delete providers[id];
        result.changed = true;
        result.actions.push(`renamed ${id}→${target}`);
        if (replaceAllModelRefs(config, id, target, result.actions)) result.actions.push(`model refs ${id}/ -> ${target}/`);
      }
    }
    const envPlan = collectOfficialEnv(config, additions);
    const statePlan = collectStateEnv(options.stateDir, additions);

    if (options.quarantinePath) {
      const sidecar = writeQuarantine(options.quarantinePath, additions);
      if (sidecar.safeToRemove) {
        for (const { id, target } of conflictRemovals) {
          delete providers[id];
          result.changed = true;
          result.actions.push(`quarantined official provider ${id} (conflict)`);
          if (replaceAllModelRefs(config, id, target, result.actions)) result.actions.push(`model refs ${id}/ -> ${target}/`);
        }
        if (legacyMeta) {
          delete legacyMeta.uclawQuarantinedEnv;
          result.changed = true;
        }
        if (applyOfficialEnv(envPlan, config, result.actions)) result.changed = true;
        if (statePlan && applyStateEnv(statePlan, config, result.actions)) result.changed = true;
      } else if (conflictRemovals.length || legacyMeta || envPlan.removals.length || statePlan) {
        result.actions.push('quarantine unavailable, kept official entries');
      }
    } else {
      // Without a sidecar, never delete a conflicting provider or legacy
      // quarantine data.  Config env removal remains T2 security-first.
      if (legacyMeta) result.actions.push('legacy quarantine kept: pass quarantinePath to remove');
      if (applyOfficialEnv(envPlan, config, result.actions)) result.changed = true;
      // A ZAI .env value has a safe in-config destination; non-ZAI lines need
      // a sidecar and are retained until one is supplied.
      if (statePlan?.zaiValue !== undefined) {
        const zaiOnlyPlan = { ...statePlan, names: new Set(['ZAI_API_KEY', 'Z_AI_API_KEY']), removed: statePlan.removed.filter((item) => item.name === 'ZAI_API_KEY' || item.name === 'Z_AI_API_KEY'), nonZai: [] };
        if (applyStateEnv(zaiOnlyPlan, config, result.actions)) result.changed = true;
      }
    }
    if (ensureGatewayOnConfig(config)) {
      result.changed = true;
      result.actions.push('gateway healed');
    }
  } catch {
    return { changed: false, actions: [], config };
  }
  return result;
}

/** Fail-open disk wrapper used by launchers. */
export function guardOfficialProviders(configPath, catalogPath = DEFAULT_CATALOG_PATH, options = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const stateDir = options.stateDir || path.dirname(configPath);
    const quarantinePath = options.quarantinePath || path.join(stateDir, 'uclaw-provider-guard-quarantine.json');
    const result = guardOfficialProvidersInMemory(config, { ...options, catalogPath, stateDir, quarantinePath });
    if (!result.changed) return result.actions;
    try { fs.copyFileSync(configPath, `${configPath}.provider-guard-bak-${timestampForBackup()}`); } catch { /* best effort */ }
    writeAtomic(configPath, JSON.stringify(result.config, null, 2));
    try { appendLog(configPath, result.actions.join('; ')); } catch { /* diagnostic only */ }
    return result.actions;
  } catch {
    return [];
  }
}

export function main(argv) {
  if (!argv[2]) return 2;
  guardOfficialProviders(argv[2], argv[3]);
  return 0;
}

const isMain = path.basename(process.argv[1] || '') === 'official-provider-guard.mjs';
if (isMain) process.exitCode = main(process.argv);
