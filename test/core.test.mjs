import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seal,unseal,passwordHash,verifyPassword } from '../server/crypto.mjs';
import { Store } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { configuration } from '../server/config.mjs';
import {trafficDisplay} from '../public/traffic.js';
import { JdLegacy,UpstreamError,parseJson,parseDevices,parseStatus,normalizeRate,signature } from '../server/jd.mjs';
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const point=(mac,today)=>({mac,todayPointIncome:today,allPointIncome:today*10});

test('AES-GCM detects tampering and binds ciphertext to its account',()=>{
  const key=randomBytes(32),cipher=seal({tgt:'fixture-secret-not-real'},key,'account-a');
  assert.equal(unseal(cipher,key,'account-a').tgt,'fixture-secret-not-real');
  assert.throws(()=>unseal(cipher,key,'account-b'));
  assert.throws(()=>unseal(cipher,randomBytes(32),'account-a'));
  const data=Buffer.from(cipher.slice(3),'base64url');data[30]^=1;
  assert.throws(()=>unseal('v1.'+data.toString('base64url'),key,'account-a'));
  assert.notEqual(seal({tgt:'fixture-secret-not-real'},key,'account-a'),cipher);
});
test('password verification uses salted scrypt',()=>{
  const hash=passwordHash('fixture-admin-password');
  assert.equal(verifyPassword('fixture-admin-password',hash),true);
  assert.equal(verifyPassword('wrong',hash),false);
});
test('official traffic conversion switches byte units and preserves missing values',()=>{
  assert.equal(normalizeRate('8192'),8388608);
  assert.deepEqual(trafficDisplay(normalizeRate('8192')),{value:1,unit:'MB/s'});
  assert.deepEqual(trafficDisplay(normalizeRate('8191')),{value:1023.875,unit:'KB/s'});
  assert.deepEqual(trafficDisplay(normalizeRate('0')),{value:0,unit:'KB/s'});
  assert.deepEqual(trafficDisplay(8*1024**3),{value:1,unit:'GB/s'});
  assert.equal(normalizeRate(''),null);assert.equal(normalizeRate(-1),null);
  assert.equal(normalizeRate('1e308'),null);assert.equal(trafficDisplay(null),null);
});
test('device parser preserves long string IDs and fails closed on unexpected shapes',()=>{
  const id='900719925474099312';assert.equal(parseDevices({result:[{list:[{feed_id:id,device_id:'FIXTURE',status:1}]}]})[0].id,id);
  assert.throws(()=>parseDevices({result:[{list:[{feed_id:Number(id),device_id:'FIXTURE'}]}]}));
  assert.throws(()=>parseDevices({result:{devices:[]}}));
  const wire='{"status":0,"result":[{"list":[{"feed_id":900719925474099312,"device_id":"FIXTURE","status":1}]}]}';
  assert.equal(parseDevices(parseJson(wire))[0].id,'900719925474099312');
  assert.equal(parseDevices({result:JSON.stringify(parseJson(wire).result)})[0].id,'900719925474099312');
  const s=parseStatus({result:JSON.stringify({streams:[{current_value:JSON.stringify({data:{upload:'123',download:'0',cpu:'30'}})}]})});
  assert.equal(s.uploadRaw,'123');assert.equal(s.uploadBps,125952);assert.equal(s.downloadBps,0);assert.equal(s.downloadRaw,'0');
  assert.throws(()=>parseStatus({result:{streams:[{current_value:{code:1,data:{upload:'123',download:'0'}}}]}}),e=>e.kind==='business_error');
});
test('signature follows a deterministic legacy timestamp including leap day',()=>{
  const s=signature('{}',new Date('2024-02-29T16:00:00.123Z'));
  assert.equal(s.timestamp,'2024-03-01 00:00:00');
  assert.match(s.Authorization,/:::2024-03-01T00:00:00\.123Z$/);
  assert.notEqual(s.Authorization,signature('{ }',new Date('2024-02-29T16:00:00.123Z')).Authorization);
});
test('earnings collects all pages and rejects duplicate or truncated data',async()=>{
  const requests=[];
  const provider=new JdLegacy(async url=>{
    requests.push(url);const page=Number(new URL(url).searchParams.get('currentPage'));
    return json({code:200,result:{pointInfos:[point('fixture-'+page,page)],pageInfo:{currentPage:page,totalPage:2,totalRecord:2}}});
  });
  const points=await provider.earnings({tgt:'fixture-secret'});assert.equal(points.length,2);assert.equal(points.reduce((n,p)=>n+p.today,0),3);assert.equal(requests.length,2);
  const bad=new JdLegacy(async()=>json({code:200,result:{pointInfos:[point('x',1)],pageInfo:{currentPage:1,totalPage:1,totalRecord:2}}}));
  await assert.rejects(()=>bad.earnings({tgt:'fixture-secret'}),e=>e.kind==='schema_changed');
});
test('403 is a permission denial, not an invented expiry code',async()=>{
  const provider=new JdLegacy(async()=>new Response('sensitive upstream data',{status:403}));
  await assert.rejects(()=>provider.list({tgt:'fixture-secret'}),e=>e.kind==='access_denied'&&!e.message.includes('sensitive'));
});
test('configuration refuses plaintext production origins and external development binding',()=>{
  const base={ENCRYPTION_KEY:randomBytes(32).toString('base64'),ADMIN_PASSWORD_HASH:passwordHash('fixture-admin-password')};
  assert.throws(()=>configuration({...base,NODE_ENV:'production',PUBLIC_ORIGIN:'http://example.com'}));
  assert.throws(()=>configuration({...base,HOST:'0.0.0.0'}));
  assert.throws(()=>configuration({...base,POLL_SECONDS:'4'}));
  assert.equal(configuration(base).pollSeconds,5);
});
test('HTTP flow protects credentials, enforces auth and CSRF, retains explicit failures, and deletes history',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'yunjian-test-'));const key=randomBytes(32),store=new Store(dir,key);
  const config={key,password:passwordHash('fixture-admin-password'),origin:'http://fixture.local',production:true,legacy:true,pollSeconds:60};
  let fail=false,listCalls=0;
  const provider={list:async()=>{listCalls++;return [{id:'device-1',mac:'FIXTURE',name:'test',online:true}];},collect:async()=>{if(fail)throw new UpstreamError('access_denied','平台拒绝访问。');return {devices:[{id:'device-1',uploadBps:null,downloadBps:null,uploadRaw:'8000',downloadRaw:'100',trafficUnit:'unknown'}],todayPoints:9,warnings:[]};}};
  const app=createApp(config,store,provider);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await Promise.allSettled([...app.jobs.values()]);await new Promise(r=>app.server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port;
  let cookie='',csrf='';
  const request=(path,{method='GET',data,origin='http://fixture.local',withCsrf=true}={})=>fetch(base+path,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),Origin:origin,Cookie:cookie,...(withCsrf?{'X-CSRF-Token':csrf}:{})},body:data?JSON.stringify(data):undefined});
  assert.equal((await request('/api/accounts')).status,401);
  assert.equal((await request('/api/login',{method:'POST',data:{password:'fixture-admin-password'},origin:'https://evil.example'})).status,403);
  const login=await request('/api/login',{method:'POST',data:{password:'fixture-admin-password'}});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict;.*Secure/);
  cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
  assert.equal((await request('/api/accounts',{method:'POST',data:{},withCsrf:false})).status,403);
  const added=await request('/api/accounts',{method:'POST',data:{label:'fixture-account',tgt:'fixture-TGT-must-stay-private'}});
  assert.equal(added.status,201);const {id}=await added.json();await Promise.all([...app.jobs.values()]);
  const text=await (await request('/api/accounts')).text();assert.ok(!text.includes('fixture-TGT'));assert.ok(!text.includes('credential'));assert.ok(text.includes('fixture-account'));
  assert.ok(!readFileSync(join(dir,'yunjian.sqlite')).includes(Buffer.from('fixture-TGT')));
  assert.equal(store.credential(id).tgt,'fixture-TGT-must-stay-private');
  const duplicate=await request('/api/accounts',{method:'POST',data:{label:'another-label',tgt:'fixture-TGT-must-stay-private'}});
  assert.equal(duplicate.status,200);
  assert.deepEqual(await duplicate.json(),{id,label:'fixture-account',existing:true,deviceCount:1});
  assert.equal(store.accounts().length,1);assert.equal(store.history(id).length,1);assert.equal(listCalls,1);
  const old=store.latest(id).at;fail=true;store.state(id,'ready',null,0);await app.refresh(id);
  assert.equal(store.account(id).state,'access_denied');assert.equal(store.latest(id).at,old);
  assert.equal((await request('/api/accounts/'+id+'/refresh',{method:'POST'})).status,429);
  const history=await (await request('/api/accounts/'+id+'/history')).json();assert.equal(history.history.length,1);
  // Historic samples keep their raw fields and are displayed with the verified conversion.
  assert.equal(history.history[0].devices[0].uploadBps,8192000);
  assert.equal(history.history[0].devices[0].downloadBps,102400);
  assert.equal((await request('/api/settings/traffic-unit',{method:'POST',data:{unit:'Kbps'}})).status,404);
  assert.equal((await request('/api/accounts/'+id,{method:'DELETE'})).status,200);assert.equal(store.latest(id),null);assert.equal(store.credential(id),null);
  assert.equal((await request('/api/logout',{method:'POST'})).status,200);assert.equal((await request('/api/accounts')).status,401);
});

