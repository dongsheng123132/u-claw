import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PROVIDER_ENV_VARS } from '../portable/lib/strip-provider-env.mjs';
import { OFFICIAL_PROVIDER_SNAPSHOT } from '../portable/lib/official-provider-guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/official-external-provider-catalog-2026.9.1.json'), 'utf8'));
const sorted = (values) => [...new Set(values)].sort();
// 2026.9.1 起 catalog 改结构：entries[].providers 搬到 entries[].openclaw.providers，
// envVars 跟着 provider 走。新旧双格式兼容（旧 2026.8.1 fixture 照样能读）。
// 注意：2026.9.1 有 7 个 provider 不带 envVars（如 amazon-bedrock 走 IAM 非 key），
// flatMap 会产出 undefined，过滤掉再比（strip 清单只收录 key 类变量）。
const entryProviders = (entry) => entry.providers || entry.openclaw?.providers || [];
const fixtureEnvVars = () => fixture.entries.flatMap((entry) => entryProviders(entry).flatMap((provider) => provider.envVars || []));
const fixtureIds = () => fixture.entries.flatMap((entry) => entryProviders(entry).map((provider) => provider.id));

test('provider env stripping list exactly matches the 2026.9.1 official catalog fixture', () => {
  assert.deepEqual(sorted(OFFICIAL_PROVIDER_ENV_VARS), sorted(fixtureEnvVars()));
});

test('provider guard snapshot ids exactly match the 2026.9.1 official catalog fixture', () => {
  assert.deepEqual(sorted(OFFICIAL_PROVIDER_SNAPSHOT.map(([id]) => id)), sorted(fixtureIds()));
});
