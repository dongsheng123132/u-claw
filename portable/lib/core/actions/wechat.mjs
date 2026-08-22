// wechat.mjs —— 微信插件铺设动作
//
// 改造前这一个动作在 5 个文件里各写一遍：
//   Windows-Start.bat / Windows-Install.bat / Mac-Start.command /
//   Mac-Install.command / config-server/server.js(ensureWeChatPluginInstalled)
// 所以 zod 那个修复的 diff 要同时改 4 个文件——漏一个，那台机器的客户就修不好。
// 宪法 #12：公共能力复用不复制。
//
// 同时修掉一个铺设逻辑本身的 bug：原来只判断"目标不存在才铺"，
// 于是 app/extensions/ 里的插件升级后，U 盘上那份永远停在旧版本。
// 现在比对 openclaw.plugin.json 的 version，版本不同就重铺。

import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defineAction, ActionError } from '../runtime.mjs';

const PLUGIN_ID = 'openclaw-weixin';

function readPluginVersion(pluginDir) {
  const manifest = join(pluginDir, 'openclaw.plugin.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version || null;
  } catch {
    return null; // 清单损坏 → 当作"版本未知"，走重铺分支自愈
  }
}

export const wechatInstall = defineAction({
  id: 'plugin.wechat.install',
  title: '铺设微信插件',
  description:
    '把内置的微信插件铺到 OpenClaw 实际加载的目录（OPENCLAW_STATE_DIR/extensions），' +
    '并补齐插件缺失的 zod 依赖。版本不一致时自动重铺。幂等，每次启动都可以跑。',
  tags: ['plugin', 'wechat'],
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      force: { type: 'boolean', description: '忽略版本比对，强制重铺' },
    },
  },
  output_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      installed: { type: 'boolean' },
      action: { enum: ['none', 'installed', 'upgraded', 'zod-repaired', 'skipped-no-source'] },
      source_version: { type: ['string', 'null'] },
      installed_version: { type: ['string', 'null'] },
      path: { type: ['string', 'null'] },
    },
    required: ['installed', 'action'],
  },
  effects: { class: 'write', risk: 'low', reversible: true, confirmation: 'never', audit_required: true },
  execution: { headless: true, idempotent: true, cancellable: true, timeout_ms: 120000, progress_events: true, headless_evidence: 'tests/action-core.test.mjs' },
  async run(input, ctx) {
    const { bundledExtensionsDir, extensionsDir, coreDir } = ctx.paths;
    // 慢 U 盘上 cpSync 整个插件目录可能要几十秒，必须能中断（§7.4：
    // 报进度就得能取消，否则用户只能看着干等）。在每个耗时步骤前检查。
    const abortIfCancelled = () => {
      if (ctx.signal?.aborted) throw new ActionError('CANCELLED', '铺设已取消');
    };
    abortIfCancelled();
    const src = join(bundledExtensionsDir, PLUGIN_ID);
    const dst = join(extensionsDir, PLUGIN_ID);

    // 没有内置插件（精简包 / 用户删了）→ 安静跳过，绝不阻断启动
    if (!existsSync(join(src, 'openclaw.plugin.json'))) {
      return { installed: false, action: 'skipped-no-source', source_version: null, installed_version: null, path: null };
    }

    const srcVersion = readPluginVersion(src);
    const dstVersion = readPluginVersion(dst);
    let action = 'none';

    const needsInstall = input.force || !existsSync(join(dst, 'openclaw.plugin.json'));
    const needsUpgrade = !needsInstall && srcVersion !== dstVersion;

    if (needsInstall || needsUpgrade) {
      abortIfCancelled();
      ctx.progress?.(10, needsUpgrade ? `升级微信插件 ${dstVersion} → ${srcVersion}` : '铺设微信插件');
      if (!ctx.dryRun) {
        mkdirSync(extensionsDir, { recursive: true });
        // 升级前先删旧目录：旧版残留文件混在新版里会出难查的问题
        if (needsUpgrade) rmSync(dst, { recursive: true, force: true });
        cpSync(src, dst, { recursive: true });
      }
      action = needsUpgrade ? 'upgraded' : 'installed';
    }

    // zod 修补：插件 npm 包不带 zod，期望宿主提供；但 OpenClaw 从单目录加载插件，
    // 宿主 node_modules 不在该插件的解析路径上 → "Cannot find module 'zod'" → 微信渠道整个不可用。
    // 每次都检查，让"已铺好但缺 zod"的旧盘在下次启动自愈。
    const zodDst = join(dst, 'node_modules', 'zod');
    const zodSrc = join(coreDir, 'node_modules', 'zod');
    if (!ctx.dryRun && !existsSync(zodDst) && existsSync(zodSrc)) {
      abortIfCancelled();
      ctx.progress?.(70, '补齐插件依赖 zod');
      mkdirSync(join(dst, 'node_modules'), { recursive: true });
      cpSync(zodSrc, zodDst, { recursive: true });
      if (action === 'none') action = 'zod-repaired';
    }

    const finalVersion = ctx.dryRun ? srcVersion : readPluginVersion(dst);
    const installed = ctx.dryRun ? true : existsSync(join(dst, 'openclaw.plugin.json'));
    if (!installed && !ctx.dryRun) {
      throw new ActionError('PLUGIN_INSTALL_FAILED', `微信插件铺设后校验失败：${dst} 下找不到 openclaw.plugin.json`);
    }

    return { installed, action, source_version: srcVersion, installed_version: finalVersion, path: dst };
  },
});

export default [wechatInstall];
