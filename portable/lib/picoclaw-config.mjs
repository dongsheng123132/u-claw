// Frozen PicoClaw v0.3.1: .security.yml has a model_list mapping of alias:index
// entries containing api_keys block sequences. Only the wallet alias belongs to us.
// Parse the whole conservative YAML subset before writing; splice only owned lines,
// preserving unrelated blocks verbatim. Unsupported/ambiguous YAML fails closed.
import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PICO_MODEL_ALIAS = 'xiapan-v4-flash:0';
export const PICO_MODEL_NAME = 'xiapan-v4-flash';
export const PICO_PROVIDER = 'deepseek';
export const PICO_MODEL = 'deepseek-v4-flash';
export const PICO_API_BASE = 'https://api.u-claw.org.cn/v1';
export const PICO_CONFIG_VERSION = 3;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
function invalid() {
  // Never include raw YAML, which can contain credentials, in diagnostics.
  throw new Error('PicoClaw .security.yml is unsupported or ambiguous; not modifying it (fail-closed).');
}

function scalar(s) {
  if (s.startsWith('"')) {
    try { const v = JSON.parse(s); if (typeof v !== 'string') invalid(); return v; } catch { invalid(); }
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) invalid();
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === '{}') return {};
  if (s === '[]') return [];
  // Accept only JSON string arrays as a precisely defined flow subset.
  if (s.startsWith('[')) {
    try { const v = JSON.parse(s); if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) invalid(); return v; } catch { invalid(); }
  }
  if (!s || /^[&*!>|%?@`{\]},]/.test(s) || /:\s|:$|(^|\s)#/.test(s)) invalid();
  if (s === 'null' || s === '~') return null;
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function separator(s) {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"' && c === '\\') { i++; continue; }
    if (quote === "'" && c === "'" && s[i + 1] === "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}
function parseDocument(raw) {
  const lines = raw.split(/\r?\n/);
  const tokens = [];
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    if (/\t|\r/.test(text)) invalid();
    if (!text.trim() || /^\s*#/.test(text)) continue;
    if (/^\s*(?:---|\.\.\.)/.test(text)) invalid();
    tokens.push({ line, indent: text.length - text.trimStart().length, text: text.trim() });
  }
  let i = 0;
  function node(indent) {
    const start = tokens[i]?.line ?? lines.length;
    const entries = new Map();
    if (!tokens[i]) return { value: {}, entries, start, end: start };
    const sequence = tokens[i].text.startsWith('- ');
    const value = sequence ? [] : {};
    while (i < tokens.length && tokens[i].indent >= indent) {
      const t = tokens[i];
      if (t.indent !== indent) invalid();
      if (sequence) {
        if (!t.text.startsWith('- ')) invalid();
        value.push(scalar(t.text.slice(2).trim())); i++; continue;
      }
      if (t.text === '{}') {
        if (entries.size) invalid();
        i++; break;
      }
      const sep = separator(t.text);
      if (sep < 0) invalid();
      const keyText = t.text.slice(0, sep);
      const key = scalar(keyText);
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype', '<<'].includes(key) || entries.has(key)) invalid();
      const rest = t.text.slice(sep + 1).trim();
      i++;
      let child;
      if (!rest && tokens[i] && tokens[i].indent > indent) child = node(tokens[i].indent);
      else child = { value: rest ? scalar(rest) : null, entries: new Map(), start: t.line, end: t.line + 1 };
      value[key] = child.value;
      // end includes data lines, not following comments or blank lines.
      const end = i > 0 ? tokens[i - 1].line + 1 : t.line + 1;
      entries.set(key, { ...child, start: t.line, end, indent });
    }
    return { value, entries, start, end: tokens[i - 1]?.line + 1 || start };
  }
  if (tokens.length && tokens[0].indent !== 0) invalid();
  const root = node(0);
  if (i !== tokens.length || !object(root.value)) invalid();
  return { ...root, lines };
}
export function parseYamlSubset(raw) { return parseDocument(raw).value; }
export function serializeYamlSubset(doc) {
  if (!object(doc)) invalid();
  const lines = [];
  function write(obj, indent) {
    for (const [k, v] of Object.entries(obj)) {
      const key = /^[a-zA-Z_][a-zA-Z0-9_:-]*$/.test(k) ? k : JSON.stringify(k);
      const p = ' '.repeat(indent) + key + ':';
      if (Array.isArray(v)) {
        if (!v.every(x => typeof x === 'string')) invalid();
        lines.push(v.length ? p : p + ' []');
        for (const x of v) lines.push(' '.repeat(indent + 2) + '- ' + JSON.stringify(x));
      } else if (object(v) && Object.keys(v).length) { lines.push(p); write(v, indent + 2); }
      else lines.push(p + ' ' + JSON.stringify(v));
    }
  }
  write(doc, 0);
  return lines.length ? lines.join('\n') + '\n' : '{}\n';
}
function security(picoHome) {
  const file = join(picoHome, '.security.yml');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = parseDocument(raw);
  const models = doc.entries.get('model_list');
  if (models && !object(models.value)) invalid();
  // A malformed wallet entry must never be mistaken for an absent key.
  for (const entry of [models?.entries.get(PICO_MODEL_ALIAS), doc.entries.get(PICO_MODEL_ALIAS)]) {
    if (entry && !object(entry.value)) invalid();
  }
  if (models?.entries.has(PICO_MODEL_ALIAS) && doc.entries.has(PICO_MODEL_ALIAS)) invalid();
  return { ...doc, raw, models, file };
}
// Legacy output from earlier releases placed model aliases at the document root.
// On the next wallet write, move such user blocks under model_list once.
function normalizeRootAliases(raw) {
  const doc = parseDocument(raw);
  const legacy = [...doc.entries.keys()].filter(k => k !== 'model_list' && k !== 'version' && /^[A-Za-z0-9_-]+:\d+$/.test(k));
  if (!legacy.length) return raw;
  const models = object(doc.value.model_list) ? doc.value.model_list : {};
  const moved = {};
  for (const key of legacy) {
    if (Object.prototype.hasOwnProperty.call(models, key)) invalid();
    moved[key] = doc.value[key];
  }
  // Rebuild this one legacy file into the real schema (all aliases under model_list).
  // Other root fields are kept. Normal files never take this migration path.
  const value = { ...doc.value, model_list: { ...models, ...moved } };
  for (const key of legacy) delete value[key];
  return serializeYamlSubset(value);
}

function changedSecurity(doc, apiKey) {
  const operations = [];
  const oldRoot = doc.entries.get(PICO_MODEL_ALIAS);
  if (oldRoot) operations.push({ start: oldRoot.start, end: oldRoot.end, lines: [] });
  const entry = doc.models?.entries.get(PICO_MODEL_ALIAS);
  if (apiKey === undefined) {
    if (entry) operations.push({ start: entry.start, end: entry.end, lines: [] });
    // Empty model_list needs an explicit empty map after removing its last entry.
    if (entry && doc.models.entries.size === 1) {
      operations.pop();
      operations.push({ start: doc.models.start, end: doc.models.end, lines: ['model_list: {}'] });
    }
  } else {
    const indent = entry?.indent ?? (doc.models?.entries.values().next().value?.indent ?? 2);
    const p = ' '.repeat(indent);
    const block = [`${p}${PICO_MODEL_ALIAS}:`, `${p}  api_keys:`, `${p}    - ${JSON.stringify(apiKey)}`];
    if (entry) operations.push({ start: entry.start, end: entry.end, lines: block });
    else if (doc.models && doc.models.entries.size) operations.push({ start: doc.models.end, end: doc.models.end, lines: block });
    else if (doc.models) operations.push({ start: doc.models.start, end: doc.models.end, lines: ['model_list:', ...block] });
    else operations.push({ start: doc.lines.length, end: doc.lines.length, lines: ['model_list:', ...block] });
  }
  const lines = [...doc.lines];
  // Empty document / {} root is replaced only when creating its first entry.
  if (!doc.entries.size && apiKey !== undefined) return serializeYamlSubset({ model_list: { [PICO_MODEL_ALIAS]: { api_keys: [apiKey] } } });
  operations.sort((a, b) => b.start - a.start);
  for (const op of operations) lines.splice(op.start, op.end - op.start, ...op.lines);
  const output = lines.join(doc.raw.includes('\r\n') ? '\r\n' : '\n');
  return output.endsWith('\n') ? output : output + '\n';
}
function atomic(file, content) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try { fs.writeFileSync(tmp, content, 'utf8'); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
export function readPicoclawWalletKey({ picoHome } = {}) {
  if (!picoHome) return '';
  const doc = security(picoHome);
  const keys = doc.models?.value[PICO_MODEL_ALIAS]?.api_keys;
  return Array.isArray(keys) && keys.every(k => typeof k === 'string') && keys.length === 1 && keys[0].trim() ? keys[0] : '';
}
export function hasPicoclawWalletKey(opts = {}) { return readPicoclawWalletKey(opts) !== ''; }
export function writePicoclawWalletConfig({ picoHome, apiKey, apiBase = PICO_API_BASE } = {}) {
  if (!picoHome || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('picoHome and apiKey are required');
  // Validate and prepare security before touching config.json.
  const doc = security(picoHome);
  const newSec = normalizeRootAliases(changedSecurity(doc, apiKey));
  parseDocument(newSec);
  const configPath = join(picoHome, 'config.json');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { throw new Error('PicoClaw config.json is corrupt (fail-closed).'); }
  }
  if (!object(cfg) || (cfg.model_list !== undefined && !Array.isArray(cfg.model_list))) throw new Error('PicoClaw config.json is corrupt (fail-closed).');
  cfg.version = PICO_CONFIG_VERSION;
  cfg.model_list ??= [];
  const matches = cfg.model_list.filter(m => m?.model_name === PICO_MODEL_NAME);
  if (matches.length > 1) throw new Error('PicoClaw wallet model is ambiguous (fail-closed).');
  const entry = matches[0] || { model_name: PICO_MODEL_NAME };
  if (!matches.length) cfg.model_list.push(entry);
  delete entry.api_key; delete entry.api_keys;
  Object.assign(entry, { provider: PICO_PROVIDER, model: PICO_MODEL, api_base: apiBase, enabled: true });
  if (JSON.stringify(entry).includes(apiKey)) throw new Error('PicoClaw config.json would contain the key; refusing to write (fail-closed).');
  cfg.agents = object(cfg.agents) ? cfg.agents : {};
  cfg.agents.defaults = object(cfg.agents.defaults) ? cfg.agents.defaults : {};
  cfg.agents.defaults.model_name = PICO_MODEL_NAME;
  atomic(configPath, JSON.stringify(cfg, null, 2));
  atomic(doc.file, newSec);
  return { configPath, secPath: doc.file };
}
export function removePicoclawWalletKey({ picoHome } = {}) {
  if (!picoHome) throw new Error('picoHome is required');
  const doc = security(picoHome);
  if (!doc.entries.has(PICO_MODEL_ALIAS) && !doc.models?.entries.has(PICO_MODEL_ALIAS)) return { removed: false };
  const output = changedSecurity(doc);
  parseDocument(output);
  atomic(doc.file, output);
  return { removed: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'has-key') process.exitCode = 2;
  else {
    let present = false;
    try { present = hasPicoclawWalletKey({ picoHome: process.argv[3] }); }
    catch { console.error('PicoClaw wallet configuration cannot be read. Enable the wallet in Config Center.'); }
    console.log(`UCLAW_PICO_WALLET_KEY=${present ? 1 : 0}`);
  }
}
