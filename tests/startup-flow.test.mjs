import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../portable/lib/loading.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function page(result, { configured = '1', httpOk = true, reject = false } = {}) {
  const navigation = [], timers = [], requests = [];
  const elements = new Map();
  runInNewContext(script, {
    location: { search: `?port=18793&configured=${configured}`, port: '18782', replace: url => navigation.push(url) },
    URLSearchParams, AbortController, Date,
    document: { body: { classList: { add() {} } }, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    setInterval() {}, clearTimeout() {},
    setTimeout(callback, delay) { timers.push({callback, delay}); },
    async fetch(url) { requests.push(url); if (reject) throw new Error('offline'); return { ok: httpOk, json: async () => result }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { navigation, timers, requests };
}
for (const [name, result, options] of [
  ['initializing', {ok:true, ready:false}, {}],
  ['unrelated listener', {ok:false, ready:true}, {}],
  ['missing ready status', {ok:true}, {}],
  ['HTTP 503', {ok:true, ready:true}, {httpOk:false}],
  ['network failure', {}, {reject:true}],
]) test(`startup stays put and retries on ${name}`, async () => {
  const actual = await page(result, options);
  assert.deepEqual(actual.navigation, []);
  assert.equal(actual.timers.filter(t => t.delay === 1000).length, 1);
});
test('configured startup opens the selected gateway only after real readiness', async () => {
  const actual = await page({ok:true, ready:true});
  assert.deepEqual(actual.requests, ['/api/gateway-check?port=18793']);
  assert.deepEqual(actual.navigation, ['http://127.0.0.1:18793/#token=uclaw']);
});
test('first run waits then opens configuration on the actual config port', async () => {
  const actual = await page({ok:true, ready:true}, {configured:'0'});
  assert.deepEqual(actual.navigation, ['http://127.0.0.1:18782/']);
});
