// atomic-file.mjs — 原子写文本文件
//
// 移植自 v2/u-dsh/src/atomic-file.js。存在的理由：v3 有若干"写坏了就毁一天"的小文件
// （active.json 激活指针、device-wallet.json 钱包五字段、uclaw-settings.json 配置）。
// 半截写入的 JSON 比没有这个文件更糟——前者会被解析器当成"存在但损坏"。
//
// 手法：同目录临时文件 → 写完 → rename。rename 在同一文件系统内是原子的；
// 跨盘不原子，所以临时文件必须和目标同目录（不能图省事丢 tmpdir）。
//
// mode 0o600：钱包凭证会走这个函数，别让同机其它用户读到。
// （Windows 上 mode 基本无效，真正的边界是用户目录 ACL；Mac/Linux 上有效。）

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readTextIfExists(filename) {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readJsonIfExists(filename) {
  const text = await readTextIfExists(filename);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // 损坏的 JSON 退化成"还没有"，由调用方决定是重建还是保留现场。
    // 不在这里抛：启动路径上抛异常就是一个白屏。
    return undefined;
  }
}

export async function writeTextAtomic(filename, text) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(filename, value) {
  await writeTextAtomic(filename, `${JSON.stringify(value, null, 2)}\n`);
}
