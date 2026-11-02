#!/usr/bin/env node
// Recompute / inspect the sha256 baseline anchors of the fail-closed vendor
// patches (portable/lib/patch-*.mjs).
//
// Setup keeps failing closed: an unknown upstream bundle still makes setup
// exit 1, and this tool never patches anything by itself. It only turns
// "upstream moved, now what?" into a 30-second anchor refresh:
//
//   node tools/patch-baseline.mjs --upstream portable/app/core --print
//   node tools/patch-baseline.mjs --upstream portable/app/core --accept
//
// `--accept` rewrites anchor constants only: sha256 anchors and the reviewed
// package-version pins. It refuses (and writes nothing) when the patch
// replacement text itself drifted, because that needs human review.
//
// Exit codes: 0 = every selected patch is ready / was accepted,
//             1 = needs manual work, refused, or verify failed,
//             2 = usage error / missing input.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ANCHOR_STATUS,
  anchorStates,
  classifyAnchorFile,
  diffLines,
  findAnchorWindow,
  formatDiffHunks,
  planOriginalAcceptance,
  restoreOriginal,
  sha256Text,
} from '../portable/lib/patch-anchors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const DEFAULT_PATCH_DIR = join(repoRoot, 'portable/lib');
const OPENCLAW_VERSION_FILE = join(repoRoot, 'OPENCLAW_VERSION');

const USAGE = `Usage: node tools/patch-baseline.mjs --upstream <core-dir> [options]

Inspect the sha256 anchors of the fail-closed OpenClaw vendor patches.

Options:
  --upstream <dir>   Installed core dir (same argument setup passes to the patches).
  --print            Read-only report (default). Exit 0 when every patch is anchored.
  --accept           Rewrite anchor constants (sha256 + version pins) for unknown
                     upstream input. Refuses when replacement text drifted.
                     Never changes the patch logic / replacement text.
  --dry-run          With --accept: print the plan, write nothing.
  --baseline <dir>   Older core dir used to render a real line-level diff of the
                     upstream drift (optional).
  --patch <id>       Only process one patch (id or file-name substring).
  --patch-dir <dir>  Patch module directory (default: portable/lib).
  --json             Machine-readable output.
  -h, --help         Show this help.
`;

function fail(message) {
  process.stderr.write(`patch-baseline: ${message}\n`);
  process.exit(2);
}

