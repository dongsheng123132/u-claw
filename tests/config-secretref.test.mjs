import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const server = readFileSync(join(repoRoot, 'portable', 'config-server', 'server.js'), 'utf8');
const configPage = readFileSync(join(repoRoot, 'portable', 'config-server', 'public', 'index.html'), 'utf8');

test('config save stores API keys as SecretRef through OpenClaw secret store stdin', () => {
  for (const token of ['secrets', 'store', 'set', '--kind', 'secret', '--value-file', 'UCLAW_MODEL_']) {
    assert.ok(server.includes(token), `server must use secret store token: ${token}`);
  }
  assert.match(server, /child\.stdin\.end\(value/, 'secret value must be passed through stdin, never argv');
  assert.match(server, /function isMaskedKey\(/, 'masked keys must be detected before writing config');
  assert.match(server, /function isSecretRefPlaceholder\(/, 'the SecretRef display placeholder must never enter the secret store');
  assert.match(server, /请重新输入 API Key/, 'server must reject a display placeholder submitted directly');
  assert.match(server, /source:\s*'store'/, 'saved config must contain SecretRef values');
  assert.match(server, /secrets',\s*'reload'/, 'saved secrets should reload into a running gateway');
});

test('incoming API key is replaced before merged config is written', () => {
  assert.match(server, /provider\.apiKey\s*=\s*await storeSecretRef\(/, 'provider apiKey must be replaced with a SecretRef');
  const executable = server.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.match(executable, /await moveIncomingSecretsToStore\(incoming\)[\s\S]*mergeConfig\(readConfigSafe\(CONFIG_PATH\), incoming\)[\s\S]*guardOfficialProvidersInMemory\(merged,[\s\S]*writeConfigAtomic\(CONFIG_PATH, merged\)/,
    'secret storage, merge, guard and atomic write must form one executable save chain');
  assert.doesNotMatch(server, /saveConfigMerged\(CONFIG_PATH,\s*JSON\.parse\(body\)\)/,
    'parsed incoming values must not be merged directly without secret handling');
  assert.match(server, /mergeConfig\(readConfigSafe\(CONFIG_PATH\), incoming\)/,
    'non-sensitive configuration must continue using the normal merge writer');
});

test('config page keeps saved secrets out of the API key input and reports reload state', () => {
  assert.match(configPage, /SECRET_REF_INPUT_VALUE = '（已加密保存，无需重填）'/);
  assert.match(configPage, /input\.value = SECRET_REF_INPUT_VALUE/);
  assert.match(configPage, /已保存的密钥已脱敏；输入新值可更换/);
  assert.match(configPage, /pendingRestart/);
  assert.match(configPage, /inputApiKey === SECRET_REF_INPUT_VALUE && !isSecretRefValue\(savedProviderApiKey\)/,
    'saving an unbacked placeholder must be rejected');
});
