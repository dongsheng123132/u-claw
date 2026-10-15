// copy-dir.mjs — 安全的同步递归目录复制。
//
// 为什么不用 fs.cpSync：在 Windows + Node 22.23.2 实测，cpSync 复制中等大小
// 目录（如 extensions/uclaw-wallet，9 个文件两层目录）会触发
// STATUS_STACK_BUFFER_OVERRUN（0xC0000409）进程级崩溃；复制更小的目录则正常。
// 该崩溃会直接打穿启动迁移（prepare-wallet.mjs），导致 U 盘插上后「钱包插件装不上」。
// 本模块用 readdirSync + copyFileSync 逐个复制，绕开 cpSync 内部实现。
//
// 语义对齐 cpSync({ recursive: true, force: true })：目标目录先建，文件覆盖写，
// 符号链接按「复制链接本身」处理（与 cpSync 默认 dereference=false 一致）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 同步递归复制 src 目录到 dest 目录（dest 不存在则创建）。
 * 目录项逐条处理：目录递归、普通文件 copyFileSync、符号链接复刻为链接。
 */
export function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      try {
        fs.symlinkSync(target, destPath, fs.lstatSync(srcPath).isDirectory() ? 'junction' : 'file');
      } catch {
        // 目标已存在且是链接/文件时覆盖：先删再建。
        fs.rmSync(destPath, { force: true });
        fs.symlinkSync(target, destPath, fs.lstatSync(srcPath).isDirectory() ? 'junction' : 'file');
      }
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
