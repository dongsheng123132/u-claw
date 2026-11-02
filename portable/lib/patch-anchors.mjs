// Shared sha256 anchor primitives for the fail-closed OpenClaw vendor patches.
//
// Each `patch-*.mjs` helper in this directory accepts exactly two upstream
// files: the reviewed original (anchored by sha256) or the reviewed patched
// output (verified by reverse-applying the replacements and hashing again).
// Everything else fails closed with exit 1 -- setup never silently adopts an
// unreviewed upstream bundle.
//
// This module does not widen that gate. It only makes the "upstream moved"
// failure diagnosable and gives `tools/patch-baseline.mjs` the primitives to
// recompute anchors; `--accept` there rewrites anchor constants only and never
// the replacement text or the patch logic.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// True when one of the `patch-*.mjs` helpers was invoked directly with
// `node patch-x.mjs ...` instead of imported by the baseline tool. Symlink-safe
// on purpose: comparing raw paths would silently skip the patch when the repo
// is reached through a symlink (e.g. macOS /tmp -> /private/tmp), and setup
// would then continue with an unpatched, syntactically valid bundle.
export function isCliEntry(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

export const ANCHOR_STATUS = Object.freeze({
  ORIGINAL: 'original',
  PATCHED: 'patched',
  UNKNOWN: 'unknown',
  MISSING: 'missing',
});

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

// sha256 of a file on disk (bytes, not decoded text).
export function computeSha256(filePath) {
  return sha256Text(readFileSync(filePath));
}

export function countOccurrences(source, needle) {
  if (!needle) return 0;
  return source.split(needle).length - 1;
}

export function splitLines(text) {
  const value = String(text);
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function lineNumberAt(text, index) {
  let line = 1;
  const limit = Math.min(index, text.length);
  for (let position = 0; position < limit; position++) {
    if (text[position] === '\n') line++;
  }
  return line;
}

// Reverse-apply the reviewed replacements, exactly like the patches do:
// `String#replace` with a string pattern replaces the first occurrence only.
export function restoreOriginal(source, replacements) {
  let restored = source;
  for (const [original, patched] of [...replacements].reverse()) {
    restored = restored.replace(patched, () => original);
  }
  return restored;
}

// Apply the reviewed replacements, enforcing the same exactly-once contract and
// post-conditions as the patch scripts. Used only for dry-run/accept planning:
// never call this to publish a file.
export function applyReplacements(source, replacements) {
  let patched = source;
  for (let index = 0; index < replacements.length; index++) {
    const [original] = replacements[index];
    const found = countOccurrences(patched, original);
    if (found !== 1) return { ok: false, code: 'ANCHOR-TEXT-DRIFT', index, count: found };
    patched = patched.replace(original, () => replacements[index][1]);
  }
  for (let index = 0; index < replacements.length; index++) {
    const [, replacement] = replacements[index];
    if (countOccurrences(patched, replacement) !== 1) return { ok: false, code: 'POST-CONDITION', index };
  }
  return { ok: true, patched };
}

// Classify one upstream bundle against a patch's anchors.
//
// `original`: sha256(source) equals the reviewed original anchor.
// `patched`: the exact reviewed patched output (every patched marker once and
//            reverse-restoring yields the reviewed original sha).
// `unknown`: anything else -- setup fails closed on this status.
export function classifyAnchorFile({ source, originalSha256, replacements = [] }) {
  const actualSha256 = sha256Text(source);
  const patchedCounts = replacements.map(([, patched]) => countOccurrences(source, patched));
  const restoredSha256 = sha256Text(restoreOriginal(source, replacements));
  const originalHit = actualSha256 === originalSha256;
  const patchedHit = replacements.length > 0
    && patchedCounts.every(count => count === 1)
    && restoredSha256 === originalSha256;
  let status = ANCHOR_STATUS.UNKNOWN;
  if (originalHit) status = ANCHOR_STATUS.ORIGINAL;
  else if (patchedHit) status = ANCHOR_STATUS.PATCHED;
  return { status, actualSha256, originalSha256, restoredSha256, patchedCounts };
}

export function anchorStates(source, replacements) {
  return replacements.map(([original, patched], index) => ({
    index,
    originalCount: countOccurrences(source, original),
    patchedCount: countOccurrences(source, patched),
  }));
}

// Decide whether the current file can safely be adopted as the new upstream
// original. Only a pristine file (no patched markers, every reviewed original
// anchor present exactly once, patch post-conditions hold) qualifies -- a
// partially patched or edited file must be reviewed by hand.
export function planOriginalAcceptance({ source, replacements = [] }) {
  const patchedCounts = replacements.map(([, patched]) => countOccurrences(source, patched));
  if (patchedCounts.some(count => count > 0)) {
    return {
      ok: false,
      code: 'PATCHED-MARKER-PRESENT',
      message: 'file carries patched markers but is not the exact reviewed patched output; refusing to adopt it as a pristine upstream original',
    };
  }
  const originalCounts = replacements.map(([original]) => countOccurrences(source, original));
  for (let index = 0; index < originalCounts.length; index++) {
    if (originalCounts[index] !== 1) {
      return {
        ok: false,
        code: 'ANCHOR-TEXT-DRIFT',
        index,
        count: originalCounts[index],
        message: `original anchor #${index + 1} occurs ${originalCounts[index]} time(s), expected exactly 1`,
      };
    }
  }
  const applied = applyReplacements(source, replacements);
  if (!applied.ok) {
    return { ok: false, code: applied.code, index: applied.index, message: 'patch post-condition failed on the current file' };
  }
  return { ok: true, patchedSha256: sha256Text(applied.patched) };
}

// Line-level diff (LCS over lines). Returns ops with both line numbers plus
// added/removed counts, so callers can print "which lines changed" without
// keeping a copy of the upstream baseline in the repo.
export function diffLines(expectedText, actualText) {
  const expected = splitLines(expectedText);
  const actual = splitLines(actualText);
  let prefix = 0;
  const shared = Math.min(expected.length, actual.length);
  while (prefix < shared && expected[prefix] === actual[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shared - prefix
    && expected[expected.length - 1 - suffix] === actual[actual.length - 1 - suffix]) suffix++;
  const expectedMiddle = expected.slice(prefix, expected.length - suffix);
  const actualMiddle = actual.slice(prefix, actual.length - suffix);
  const cells = (expectedMiddle.length + 1) * (actualMiddle.length + 1);
  const coarse = cells > 4_000_000;
  const ops = [];
  for (let index = 0; index < prefix; index++) {
    ops.push({ kind: 'same', expectedLine: index + 1, actualLine: index + 1, text: expected[index] });
  }
  ops.push(...(coarse ? coarseOps(expectedMiddle, actualMiddle, prefix) : diffMiddle(expectedMiddle, actualMiddle, prefix)));
  for (let index = expected.length - suffix; index < expected.length; index++) {
    const offset = index - (expected.length - suffix);
    ops.push({ kind: 'same', expectedLine: index + 1, actualLine: actual.length - suffix + offset + 1, text: expected[index] });
  }
  const added = ops.filter(op => op.kind === 'add').length;
  const removed = ops.filter(op => op.kind === 'remove').length;
  return { ops, added, removed, coarse };
}

function diffMiddle(expected, actual, offset) {
  const rows = expected.length;
  const columns = actual.length;
  if (rows === 0) return actual.map((text, index) => ({ kind: 'add', actualLine: offset + index + 1, text }));
  if (columns === 0) return expected.map((text, index) => ({ kind: 'remove', expectedLine: offset + index + 1, text }));
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row * width + column] = expected[row] === actual[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }
  const ops = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (expected[row] === actual[column]) {
      ops.push({ kind: 'same', expectedLine: offset + row + 1, actualLine: offset + column + 1, text: expected[row] });
      row++;
      column++;
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      ops.push({ kind: 'remove', expectedLine: offset + row + 1, text: expected[row] });
      row++;
    } else {
      ops.push({ kind: 'add', actualLine: offset + column + 1, text: actual[column] });
      column++;
    }
  }
  while (row < rows) {
    ops.push({ kind: 'remove', expectedLine: offset + row + 1, text: expected[row] });
    row++;
  }
  while (column < columns) {
    ops.push({ kind: 'add', actualLine: offset + column + 1, text: actual[column] });
    column++;
  }
  return ops;
}

function coarseOps(expected, actual, offset) {
  return [
    ...expected.map((text, index) => ({ kind: 'remove', expectedLine: offset + index + 1, text })),
    ...actual.map((text, index) => ({ kind: 'add', actualLine: offset + index + 1, text })),
  ];
}

// Render diff hunks with both line numbers, e.g.
//   - 12 | expected upstream line
//   + 12 | current upstream line
export function formatDiffHunks(diff, { context = 2, maxChangedLines = 60, maxHunks = 6, linePrefix = '' } = {}) {
  const { ops } = diff;
  const changed = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'same') changed.push(index);
  });
  if (changed.length === 0) return [`${linePrefix}(no line-level difference)`];
  const groups = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last.end <= context * 2 + 1) last.end = index;
    else groups.push({ start: index, end: index });
  }
  const lines = [];
  let emitted = 0;
  let truncated = false;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    if (groupIndex >= maxHunks) {
      truncated = true;
      break;
    }
    const group = groups[groupIndex];
    const start = Math.max(0, group.start - context);
    const end = Math.min(ops.length - 1, group.end + context);
    const head = ops[start];
    const headActual = ops.slice(start, end + 1).find(op => typeof op.actualLine === 'number')?.actualLine ?? '-';
    lines.push(`${linePrefix}@@ expected:${head.expectedLine ?? '-'} upstream:${headActual}`);
    for (let index = start; index <= end; index++) {
      const op = ops[index];
      if (op.kind === 'same') {
        lines.push(`${linePrefix}  ${op.actualLine} | ${op.text}`);
      } else if (op.kind === 'remove') {
        if (emitted >= maxChangedLines) {
          truncated = true;
          continue;
        }
        lines.push(`${linePrefix}- ${op.expectedLine} | ${op.text}`);
        emitted++;
      } else {
        if (emitted >= maxChangedLines) {
          truncated = true;
          continue;
        }
        lines.push(`${linePrefix}+ ${op.actualLine} | ${op.text}`);
        emitted++;
      }
    }
  }
  if (truncated) lines.push(`${linePrefix}... diff truncated (${changed.length} changed line(s) in total)`);
  return lines;
}

