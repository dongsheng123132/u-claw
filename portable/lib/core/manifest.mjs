// manifest.mjs —— 从动作注册表生成 action-parity.json
//
// 为什么是"生成"而不是"手写"：清单和实现是同一件事的两个副本，手写必然漂移
// （宪法 #8）。这里让实现当唯一真相源，清单由它导出；
// tests/action-parity.test.mjs 断言仓库里的 action-parity.json 与生成结果一致，
// 改了动作忘了重新生成，测试直接红。
//
// 重新生成：  node portable/lib/core/manifest.mjs > portable/action-parity.json

import { readFileSync, existsSync } from 'node:fs';
import { ACTIONS } from './index.mjs';
import { resolvePaths } from './paths.mjs';

// Surface 绑定表。哪个界面上的哪个入口，绑的是哪个动作 ID。
// 这张表就是"这个按钮绑的是哪个动作"的机器可读答案（宪法 #14）。
const BINDINGS = {
  'config.get':            { cli: 'uclaw config.get --json',                       gui: 'config-server GET /api/config' },
  'config.set':            { cli: 'uclaw config.set --patch <json> --json',        gui: 'config-server POST /api/config' },
  'doctor.diagnose':       { cli: 'uclaw doctor.diagnose --json',                  gui: 'config-server GET /api/doctor' },
  'bug.collect':           { cli: 'uclaw bug.collect --note <text> --json',        gui: 'config-server POST /api/bug-report' },
  'plugin.wechat.install': { cli: 'uclaw plugin.wechat.install --json',            gui: null },
  'lock.clean':            { cli: 'uclaw lock.clean --json',                       gui: null },
  'gateway.start':         { cli: 'uclaw gateway.start --json',                    gui: null },
  'gateway.stop':          { cli: 'uclaw gateway.stop --yes --json',               gui: null },
  'log.tail':              { cli: 'uclaw log.tail --json',                        gui: 'config-server GET /api/logs' },
  'runtime.probe':         { cli: 'uclaw runtime.probe --json',                    gui: null },
  'runtime.seed':          { cli: 'uclaw runtime.seed --json',                     gui: null },
  'runtime.install':       { cli: 'uclaw runtime.install --json',                  gui: null },
  'runtime.activate':      { cli: 'uclaw runtime.activate --version <v> --json',   gui: null },
  'runtime.gc':            { cli: 'uclaw runtime.gc --json',                       gui: null },
};

// GUI 尚未接入的动作，按 §8.3 明确登记豁免——不许悄悄少写一条绑定。
const EXCEPTIONS = {
  'plugin.wechat.install': '由启动器在每次启动时自动调用，用户无需手动触发；配置中心暂不暴露按钮。',
  'lock.clean':            '由 gateway.start 内部调用，属修复细节，不单独暴露给用户。',
  'gateway.start':         '便携版由 Windows-Start.bat / Mac-Start.command 拉起，非配置中心职责。',
  'gateway.stop':          '高危动作，便携版通过关闭启动器窗口完成，不在网页上放停服按钮。',
  'runtime.probe':         'v3 首启流程与诊断页尚未接入；当前由启动器和远程排障走 CLI，配置中心接入排在 Phase 1。',
  'runtime.seed':          'v3 首启流程由启动器在无界面阶段调用，此时配置中心还没起来，天然没有 GUI 入口。',
  'runtime.install':       'v3 首启流程由启动器在无界面阶段调用，此时配置中心还没起来，天然没有 GUI 入口。',
  'runtime.activate':      '换内核版本属运维动作，配置中心的「检查更新」接入排在 Phase 1，先只给 CLI。',
  'runtime.gc':            '清理旧内核属空间治理，配置中心的存储页排在 Phase 1，先只给 CLI 和启动器。',
};

export function buildManifest() {
  const paths = resolvePaths();
  const version = existsSync(paths.versionFile) ? readFileSync(paths.versionFile, 'utf8').trim() : '0.0.0';

  return {
    spec_version: '0.3.0',
    conformance_targets: ['AP-1'],
    application: {
      id: 'org.u-claw.portable',
      name: 'U-Claw Portable',
      version,
      description: '便携 U 盘版 OpenClaw。业务动作集中在 portable/lib/core，GUI / CLI / 启动器共用同一实现。',
      homepage: 'https://github.com/dongsheng123132/u-claw',
    },
    surfaces: [
      {
        id: 'cli',
        kind: 'cli',
        required_for_parity: true,
        // external：这条 CLI 任何外部进程都能直接调（远程运维 agent 就是这么用的），
        // 不是只有 U-Claw 自己前端能走的私有调用约定。0.3.0 §12 要求明示。
        reachability: 'external',
        description: 'node portable/uclaw.mjs <action.id>。远程排障和自动化的入口。',
      },
      {
        id: 'gui',
        kind: 'gui',
        // AP-1 阶段只要求 CLI 全覆盖；GUI 绑定正在迁移中，故不计入严格分母。
        // 迁完后把这里改成 true 即可升 AP-2。
        required_for_parity: false,
        reachability: 'local-ipc',
        description: '配置中心（Config.html + config-server）与启动器。',
        test_driver: 'node-http',
      },
    ],
    actions: ACTIONS.map((a) => {
      const bind = BINDINGS[a.id] || {};
      const bindings = [];
      if (bind.cli) bindings.push({ surface: 'cli', target: bind.cli, test: 'tests/action-core.test.mjs' });
      if (bind.gui) bindings.push({ surface: 'gui', target: bind.gui, test: 'tests/action-parity.test.mjs' });

      const entry = {
        id: a.id,
        title: a.title,
        description: a.description,
        tags: a.tags || [],
        input_schema: a.input_schema,
        output_schema: a.output_schema,
        effects: a.effects,
        execution: a.execution,
        bindings,
      };
      if (!bind.gui && EXCEPTIONS[a.id]) {
        entry.parity_exceptions = [{
          surface: 'gui',
          reason: EXCEPTIONS[a.id],
          owner: 'dongsheng123132',
          review_by: '2026-12-31',
        }];
      }
      return entry;
    }),
  };
}

// 直接执行时把清单打到 stdout，供重新生成 action-parity.json
import { pathToFileURL } from 'node:url';
const isMain = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) process.stdout.write(JSON.stringify(buildManifest(), null, 2) + '\n');
