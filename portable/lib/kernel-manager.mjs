// kernel-manager.mjs — 把 Node 和 OpenClaw 内核装到本机（影核动作 runtime.seed / install / activate / gc）
//
// 移植自 v2/u-dsh/src/kernel-manager.js，三处刻意的改动：
//
//   1. 加了**离线 seed 路径**（u-dsh 没有，它首次运行必须联网下载）。
//      U-Claw 当前 release 的承诺就是"解压即用、零网络依赖"，1543 次下载是冲这句来的。
//      客户常在网差甚至没网的现场装机，照抄 u-dsh 等于撕这句承诺。
//      seed 是**装好的整棵树**，不是 npm tarball —— openclaw 有 58 个依赖，
//      npm pack 出来的包不含它们，装它照样要联网。
//
//   2. 砍掉了 peer 依赖收敛循环。u-dsh 需要它是因为 DSH 有必需 peer；
//      openclaw 的 peerDependencies 是空的，那 80 行搬过来就是死代码。
//
//   3. 装完不自动切换。新内核先落地、验证、再由调用方 activate()；
//      启动失败时 active.json 里还指着上一版，回退不需要重装。
//
// 所有写入都走"临时目录 → 校验 → 原子改名"，中途断电/拔盘留下的是一个
// .install-* 垃圾目录，不是一个半截的内核（下次安装会先清掉同前缀的残留）。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, readJsonIfExists } from './atomic-file.mjs';
import { nodeDownloadUrls } from './runtime-channel.mjs';
import { kernelRoot } from './runtime-paths.mjs';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/;

// ── 小工具 ──────────────────────────────────────────────────────────────────

// 拒绝在内核目录之外做删除/改名。路径拼错时宁可报错，也不要 rm -rf 到别人家里。
function assertChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`拒绝操作目录之外的路径：${candidate}`);
  }
}

/**
 * purge 是全仓库唯一一个会 rm -rf 整棵树的动作，所以边界写死在这里，
 * 而不是散在调用方。任何一条不满足就拒绝执行 —— 路径算错时宁可报错不干活，
 * 也绝不能把客户的盘删了（宪法 #6、#10）。
 */
function assertSafePurgeTarget(target, paths) {
  const resolved = path.resolve(String(target || ''));

  // 1. 不许是盘符根 / 文件系统根。path.dirname 到了根会返回自己。
  if (path.dirname(resolved) === resolved) {
    throw new Error(`拒绝清理文件系统根：${resolved}`);
  }

  // 2. 目录名必须是我们自己造的那两个之一。挡住 hostRoot 被配错成
  //    %LOCALAPPDATA% 本身（那一删，客户整个 AppData\Local 就没了）。
  const name = path.basename(resolved);
  const slotName = path.basename(path.resolve(paths.slotDir));
  if (name !== 'U-Claw' && name !== 'host' && name !== slotName) {
    throw new Error(`拒绝清理不像 U-Claw 本机目录的路径：${resolved}`);
  }

  // 3. 用户数据一根汗毛都不许动。portable-strict 下 hostRoot 在 U 盘上
  //    （<usb>/host），和 <usb>/data 是兄弟；但只要哪天路径算错让 data
  //    落进了删除范围，这里必须拦住 —— 钱包和会话删了没法重建。
  for (const key of ['dataDir', 'stateDir', 'uclawStateDir', 'vendorDir']) {
    const guarded = paths[key];
    if (!guarded) continue;
    const full = path.resolve(guarded);
    const relative = path.relative(resolved, full);
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (inside) {
      throw new Error(`拒绝执行：清理范围 ${resolved} 会连带删除用户数据 ${full}`);
    }
  }
}

function run(command, args, { timeoutMs = 8 * 60_000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`${path.basename(command)} 退出码 ${code ?? 'unknown'}：${stderr.slice(-1200)}`));
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`${path.basename(command)} 超过 ${Math.ceil(timeoutMs / 1000)} 秒未完成`));
    }, timeoutMs);
  });
}

async function sha256(filename) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filename)
      .on('data', (chunk) => hash.update(chunk))
      .once('end', resolve)
      .once('error', reject);
  });
  return hash.digest('hex');
}