test('concurrent binding creates one account and existing binding still opens at the account limit',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'yunjian-bind-test-')),key=randomBytes(32),store=new Store(dir,key);
  const config={key,password:passwordHash('fixture-admin-password'),origin:'http://fixture.local',production:false,legacy:true,pollSeconds:60};
  let release,listed,lists=0;const gate=new Promise(r=>{release=r;}),bothListed=new Promise(r=>{listed=r;});
  const provider={list:async()=>{if(++lists===2)listed();await gate;return [];},collect:async()=>({devices:[],todayPoints:0,warnings:[]})};
  const app=createApp(config,store,provider),session=store.login();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{release();await Promise.allSettled([...app.jobs.values()]);await new Promise(r=>app.server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+app.server.address().port+'/api/accounts';
  const bind=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:config.origin,Cookie:'yj_session='+session.token,'X-CSRF-Token':session.csrf},body:JSON.stringify({label:'fixture-account',tgt:'fixture-repeat-credential'})});
  const racing=[bind(),bind()];await bothListed;release();
  const responses=await Promise.all(racing);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values[0].id,values[1].id);assert.equal(store.accounts().length,1);
  for(let i=0;i<4;i++)store.add('fixture-extra-'+i,{tgt:'fixture-extra-token-'+i,wskey:'fixture-extra-token-'+i});
  const repeated=await bind();assert.equal(repeated.status,200);assert.equal((await repeated.json()).existing,true);assert.equal(lists,2);
});
