import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const configUi = readFileSync(join(repoRoot, 'portable', 'config-server', 'public', 'index.html'), 'utf8');

// Issue #68: walletCopyFallback() used to ignore document.execCommand('copy')'s boolean
// result and always toast "copied". The wallet key is masked on the page (walletMask()),
// so when the copy silently fails the user must be handed the full text to copy by hand.
// These are behavioral tests: the real function source is extracted from index.html and
// run in a vm sandbox with a fake DOM, so they fail if the function is regressed.

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + '( not found in index.html');
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, 'opening brace of ' + name + ' not found');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail('closing brace of ' + name + ' not found in index.html');
}

const fnSource = extractFunction(configUi, 'walletCopyFallback');

// execCommandImpl(cmd) controls the outcome of document.execCommand in each test.
function runFallback(text, okMsg, execCommandImpl) {
  const attached = new Set();
  const created = [];
  const toasts = [];
  const prompts = [];
  const execCalls = [];

  const document = {
    createElement(tag) {
      const el = {
        tagName: String(tag).toUpperCase(),
        value: '',
        style: {},
        focus() {},
        select() {},
      };
      created.push(el);
      return el;
    },
    body: {
      appendChild(el) { attached.add(el); return el; },
      removeChild(el) {
        if (!attached.has(el)) throw new Error('removeChild: node is not attached');
        attached.delete(el);
        return el;
      },
    },
    execCommand(cmd) {
      execCalls.push(cmd);
      return execCommandImpl(cmd);
    },
  };

  const promptFn = (...args) => { prompts.push(args); return null; };
  const sandbox = {
    document,
    window: { prompt: promptFn },
    prompt: promptFn,
    showToast: (msg, isError) => { toasts.push({ msg, isError }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox, { filename: 'index.html#walletCopyFallback' });
  assert.equal(typeof sandbox.walletCopyFallback, 'function', 'walletCopyFallback must be defined');

  sandbox.walletCopyFallback(text, okMsg);
  return { attached, created, toasts, prompts, execCalls };
}

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789wxyz';
const OK_MSG = '密钥已复制，请妥善保存——它就是你的钱包';

test('walletCopyFallback: execCommand returns false -> no "copied" toast, manual-copy prompt with full text', () => {
  const r = runFallback(KEY, OK_MSG, () => false);

  assert.deepEqual(r.execCalls, ['copy'], "execCommand must be called once with 'copy'");
  assert.equal(r.created.length, 1, 'one temporary textarea is created');
  assert.equal(r.created[0].value, KEY, 'textarea holds the full text');

  assert.ok(
    r.toasts.every((t) => t.msg !== OK_MSG),
    'okMsg must never be shown when the copy did not happen',
  );
  assert.ok(
    r.toasts.some((t) => t.isError === true),
    'an error toast must be shown',
  );

  assert.equal(r.prompts.length, 1, 'window.prompt must be called exactly once');
  assert.equal(r.prompts[0][1], KEY, 'prompt default value must be the full, unmodified text');

  assert.equal(r.attached.size, 0, 'temporary textarea must be removed from body');
});

test('walletCopyFallback: execCommand returns true -> okMsg toast only, no prompt', () => {
  const r = runFallback(KEY, OK_MSG, () => true);

  assert.deepEqual(r.execCalls, ['copy'], "execCommand must be called once with 'copy'");
  assert.equal(r.toasts.length, 1, 'exactly one toast');
  assert.equal(r.toasts[0].msg, OK_MSG, 'the okMsg toast is shown');
  assert.ok(!r.toasts[0].isError, 'okMsg toast must not be an error toast');
  assert.equal(r.prompts.length, 0, 'window.prompt must not be called on success');
  assert.equal(r.attached.size, 0, 'temporary textarea must be removed from body');
});

test('walletCopyFallback: execCommand throws -> legacy error toast only', () => {
  const r = runFallback(KEY, OK_MSG, () => { throw new Error('execCommand not allowed'); });

  assert.deepEqual(r.execCalls, ['copy'], "execCommand must be called once with 'copy'");
  assert.equal(r.toasts.length, 1, 'exactly one toast');
  assert.equal(r.toasts[0].msg, '复制失败，请手动选中密钥复制');
  assert.equal(r.toasts[0].isError, true);
  assert.ok(r.toasts.every((t) => t.msg !== OK_MSG), 'okMsg must never be shown');
  assert.equal(r.prompts.length, 0, 'window.prompt must not be called on the exception path');
});