async function download(url, destination, { fetchImpl, onProgress, phase }) {
  const partial = `${destination}.${process.pid}.partial`;
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let lastPercent = -1;
  const handle = await open(partial, 'w');
  let failure;
  try {
    for await (const chunk of response.body) {
      await handle.write(chunk);
      received += chunk.byteLength;
      const percent = total > 0 ? Math.floor((received / total) * 100) : -1;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress({ phase, received, total, percent });
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    await handle.close();
  }
  if (failure) {
    await rm(partial, { force: true });
    throw failure;
  }
  await rename(partial, destination);
}

/**
 * Windows 上必须点名系统自带的 bsdtar，不能只写 "tar"。
 * 客户机（和我们的 Git Bash 开发机）PATH 上常有 GNU tar，它把 `C:\...` 里的冒号
 * 当成 host:path 的分隔符，直接报 "Cannot connect to C: resolve failed"。
 * %SystemRoot%\System32\tar.exe 是 Win10 1803+ 自带的 bsdtar，认盘符。
 */
export function tarBinary(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const bsdtar = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(bsdtar)) return bsdtar;
  }
  return 'tar';
}

// zip 走 PowerShell（Windows 自带），tar.gz 走 tar（Win10+ / mac / linux 都有）。
async function extractArchive(archive, destination, { runner, platform }) {
  await mkdir(destination, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    if (platform === 'win32') {
      await runner('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:UCLAW_ARCHIVE -DestinationPath $env:UCLAW_DEST -Force',
      ], { env: { ...process.env, UCLAW_ARCHIVE: archive, UCLAW_DEST: destination }, timeoutMs: 10 * 60_000 });
      return;
    }
    await runner('unzip', ['-q', '-o', archive, '-d', destination], { timeoutMs: 10 * 60_000 });
    return;
  }
  if (/\.tar\.gz$|\.tgz$/i.test(archive)) {
    await runner(tarBinary(platform), ['-xzf', archive, '-C', destination], { timeoutMs: 10 * 60_000 });
    return;
  }
  throw new Error(`不认识的压缩包格式：${path.basename(archive)}`);
}

// 清掉上次中断留下的 .install-* 暂存目录。
async function removeStaging(parent, prefix) {
  let entries = [];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.join(parent, entry.name);
    assertChild(parent, target);
    await rm(target, { recursive: true, force: true });
  }
}