function displayPath(file) {
  const relativePath = relative(repoRoot, file);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) ? relativePath : file;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const options = {
    upstream: null,
    patchDir: DEFAULT_PATCH_DIR,
    baseline: null,
    patch: null,
    mode: 'report',
    json: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) fail(`missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case '--upstream': options.upstream = value(); break;
      case '--patch-dir': options.patchDir = value(); break;
      case '--baseline': options.baseline = value(); break;
      case '--patch': options.patch = value(); break;
      case '--print': options.mode = 'report'; break;
      case '--accept': options.mode = 'accept'; break;
      case '--dry-run': options.dryRun = true; break;
      case '--json': options.json = true; break;
      case '-h':
      case '--help': options.help = true; break;
      default: fail(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

async function loadPatches(patchDir, filter, cacheBust = '') {
  const names = readdirSync(patchDir)
    .filter(name => name.startsWith('patch-') && name.endsWith('.mjs') && name !== 'patch-anchors.mjs')
    .sort();
  const patches = [];
  for (const name of names) {
    const file = join(patchDir, name);
    const module = await import(pathToFileURL(file).href + (cacheBust ? `?${cacheBust}` : ''));
    const metadata = module.PATCH_BASELINE;
    if (!metadata) continue;
    if (filter && metadata.id !== filter && !name.includes(filter)) continue;
    patches.push({ ...metadata, moduleFile: file, moduleName: name });
  }
  if (patches.length === 0) fail(`no anchor-aware patch modules found in ${displayPath(patchDir)}`);
  return patches;
}

function evaluatePatch(patch, options) {
  const versions = patch.versionPins.map(pin => {
    const file = join(options.upstream, 'node_modules', pin.package, 'package.json');
    let actual = null;
    let error = null;
    try {
      actual = JSON.parse(readFileSync(file, 'utf8')).version ?? null;
    } catch (cause) {
      error = cause.code || cause.message;
    }
    return { ...pin, file, actual, error, ok: actual === pin.expected };
  });
  const targets = patch.targets.map(target => {
    const file = join(options.upstream, target.bundle);
    let source = null;
    let error = null;
    try {
      source = readFileSync(file, 'utf8');
    } catch (cause) {
      error = cause.code || cause.message;
    }
    if (source === null) {
      return { ...target, file, exists: false, status: ANCHOR_STATUS.MISSING, error, ready: false, diagnostics: null };
    }
    const classification = classifyAnchorFile({
      source,
      originalSha256: target.originalSha256,
      replacements: target.replacements,
    });
    const ready = classification.status !== ANCHOR_STATUS.UNKNOWN;
    const result = { ...target, file, exists: true, source, classification, status: classification.status, ready };
    if (!ready) result.diagnostics = buildDiagnostics(target, source, options);
    return result;
  });
  const ready = versions.every(version => version.ok) && targets.every(target => target.ready);
  return { patch, versions, targets, ready };
}

function buildDiagnostics(target, source, options) {
  const states = anchorStates(source, target.replacements);
  const regions = states.map(state => {
    const original = target.replacements[state.index][0];
    const window = findAnchorWindow(source, original);
    let diff = null;
    if (window && state.originalCount !== 1) {
      const changed = diffLines(original, window.lines.join('\n'));
      // The anchor text is compared on its own; shift the "current file" line
      // numbers so the diff points at real upstream lines.
      const offset = window.startLine - 1;
      for (const op of changed.ops) {
        if (typeof op.actualLine === 'number') op.actualLine += offset;
      }
      diff = formatDiffHunks(changed, { linePrefix: '                   ' });
    }
    return { ...state, window, diff };
  });
  let baseline = null;
  if (options.baseline) {
    const baselineFile = join(options.baseline, target.bundle);
    try {
      let baselineSource = readFileSync(baselineFile, 'utf8');
      const baselineClassification = classifyAnchorFile({
        source: baselineSource,
        originalSha256: target.originalSha256,
        replacements: target.replacements,
      });
      if (baselineClassification.status === ANCHOR_STATUS.PATCHED) {
        baselineSource = restoreOriginal(baselineSource, target.replacements);
      }
      const changed = diffLines(baselineSource, source);
      baseline = {
        file: baselineFile,
        added: changed.added,
        removed: changed.removed,
        coarse: changed.coarse,
        lines: formatDiffHunks(changed, { linePrefix: '                   ' }),
      };
    } catch (cause) {
      baseline = { file: baselineFile, error: cause.code || cause.message };
    }
  }
  const pristine = states.every(state => state.originalCount === 1) && states.every(state => state.patchedCount === 0);
  return { states, regions, baseline, pristine };
}

function printReport(results, options) {
  const lines = [];
  lines.push(`patch-baseline  upstream=${options.upstream}`);
  lines.push(`patch-anchors   patch-dir=${displayPath(options.patchDir)}  baseline=${options.baseline ? displayPath(options.baseline) : '(none)'}`);
  for (const result of results) {
    lines.push(`[${result.ready ? 'OK  ' : 'FAIL'}] ${result.patch.id}  (${displayPath(result.patch.moduleFile)})`);
    for (const version of result.versions) {
      const actual = version.actual === null ? `missing (${version.error})` : version.actual;
      lines.push(`         version   ${version.package} ${actual}  pin=${version.expected}  ${version.ok ? 'OK' : 'MISMATCH'}`);
    }
    for (const target of result.targets) {
      lines.push(`         target    ${target.bundle}`);
      if (!target.exists) {
        lines.push(`                   exists=no (${target.error})`);
        continue;
      }
      lines.push(`                   sha256=${target.classification.actualSha256}`);
      if (target.classification.status === ANCHOR_STATUS.ORIGINAL) {
        lines.push('                   status=original  -- 命中原始锚点，setup 会直接打补丁');
      } else if (target.classification.status === ANCHOR_STATUS.PATCHED) {
        lines.push('                   status=patched   -- 命中已打补丁锚点，setup 会跳过已打好的文件');
      } else {
        lines.push('                   status=unknown   -- 既不是原始锚点，也不是已打补丁锚点，setup 会 exit 1');
        const diagnostics = target.diagnostics;
        const originalHits = diagnostics.states.map(state => state.originalCount).join('/');
        const patchedMarkers = diagnostics.states.map(state => state.patchedCount).join('/');
        lines.push(`                   anchors   original hits=${originalHits}  patched markers=${patchedMarkers}`);
        for (const region of diagnostics.regions) {
          if (!region.diff || region.window === null) continue;
          const similarity = typeof region.window.similarity === 'number' ? region.window.similarity.toFixed(2) : '0';
          lines.push(`                   diff      replacement #${region.index + 1} 锚点区域 -> 当前文件第 ${region.window.startLine}-${region.window.endLine} 行 (similarity=${similarity})`);
          lines.push(...region.diff);
        }
        if (diagnostics.baseline?.lines) {
          const kind = diagnostics.baseline.coarse ? ' (coarse)' : '';
          lines.push(`                   diff      baseline ${displayPath(diagnostics.baseline.file)}: -${diagnostics.baseline.removed} +${diagnostics.baseline.added}${kind}`);
          lines.push(...diagnostics.baseline.lines);
        } else if (diagnostics.baseline?.error) {
          lines.push(`                   baseline  ${displayPath(diagnostics.baseline.file)} unreadable (${diagnostics.baseline.error})`);
        }
        if (diagnostics.pristine) {
          lines.push('                   note      补丁锚点文本全部命中且补丁逻辑可应用：--accept 可安全重算本文件 sha256');
          if (!diagnostics.baseline) {
            lines.push('                   note      上游漂移在锚点区域之外；需要逐行 diff 可加 --baseline <旧 core 目录>');
          }
        } else {
          lines.push('                   note      补丁锚点文本已变：--accept 会拒绝自动接受，需人工复核 REPLACEMENTS');
        }
      }
    }
    if (!result.ready) {
      lines.push(`         accept    node tools/patch-baseline.mjs --upstream ${options.upstream} --accept --patch ${result.patch.id}`);
    }
  }
  const ready = results.filter(result => result.ready).length;
  lines.push(results.every(result => result.ready)
    ? `RESULT: READY ${ready}/${results.length} patch(es) anchored`
    : `RESULT: NEEDS-ACCEPT ${results.length - ready}/${results.length} patch(es) not ready`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function reportJson(results, options) {
  return {
    upstream: options.upstream,
    patchDir: options.patchDir,
    baseline: options.baseline,
    ready: results.every(result => result.ready),
    patches: results.map(result => ({
      id: result.patch.id,
      file: result.patch.moduleFile,
      ready: result.ready,
      versions: result.versions.map(version => ({ package: version.package, pin: version.expected, actual: version.actual, ok: version.ok })),
      targets: result.targets.map(target => ({
        bundle: target.bundle,
        exists: target.exists,
        status: target.status,
        sha256: target.classification?.actualSha256 ?? null,
        originalSha256: target.originalSha256,
        anchorStates: target.diagnostics?.states ?? null,
      })),
    })),
  };
}

function signature(patch) {
  return JSON.stringify({
    id: patch.id,
    versionConstants: patch.versionPins.map(pin => [pin.package, pin.constant]),
    targets: patch.targets.map(target => [target.bundle, target.shaConstant, target.replacements]),
  });
}

function printFatals(fatals) {
  process.stdout.write(`${fatals.map(fatal => `[FATAL] ${fatal.patch.id}: ${fatal.code}: ${fatal.message}`).join('\n')}\n`);
}

async function acceptAnchors(results, options) {
  if (results.every(result => result.ready)) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ready: true, accepted: [] }, null, 2)}\n`);
    else process.stdout.write(`RESULT: READY ${results.length}/${results.length} patch(es) anchored; nothing to accept.\n`);
    return 0;
  }
  const plans = [];
  const fatals = [];
  for (const result of results) {
    if (result.ready) continue;
    const edits = [];
    for (const version of result.versions) {
      if (version.ok) continue;
      if (version.actual === null) {
        fatals.push({ patch: result.patch, code: 'VERSION-PACKAGE-MISSING', message: `${version.package}: ${displayPath(version.file)} unreadable (${version.error})` });
        continue;
      }
      edits.push({ kind: 'version', constant: version.constant, from: version.expected, to: version.actual, reason: `${version.package} version` });
    }
    for (const target of result.targets) {
      if (target.ready) continue;
      if (!target.exists) {
        fatals.push({ patch: result.patch, code: 'TARGET-MISSING', message: `${target.bundle}: missing (${target.error})` });
        continue;
      }
      const acceptance = planOriginalAcceptance({ source: target.source, replacements: target.replacements });
      if (!acceptance.ok) {
        fatals.push({ patch: result.patch, code: acceptance.code, message: `${target.bundle}: ${acceptance.message}` });
        continue;
      }
      edits.push({
        kind: 'sha',
        constant: target.shaConstant,
        from: target.originalSha256,
        to: sha256Text(target.source),
        reason: `${target.bundle} new upstream original`,
        patchedSha256: acceptance.patchedSha256,
      });
    }
    plans.push({ patch: result.patch, edits });
  }

  if (fatals.length > 0) {
    printFatals(fatals);
    process.stdout.write(`RESULT: REFUSED ${fatals.length} blocker(s); no files written. --accept only rewrites anchors, drift in the patch text needs manual review.\n`);
    return 1;
  }

  const writes = [];
  for (const plan of plans) {
    if (plan.edits.length === 0) continue;
    const beforeText = readFileSync(plan.patch.moduleFile, 'utf8');
    let text = beforeText;
    for (const edit of plan.edits) {
      const pattern = new RegExp(`(const ${escapeRegExp(edit.constant)} = ')[^']*(';)`);
      const match = text.match(pattern);
      const file = displayPath(plan.patch.moduleFile);
      if (match === null) {
        fatals.push({ patch: plan.patch, code: 'CONSTANT-MISSING', message: `${edit.constant} not found in ${file}` });
        continue;
      }
      const current = match[0].slice(match[1].length, match[0].length - match[2].length);
      if (current !== edit.from) {
        fatals.push({ patch: plan.patch, code: 'CONSTANT-DRIFT', message: `${edit.constant} in ${file} is '${current}', expected anchor '${edit.from}'` });
        continue;
      }
      edit.current = current;
      text = text.replace(pattern, (_whole, prefix, suffix) => `${prefix}${edit.to}${suffix}`);
    }
    const changed = diffLines(beforeText, text);
    if (changed.removed !== plan.edits.length || changed.added !== plan.edits.length) {
      fatals.push({ patch: plan.patch, code: 'UNEXPECTED-EDIT', message: `${displayPath(plan.patch.moduleFile)} would change ${changed.removed} line(s), expected ${plan.edits.length} anchor constant line(s)` });
      continue;
    }
    writes.push({ file: plan.patch.moduleFile, beforeText, text });
  }
  if (fatals.length > 0) {
    printFatals(fatals);
    process.stdout.write('RESULT: REFUSED 0 files written.\n');
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      dryRun: options.dryRun,
      accepted: plans.filter(plan => plan.edits.length > 0).map(plan => ({
        id: plan.patch.id,
        file: plan.patch.moduleFile,
        edits: plan.edits.map(edit => ({ kind: edit.kind, constant: edit.constant, from: edit.from, to: edit.to, reason: edit.reason })),
      })),
    }, null, 2)}\n`);
  } else {
    for (const plan of plans) {
      if (plan.edits.length === 0) continue;
      process.stdout.write(`[ACCEPT] ${plan.patch.id}  (${displayPath(plan.patch.moduleFile)})\n`);
      for (const edit of plan.edits) {
        process.stdout.write(`         ${edit.kind === 'version' ? 'version ' : 'anchor  '} ${edit.constant}  '${edit.from}' -> '${edit.to}'  (${edit.reason})\n`);
        if (edit.patchedSha256) {
          process.stdout.write(`         patched  sha256=${edit.patchedSha256}  (打补丁后的输出 sha，patch 成功时会打印同一值)\n`);
        }
      }
    }
  }

  if (options.dryRun) {
    process.stdout.write(`RESULT: DRY-RUN ${writes.length} patch file(s) would be accepted; no files written.\n`);
    return 0;
  }
  for (const write of writes) writeFileSync(write.file, write.text);

  const reloaded = await loadPatches(options.patchDir, options.patch, `accept=${Date.now()}`);
  const rechecks = reloaded.map(patch => evaluatePatch(patch, options));
  const unstable = [];
  for (const recheck of rechecks) {
    const before = results.find(result => result.patch.id === recheck.patch.id);
    if (before && signature(before.patch) !== signature(recheck.patch)) unstable.push(recheck.patch.id);
  }
  const notReady = rechecks.filter(result => !result.ready);
  if (notReady.length > 0 || unstable.length > 0) {
    process.stdout.write(`RESULT: VERIFY-FAILED notReady=${notReady.map(result => result.patch.id).join(',') || 'none'} logicChanged=${unstable.join(',') || 'none'}; inspect git diff before retrying.\n`);
    return 1;
  }

  if (!options.json) {
    process.stdout.write(`RESULT: ACCEPTED ${writes.length} patch file(s) rewritten; anchors verified against ${options.upstream}.\n`);
    process.stdout.write(`NOTE: 复核后再跑 setup；未知上游仍会 exit 1，闸门未被放宽。\n`);
    const upstreamOpenClaw = rechecks
      .flatMap(result => result.versions)
      .find(version => version.package === 'openclaw')?.actual;
    if (upstreamOpenClaw && existsSync(OPENCLAW_VERSION_FILE)) {
      const pin = readFileSync(OPENCLAW_VERSION_FILE, 'utf8').trim();
      if (pin !== upstreamOpenClaw) {
        process.stdout.write(`NOTE: OPENCLAW_VERSION=${pin} 与上游 openclaw=${upstreamOpenClaw} 不一致；版本 pin 由 release/track-upstream 流程负责，请单独确认。\n`);
      }
    }
    process.stdout.write(`NEXT: git diff -- portable/lib/ && node --test "tests/*.test.mjs"\n`);
  }
  return 0;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.upstream) fail('missing --upstream <core-dir>');
  options.upstream = resolve(options.upstream);
  options.patchDir = resolve(options.patchDir);
  if (options.baseline) options.baseline = resolve(options.baseline);
  if (!existsSync(options.upstream)) fail(`upstream directory not found: ${options.upstream}`);
  if (!existsSync(options.patchDir)) fail(`patch directory not found: ${options.patchDir}`);
  if (options.baseline && !existsSync(options.baseline)) fail(`baseline directory not found: ${options.baseline}`);

  const patches = await loadPatches(options.patchDir, options.patch);
  const results = patches.map(patch => evaluatePatch(patch, options));
  if (options.mode === 'accept') return acceptAnchors(results, options);
  if (options.json) process.stdout.write(`${JSON.stringify(reportJson(results, options), null, 2)}\n`);
  else printReport(results, options);
  return results.every(result => result.ready) ? 0 : 1;
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code;
}).catch(error => {
  process.stderr.write(`patch-baseline: FATAL ${error?.stack || error}\n`);
  process.exitCode = 1;
});
