// 影核一致性测试（ActionParity §13.2 绑定测试 + 防漂移）
//
// 核心目的：让"清单说的"和"代码做的"不可能对不上。
// action-parity.json 是从注册表生成的产物；只要有人改了动作却忘了重新生成，
// 这里立刻红。宪法 #8：同一事实存在几份就会漂移几份——所以只认一个源，其余靠测试钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildManifest } from '../portable/lib/core/manifest.mjs';
import { ACTIONS } from '../portable/lib/core/index.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_PATH = join(REPO, 'portable', 'action-parity.json');

function loadCommitted() {
  assert.ok(existsSync(MANIFEST_PATH), 'portable/action-parity.json 不存在');
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

test('仓库里的 action-parity.json 与注册表生成结果一致（防漂移）', () => {
  const committed = loadCommitted();
  const generated = buildManifest();

  // application.version 来自 OPENCLAW_VERSION，跟随发版变动，不参与比对
  const strip = (m) => ({ ...m, application: { ...m.application, version: '<ignored>' } });

  assert.deepEqual(
    strip(committed),
    strip(generated),
    '清单与实现不一致。改完动作后请重新生成：\n' +
      '  node portable/lib/core/manifest.mjs > portable/action-parity.json',
  );
});

test('清单声明的动作集合 == 注册表里的动作集合', () => {
  const committed = loadCommitted();
  assert.deepEqual(
    committed.actions.map((a) => a.id).sort(),
    ACTIONS.map((a) => a.id).sort(),
  );
});

test('每个动作都绑定到了必需 Surface（AP-2 覆盖率计算的分子）', () => {
  const m = loadCommitted();
  const required = m.surfaces.filter((s) => s.required_for_parity).map((s) => s.id);
  assert.ok(required.length > 0, '至少要有一个 required_for_parity 的 Surface');

  for (const action of m.actions) {
    for (const surface of required) {
      const bound = (action.bindings || []).some((b) => b.surface === surface);
      const exempt = (action.parity_exceptions || []).some((e) => e.surface === surface);
      assert.ok(bound || exempt, `${action.id} 在必需 Surface "${surface}" 上既无绑定也无豁免`);
    }
  }
});

test('所有绑定引用的 Surface 都已声明（§6.4）', () => {
  const m = loadCommitted();
  const declared = new Set(m.surfaces.map((s) => s.id));
  for (const action of m.actions) {
    for (const b of action.bindings || []) {
      assert.ok(declared.has(b.surface), `${action.id} 绑定到了未声明的 Surface "${b.surface}"`);
    }
    for (const e of action.parity_exceptions || []) {
      assert.ok(declared.has(e.surface), `${action.id} 的豁免指向未声明的 Surface "${e.surface}"`);
    }
  }
});

test('豁免必须写全四要素，不许悄悄少写绑定（§8.3）', () => {
  const m = loadCommitted();
  for (const action of m.actions) {
    for (const e of action.parity_exceptions || []) {
      for (const field of ['surface', 'reason', 'owner', 'review_by']) {
        assert.ok(e[field], `${action.id} 的豁免缺 ${field}`);
      }
      assert.ok(e.reason.length > 10, `${action.id} 的豁免理由太敷衍："${e.reason}"`);
    }
  }
});

test('CLI 绑定都暴露了 --json（§9 要求结构化模式可见）', () => {
  const m = loadCommitted();
  for (const action of m.actions) {
    const cli = (action.bindings || []).find((b) => b.surface === 'cli');
    if (cli) assert.ok(cli.target.includes('--json'), `${action.id} 的 CLI 绑定没体现 --json：${cli.target}`);
  }
});

test('声明了进度事件的动作必须可取消（§7.4）', () => {
  for (const a of ACTIONS) {
    if (a.execution.progress_events) {
      assert.equal(a.execution.cancellable, true, `${a.id} 报进度却不能取消，用户只能干等`);
    }
  }
});

test('破坏性动作不许声明 confirmation:never（§11.2）', () => {
  for (const a of ACTIONS) {
    if (a.effects.class === 'destructive' || a.effects.risk === 'high' || a.effects.risk === 'critical') {
      assert.notEqual(a.effects.confirmation, 'never', `${a.id} 是破坏性/高危动作，确认策略不能是 never`);
    }
  }
});

// ── 绑定测试：证明各 Surface 走的是同一个动作核心（§13.2）────────────────────

test('config-server 的路由确实调的是清单声明的那个动作', () => {
  const server = readFileSync(join(REPO, 'portable', 'config-server', 'server.js'), 'utf8');
  const m = loadCommitted();

  for (const action of m.actions) {
    const gui = (action.bindings || []).find((b) => b.surface === 'gui');
    if (!gui) continue;
    // 绑定 target 形如 "config-server GET /api/config"
    const routePath = gui.target.split(' ').pop();
    assert.ok(server.includes(routePath), `server.js 里找不到路由 ${routePath}（${action.id} 的 GUI 绑定）`);
    assert.ok(
      server.includes(`runAction('${action.id}'`),
      `server.js 没有调用 ${action.id}——GUI 可能又自己实现了一份`,
    );
  }
});

test('config-server 不再自己写配置文件（业务必须回到动作核心）', () => {
  const server = readFileSync(join(REPO, 'portable', 'config-server', 'server.js'), 'utf8');
  // 改造前这里有三处 writeFileSync 直接写 openclaw.json
  assert.equal(
    /writeFileSync\([^)]*CONFIG_PATH/.test(server),
    false,
    'server.js 又在直接写 openclaw.json 了，应该走 config.set 动作',
  );
});

test('启动器调的是动作，而不是各自复制一份逻辑', () => {
  const win = readFileSync(join(REPO, 'portable', 'Windows-Start.bat'), 'utf8');
  const mac = readFileSync(join(REPO, 'portable', 'Mac-Start.command'), 'utf8');

  for (const [name, text] of [['Windows-Start.bat', win], ['Mac-Start.command', mac]]) {
    assert.ok(text.includes('uclaw.mjs') && text.includes('plugin.wechat.install'),
      `${name} 没有调用 plugin.wechat.install 动作`);
    assert.ok(text.includes('lock.clean'), `${name} 没有调用 lock.clean 动作`);
    // 微信插件的拷贝逻辑不该再出现在启动器里
    assert.equal(/xcopy[^\n]*openclaw-weixin|cp -R[^\n]*openclaw-weixin/.test(text), false,
      `${name} 里还残留着微信插件的拷贝实现，应该只调动作`);
  }
});