// 压缩包解出来可能多一层目录（Node 官方包就是 node-v22.22.1-win-x64/）。
// 找到"真正的根"：要么 staging 本身有标志文件，要么它唯一的子目录有。
async function locateRoot(staging, marker) {
  if (existsSync(path.join(staging, marker))) return staging;
  const entries = await readdir(staging, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  for (const dir of dirs) {
    const candidate = path.join(staging, dir.name);
    if (existsSync(path.join(candidate, marker))) return candidate;
  }
  throw new Error(`压缩包结构不符：找不到 ${marker}`);
}

// ── 主体 ────────────────────────────────────────────────────────────────────

export function createKernelManager({
  paths,
  channel,
  fetchImpl = fetch,
  runner = run,
  platform = process.platform,
} = {}) {
  if (!paths || !channel) throw new Error('paths 和 channel 是必填项');
  const target = channel.node.target;
  if (!target) throw new Error('版本通道里没有当前平台的 Node 目标');

  const nodeHome = paths.nodeHome;
  const nodeExecutable = path.join(nodeHome, target.nodeRelativePath);
  const npmCli = path.join(nodeHome, target.npmCliRelativePath);

  // ── Node ──────────────────────────────────────────────────────────────

  function nodeInstalled() {
    return existsSync(nodeExecutable) && existsSync(npmCli);
  }

  async function stageNodeArchive(archive, onProgress) {
    if (await sha256(archive) !== target.sha256) {
      throw new Error(`Node 压缩包 SHA-256 校验失败：${path.basename(archive)}`);
    }
    await removeStaging(paths.runtimeDir, '.install-node-');
    const staging = path.join(paths.runtimeDir, `.install-node-${process.pid}-${Date.now()}`);
    assertChild(paths.runtimeDir, staging);
    try {
      onProgress({ phase: 'extracting-node' });
      await extractArchive(archive, staging, { runner, platform });
      const extracted = await locateRoot(staging, target.nodeRelativePath);
      if (!existsSync(path.join(extracted, target.npmCliRelativePath))) {
        throw new Error('Node 压缩包里没有 npm，结构校验失败');
      }
      if (existsSync(nodeHome)) {
        assertChild(paths.runtimeDir, nodeHome);
        await rm(nodeHome, { recursive: true, force: true });
      }
      await rename(extracted, nodeHome);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 保证本机有可用的 Node。顺序：已装 → U 盘 seed → 网络下载。
   * seed 排在下载前面，就是为了守住"零网络依赖"。
   */
  async function ensureNode(onProgress = () => {}) {
    if (nodeInstalled()) return { nodeExecutable, npmCli, source: 'managed-shared', reused: true };

    await mkdir(paths.downloadsDir, { recursive: true });

    const seed = path.join(paths.vendorDir, target.archive);
    if (existsSync(seed)) {
      onProgress({ phase: 'seeding-node', from: seed });
      await stageNodeArchive(seed, onProgress);
      return { nodeExecutable, npmCli, source: 'usb-seed', reused: false };
    }

    const archive = path.join(paths.downloadsDir, target.archive);
    if (!existsSync(archive) || await sha256(archive) !== target.sha256) {
      await rm(archive, { force: true });
      const urls = nodeDownloadUrls(channel, paths.target);
      let lastError;
      for (const url of urls) {
        try {
          onProgress({ phase: 'downloading-node', url });
          await download(url, archive, { fetchImpl, onProgress, phase: 'downloading-node' });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
    await stageNodeArchive(archive, onProgress);
    return { nodeExecutable, npmCli, source: 'downloaded', reused: false };
  }

  // ── 内核 ──────────────────────────────────────────────────────────────

  async function validateKernelAt(root, version) {
    const packageRoot = path.join(root, 'node_modules', channel.kernel.package);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== channel.kernel.package || manifest.version !== version) {
      throw new Error(`内核身份校验失败：期望 ${channel.kernel.package}@${version}，实际 ${manifest.name}@${manifest.version}`);
    }
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[channel.kernel.package];
    if (!bin) throw new Error('内核没有声明 CLI 入口');
    const entry = path.resolve(packageRoot, bin);
    const relative = path.relative(packageRoot, entry);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(entry)) {
      throw new Error('内核 CLI 入口越界或不存在');
    }
    return { version, root, packageRoot, entry };
  }

  function resolveKernel(version) {
    if (!EXACT_VERSION.test(version)) throw new Error(`内核版本无效：${version}`);
    return validateKernelAt(kernelRoot(paths, version), version);
  }

  function kernelSeedArchive(version) {
    // seed 是**装好的整棵树**（含 node_modules），按平台打 —— openclaw 有
    // sqlite-vec 这类原生 optionalDependency，跨平台复用同一份树会炸。
    for (const extension of ['zip', 'tar.gz']) {
      const candidate = path.join(paths.vendorDir, `openclaw-${version}-${paths.target}.${extension}`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  async function installFromSeed(version, archive, onProgress) {
    await removeStaging(paths.kernelsDir, `.install-${version}-`);
    const staging = path.join(paths.kernelsDir, `.install-${version}-${process.pid}-${Date.now()}`);
    assertChild(paths.kernelsDir, staging);
    try {
      onProgress({ phase: 'seeding-kernel', version, from: archive });
      await extractArchive(archive, staging, { runner, platform });
      const extracted = await locateRoot(staging, path.join('node_modules', channel.kernel.package, 'package.json'));
      await validateKernelAt(extracted, version);
      const destination = kernelRoot(paths, version);
      if (existsSync(destination)) {
        assertChild(paths.kernelsDir, destination);
        await rm(destination, { recursive: true, force: true });
      }
      await rename(extracted, destination);
      return { ...(await resolveKernel(version)), source: 'usb-seed' };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function installFromRegistry(version, node, onProgress) {
    await removeStaging(paths.kernelsDir, `.install-${version}-`);
    const staging = path.join(paths.kernelsDir, `.install-${version}-${process.pid}-${Date.now()}`);
    assertChild(paths.kernelsDir, staging);
    await mkdir(staging, { recursive: true });
    try {
      await writeJsonAtomic(path.join(staging, 'package.json'), {
        name: 'u-claw-managed-kernel',
        version: '0.0.0',
        private: true,
        dependencies: { [channel.kernel.package]: version },
      });
      let lastError;
      for (const registry of channel.kernel.installRegistries) {
        onProgress({ phase: 'installing-kernel', version, registry });
        try {
          await runner(node.nodeExecutable, [
            node.npmCli, 'install',
            '--no-audit', '--no-fund', '--prefer-offline',
            '--maxsockets=6', '--fetch-retries=2', '--fetch-timeout=60000',
            `--registry=${registry}`,
          ], {
            cwd: staging,
            timeoutMs: 8 * 60_000,
            env: {
              ...process.env,
              npm_config_cache: paths.npmCacheDir,
              npm_config_update_notifier: 'false',
            },
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await rm(path.join(staging, 'node_modules'), { recursive: true, force: true });
          await rm(path.join(staging, 'package-lock.json'), { force: true });
        }
      }
      if (lastError) throw lastError;

      await validateKernelAt(staging, version);
      const destination = kernelRoot(paths, version);
      if (existsSync(destination)) {
        assertChild(paths.kernelsDir, destination);
        await rm(destination, { recursive: true, force: true });
      }
      await rename(staging, destination);
      return { ...(await resolveKernel(version)), source: 'registry' };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  /** 保证某个版本的内核在本机装好。顺序：已装 → U 盘 seed → 网络。不切换激活指针。 */
  async function installKernel(version = channel.kernel.version, onProgress = () => {}) {
    if (!EXACT_VERSION.test(version)) throw new Error(`内核版本无效：${version}`);
    try {
      return { ...(await resolveKernel(version)), source: 'managed-shared', reused: true };
    } catch {
      // 没装或装坏了，继续走安装。
    }
    const seed = kernelSeedArchive(version);
    if (seed) return await installFromSeed(version, seed, onProgress);
    const node = await ensureNode(onProgress);
    return await installFromRegistry(version, node, onProgress);
  }

  // ── 激活指针 ──────────────────────────────────────────────────────────

  async function activeState() {
    return (await readJsonIfExists(paths.activeKernelFile)) ?? null;
  }

  async function activeVersion() {
    const state = await activeState();
    return EXACT_VERSION.test(state?.version || '') ? state.version : null;
  }

  /** 切激活指针。先验证目标真的可用，再写——写完才发现装坏了就没法回退了。 */
  async function activate(version, { source = 'manual' } = {}) {
    const resolved = await resolveKernel(version);
    const previous = await activeVersion();
    await writeJsonAtomic(paths.activeKernelFile, {
      schemaVersion: 1,
      version,
      previous: previous && previous !== version ? previous : (await activeState())?.previous ?? null,
      source,
      updatedAt: new Date().toISOString(),
    });
    return { ...resolved, previous };
  }

  /** 回退到上一版。新内核起不来时用，不需要重装——旧版本还在盘上。 */
  async function rollback() {
    const state = await activeState();
    const previous = state?.previous;
    if (!previous || !EXACT_VERSION.test(previous)) {
      throw new Error('没有可回退的上一版内核');
    }
    return await activate(previous, { source: 'rollback' });
  }

  // ── 汇总动作 ──────────────────────────────────────────────────────────

  /** 首启主流程：Node + 锁定版内核 + 激活。返回 previous 供调用方判断是不是升级。 */
  async function ensure(onProgress = () => {}) {
    const node = await ensureNode(onProgress);
    const previous = await activeVersion();
    const kernel = await installKernel(channel.kernel.version, onProgress);
    const activated = await activate(channel.kernel.version, { source: kernel.source });
    return { node, kernel, previous, active: activated.version };
  }

  async function listInstalled() {
    let names = [];
    try {
      names = await readdir(paths.kernelsDir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return [];
    }
    const valid = [];
    for (const version of names.filter((name) => EXACT_VERSION.test(name))) {
      try {
        valid.push(await resolveKernel(version));
      } catch {
        // 装到一半被打断的目录，listInstalled 里不报，gc 会清。
      }
    }
    return valid;
  }

  async function directorySize(root) {
    let total = 0;
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          try { total += (await stat(full)).size; } catch { /* 文件刚被删，忽略 */ }
        }
      }
    };
    await walk(root);
    return total;
  }

  /**
   * 清理旧内核。默认保留：当前激活的、上一版、通道锁定的。
   * 每台插过 U 盘的电脑会留约 1 GB，不给清理入口就是在塞满客户的 C 盘。
   */
  async function gc({ dryRun = false } = {}) {
    const state = await activeState();
    const keep = new Set([state?.version, state?.previous, channel.kernel.version].filter(Boolean));
    const installed = await listInstalled();
    const removable = installed.filter((entry) => !keep.has(entry.version));
    const removed = [];
    for (const entry of removable) {
      const size = await directorySize(entry.root);
      if (!dryRun) {
        assertChild(paths.kernelsDir, entry.root);
        await rm(entry.root, { recursive: true, force: true });
      }
      removed.push({ version: entry.version, bytes: size });
    }
    // 顺手清掉中断留下的暂存目录，它们不在 listInstalled 里但一样占地方。
    if (!dryRun) await removeStaging(paths.kernelsDir, '.install-');
    return { kept: [...keep], removed, dryRun };
  }

  /**
   * 把这台机器上的本机残留整个删掉（影核动作 runtime.host.purge）。
   *
   * 「留东西」可以接受，「留了还删不掉」不可以 —— 这是发版硬约束。
   * 客户借的电脑、公司管控机、网吧，都得能一键还干净。
   *
   * scope:
   *   'all'  （默认）整个 <hostRoot>：共享的 Node/内核/npm 缓存 + 所有 U 盘的槽位
   *   'slot' 只删当前这支 U 盘的槽位（浏览器 profile / 编译缓存 / 日志 / 锁），
   *          共享的 Node 和内核留着 —— 同一台机还插着别的 U 盘时用这个
   *
   * **绝不碰 U 盘上的第 1 层数据**（openclaw.json / 会话 / 钱包）。
   * portable-strict 模式下 hostRoot 本身就在 U 盘上（<usb>/host），
   * 那也照删不误 —— 它装的仍然只是可重建的东西；但 <usb>/data 一根汗毛都不许动。
   */
  async function hostPurge({ dryRun = false, scope = 'all' } = {}) {
    if (scope !== 'all' && scope !== 'slot') {
      throw new Error(`未知的清理范围：${scope}（只接受 all / slot）`);
    }
    const target = scope === 'all' ? paths.hostRoot : paths.slotDir;
    assertSafePurgeTarget(target, paths);

    if (!existsSync(target)) {
      return { scope, target, existed: false, freedBytes: 0, dryRun };
    }
    const freedBytes = await directorySize(target);
    if (!dryRun) await rm(target, { recursive: true, force: true });
    return { scope, target, existed: true, freedBytes, dryRun };
  }

  async function status() {
    const installed = await listInstalled();
    return {
      nodeReady: nodeInstalled(),
      nodeVersion: channel.node.version,
      nodeHome,
      pinnedVersion: channel.kernel.version,
      activeVersion: await activeVersion(),
      installedVersions: installed.map(({ version }) => version),
      sharedDir: paths.sharedDir,
      vendorDir: paths.vendorDir,
    };
  }

  return {
    activate, activeVersion, ensure, ensureNode, gc, hostPurge,
    installKernel, listInstalled, resolveKernel, rollback, status,
    // 导出给测试用
    _internal: { validateKernelAt, kernelSeedArchive, locateRoot },
  };
}

export { EXACT_VERSION, assertSafePurgeTarget };