// Locate the region in `sourceText` that most resembles a missing anchor text.
// Returns { startLine, endLine, lines, similarity, exact, approximate } or null.
export function findAnchorWindow(sourceText, anchorText) {
  const anchorLines = splitLines(anchorText);
  if (anchorLines.length === 0) return null;
  const exactIndex = sourceText.indexOf(anchorText);
  if (exactIndex !== -1) {
    const startLine = lineNumberAt(sourceText, exactIndex);
    return { startLine, endLine: startLine + anchorLines.length - 1, lines: anchorLines, similarity: 1, exact: true, approximate: false };
  }
  const sourceLines = splitLines(sourceText);
  const lengths = [...new Set([anchorLines.length, Math.max(1, anchorLines.length - 1), anchorLines.length + 1])];
  const best = bestWindow(anchorLines, sourceLines, lengths, windowSimilarity);
  if (best !== null && best.similarity > 0) {
    return toWindow(best, false);
  }
  // The anchor line itself was rewritten upstream: fall back to token overlap
  // so the tool can still point at the closest region.
  const approximate = bestWindow(anchorLines, sourceLines, lengths, windowTokenSimilarity);
  if (approximate === null || approximate.similarity < 0.2) return null;
  return toWindow(approximate, true);
}

function toWindow(best, approximate) {
  return {
    startLine: best.start + 1,
    endLine: best.start + best.windowLines.length,
    lines: best.windowLines,
    similarity: best.similarity,
    exact: false,
    approximate,
  };
}

