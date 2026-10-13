import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, readFile, rm, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectAgentSchemas,upgradeSessionSchema} from '../portable/lib/upgrade-session-schema.mjs';

async function fixture(t,version) {
  const root=await mkdtemp(join(tmpdir(),'uclaw-schema-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const state=join(root,'data/.openclaw'),agent=join(state,'agents/main/agent');
  await mkdir(agent,{recursive:true});
  await writeFile(join(state,'openclaw.json'),'{"gateway":{"mode":"local"}}');
  const file=join(agent,'openclaw-agent.sqlite');
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA user_version=${version}; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep this session');`);
  db.close();
  return {root,state,file};
}
test('fresh state needs no doctor or migration writes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'uclaw-new-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.deepEqual(await upgradeSessionSchema(root,()=>assert.fail('doctor called')), {upgraded:false});
  assert.deepEqual(await readdir(root),[]);
});
test('current schema skips doctor',async t=>{
  const {root}=await fixture(t,24);
  assert.deepEqual(await upgradeSessionSchema(root,()=>assert.fail('doctor called')), {upgraded:false});
});
test('newer saved state rejects downgrade',async t=>{
  const {root}=await fixture(t,25);
  await assert.rejects(upgradeSessionSchema(root,()=>assert.fail('doctor called')),/newer OpenClaw/);
});
test('migration backs up committed SQLite and config before doctor, then checks result',async t=>{
  const {root,state,file}=await fixture(t,19);
  const result=await upgradeSessionSchema(root,async()=>{
    const backups=await readdir(join(root,'data/backups'));
    const saved=join(root,'data/backups',backups[0]);
    assert.equal(await readFile(join(saved,'openclaw.json'),'utf8'),await readFile(join(state,'openclaw.json'),'utf8'));
    const snapshot=new DatabaseSync(join(saved,'database-0.sqlite'),{readOnly:true});
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,19);
    assert.equal(snapshot.prepare('SELECT value FROM preserved').get().value,'keep this session');snapshot.close();
    const db=new DatabaseSync(file);db.exec('PRAGMA user_version=24');db.close();
  });
  assert.equal(result.upgraded,true);
  assert.equal((await inspectAgentSchemas(state))[0].version,24);
});
test('failed or incomplete doctor never reports success and retains backup',async t=>{
  const {root}=await fixture(t,19);
  await assert.rejects(upgradeSessionSchema(root,async()=>{throw Error('fixture failed');}),/fixture failed/);
  await assert.rejects(upgradeSessionSchema(root,async()=>{}),/incomplete/);
  assert.equal((await readdir(join(root,'data/backups'))).length,2);
});
