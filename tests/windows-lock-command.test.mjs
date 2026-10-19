import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

test('Windows batch lock command acquires once and reuses the live owner on a second launch', {skip:process.platform!=='win32'}, () => {
  const repo=fileURLToPath(new URL('..',import.meta.url));
  const source=readFileSync(join(repo,'portable','Windows-Start.bat'),'utf8');
  const command=source.split(/\r?\n/).find(line=>line.includes('portable-instance-lock.mjs" acquire'));
  assert.ok(command,'launcher must have an acquire command');

  // cmd.exe 以 OEM code page 读取含中文的绝对路径会把 UTF-8 误读成乱码。
  // 测试只验证真实 FOR /F 语句，因此把启动器与锁定模块复制到 ASCII 临时目录，
  // 不把这段测试用的 code-page 问题误归到产品脚本或改变测试内容。
  const root=mkdtempSync(join(tmpdir(),'uclaw lock command '));
  const fixtureRepo=join(root,'ascii-portable');
  const fixtureRoot=join(fixtureRepo,'portable');
  cpSync(join(repo,'portable','lib'),join(fixtureRoot,'lib'),{recursive:true});
  writeFileSync(join(fixtureRoot,'Windows-Start.bat'),source);
  const bat=join(root,'check.bat');
  writeFileSync(bat,[
    '@echo off',
    'chcp 65001 >nul 2>&1',
    `set "NODE_BIN=${process.execPath}"`,
    `set "UCLAW_DIR=${fixtureRoot}\\"`,
    `set "INSTANCE_ROOT=${root}"`,
    `set "STATE_DIR=${root}"`,
    `set "UCLAW_LAUNCHER_PID=${process.pid}"`,
    command,
    'echo LOCK_RESULT=%%a',
    'echo LOCK_VALUE=%%b',
    ')',
  ].join('\r\n'));
  try {
    const run=()=>{
      const result=spawnSync(process.env.ComSpec||'cmd.exe',['/d','/c',bat],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.ifError(result.error);
      assert.equal(result.status,0,result.stderr);
      return result.stdout;
    };
    assert.match(run(),/LOCK_VALUE=acquired/);
    assert.match(run(),/LOCK_VALUE=existing/);
    const owner=JSON.parse(readFileSync(join(root,'launcher-instance.lock','owner.json'),'utf8'));
    assert.equal(owner.pid,process.pid);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