function bestWindow(anchorLines, sourceLines, lengths, score) {
  let best = null;
  for (const windowLength of lengths) {
    for (let start = 0; start + windowLength <= sourceLines.length; start++) {
      const windowLines = sourceLines.slice(start, start + windowLength);
      const similarity = score(anchorLines, windowLines);
      if (best === null || similarity > best.similarity + 1e-9
        || (Math.abs(similarity - best.similarity) <= 1e-9 && Math.abs(windowLength - anchorLines.length) < Math.abs(best.windowLines.length - anchorLines.length))) {
        best = { start, windowLines, similarity };
      }
    }
  }
  return best;
}

function windowSimilarity(anchorLines, windowLines) {
  const used = new Set();
  let matched = 0;
  for (const anchorLine of anchorLines) {
    const key = anchorLine.trim();
    if (key === '') continue;
    for (let index = 0; index < windowLines.length; index++) {
      if (used.has(index)) continue;
      if (windowLines[index].trim() === key) {
        used.add(index);
        matched++;
        break;
      }
    }
  }
  return matched / Math.max(anchorLines.length, windowLines.length);
}

function tokenize(text) {
  return [...new Set(text.split(/[^A-Za-z0-9_$]+/).filter(Boolean))];
}

function windowTokenSimilarity(anchorLines, windowLines) {
  const anchorTokens = tokenize(anchorLines.join('\n'));
  const windowTokens = new Set(tokenize(windowLines.join('\n')));
  if (anchorTokens.length === 0 || windowTokens.size === 0) return 0;
  let shared = 0;
  for (const token of anchorTokens) if (windowTokens.has(token)) shared++;
  return shared / anchorTokens.length;
}

