// 旧渠道路由已移除；配置服务仅提供本地模型和设备钱包。
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url));
test('配置页保留钱包和充值，不内置聊天平台入口（自定义 OpenAI 兼容入口保留）',()=>{
  for(const file of ['portable/Config.html','portable/config-server/public/index.html']){
    const page=readFileSync(join(root,file),'utf8');
    assert.doesNotMatch(page,/telegram|feishu|wechat|weixin|qqbot|channel-card|toggleChannel|discoverLocalModels/i);
    assert.match(page,/walletRecharge\(/);assert.match(page,/一键充值/);
  }
});
test('真实配置服务：旧渠道404，遗留密钥脱敏，钱包状态目录隔离',async()=>{
  const state=mkdtempSync(join(tmpdir(),'uclaw-no-channels-'));
  const cfg=join(state,'openclaw.json'),key='sk-isolated-test-only-key';
  writeFileSync(cfg,JSON.stringify({models:{providers:{'uclaw-cloud':{apiKey:key}}},env:{OTHER_API_KEY:'test-only-env-secret'}}));
  const port=18931,child=spawn(process.execPath,[join(root,'portable/config-server/server.js')],{env:{...process.env,OPENCLAW_HOME:state,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:cfg,UCLAW_CONFIG_PORT:String(port)},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='';child.stdout.on('data',c=>out+=c);
  try{
    for(let i=0;i<70&&!out.includes('127.0.0.1:'+port);i++)await new Promise(r=>setTimeout(r,100));
    assert.ok(out.includes('127.0.0.1:'+port),'isolated server did not start');
    for(const [route,method] of [['/api/wechat/start','POST'],['/api/wechat/status?session=test','GET'],['/api/wechat/cancel','POST'],['/api/wechat/plugin-status','GET'],['/api/local-models','GET'],['/api/provider-models','POST']])assert.equal((await fetch('http://127.0.0.1:'+port+route,{method})).status,404,route);
    const text=await(await fetch('http://127.0.0.1:'+port+'/api/config')).text();
    assert.ok(!text.includes(key));assert.ok(!text.includes('test-only-env-secret'));
    assert.deepEqual(JSON.parse(text).models.providers['uclaw-cloud'].apiKey,{source:'saved',id:'uclaw-cloud'});
    assert.ok(readFileSync(cfg,'utf8').includes(key),'GET must not modify saved key');
    const wallet=await(await fetch('http://127.0.0.1:'+port+'/api/wallet/status')).json();
    assert.equal(wallet.hasWallet,true,'旧模型密钥在当前测试目录恢复钱包');
    assert.equal(wallet.apiKey,key);
    assert.equal(JSON.parse(readFileSync(join(state,'uclaw-device.json'),'utf8')).apiKey,key);
  }finally{const exited=once(child,'exit');child.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);rmSync(state,{recursive:true,force:true});}
});
