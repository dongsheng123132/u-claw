import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readRepoFile(...parts) {
  return readFileSync(join(repoRoot, ...parts), 'utf8');
}

const models = ['MiniMax-M3', 'MiniMax-M2.7'];
const endpoints = [
  'https://api.minimax.io/v1',
  'https://api.minimaxi.com/v1',
];
const setupPaths = [
  ['install', 'install.sh'],
  ['install', 'install.ps1'],
  ['portable', 'Config.html'],
  ['portable', 'config-server', 'public', 'index.html'],
  ['u-claw-app', 'resources', 'Config.html'],
];
const configUis = setupPaths.slice(2);

test('every MiniMax setup path includes the current models and regional endpoints', () => {
  for (const pathParts of setupPaths) {
    const content = readRepoFile(...pathParts);
    for (const model of models) {
      assert.ok(content.includes(model), `${pathParts.join('/')} is missing ${model}`);
    }
    for (const endpoint of endpoints) {
      assert.ok(content.includes(endpoint), `${pathParts.join('/')} is missing ${endpoint}`);
    }
    assert.doesNotMatch(content, /api\.minimax\.chat\/v1|abab6\.5s-chat|MiniMax-Text-01|data-model="MiniMax-M2"/);
  }
});

test('MiniMax configuration UIs expose and restore each model and region combination', () => {
  const metadata = [
    "input: ['text', 'image', 'video']",
    'cost: { input: 0.6, output: 2.4, cacheRead: 0.12 }',
    'contextWindow: 1000000',
    'cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 }',
    'contextWindow: 204800',
  ];

  for (const pathParts of configUis) {
    const content = readRepoFile(...pathParts);
    for (const endpoint of endpoints) {
      for (const model of models) {
        assert.ok(
          content.includes(`data-base="${endpoint}" data-model="${model}"`),
          `${pathParts.join('/')} is missing ${model} at ${endpoint}`,
        );
      }
    }
    for (const field of metadata) {
      assert.ok(content.includes(field), `${pathParts.join('/')} is missing ${field}`);
    }
    assert.ok(content.includes("document.querySelector('#step1 .model-card.selected')"));
    assert.match(content, /candidate\.dataset\.base[\s\S]*candidate\.dataset\.model/);
  }
});

test('MiniMax installers provide explicit model and region choices', () => {
  const shellInstaller = readRepoFile('install', 'install.sh');
  const powershellInstaller = readRepoFile('install', 'install.ps1');

  assert.match(shellInstaller, /MINIMAX_MODEL_CHOICE[\s\S]*MINIMAX_REGION_CHOICE/);
  assert.match(powershellInstaller, /minimaxModelChoice[\s\S]*minimaxRegionChoice/);
  for (const docsRoot of [
    'https://platform.minimax.io/docs',
    'https://platform.minimaxi.com/docs',
  ]) {
    assert.ok(shellInstaller.includes(docsRoot));
    assert.ok(powershellInstaller.includes(docsRoot));
  }
});
