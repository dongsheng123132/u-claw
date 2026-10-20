import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
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
  // Run the actual FOR /F statement through cmd.exe. Text matching alone did
  // not catch the missing outer quotes that silently disabled the real guard.
  const root=mkdtempSync(join(tmpdir(),'uclaw lock command '));
  const bat=join(root,'check.bat');
  writeFileSync(bat,[
    '@echo off',
    `set "NODE_BIN=${process.execPath}"`,
    `set "UCLAW_DIR=${join(repo,'portable')}\\"`,
    `set "INSTANCE_ROOT=${root}"`,
    `set "STATE_DIR=${root}"`,
    `set "UCLAW_LAUNCHER_PID=${process.pid}"`,
    command,
    'echo LOCK_RESULT=%%a',
    'echo LOCK_VALUE=%%b',
    ')',
  ].join('\r\n'));
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
});
