import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createApp} from '../server/app.mjs';
import {JdLegacy,UpstreamError} from '../server/jd.mjs';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yunjian-poll-')),key=randomBytes(32),store=new Store(dir,key);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,config:{key,password:'unused-fixture',origin:'http://fixture.local',production:false,legacy:true,pollSeconds:5}};
}
const data=()=>({devices:[{id:'fixture-device',uploadBps:1024,downloadBps:0}],todayPoints:1,warnings:[]});

test('fast status polling reuses earnings and device metadata until their deadlines',async()=>{
  const provider=new JdLegacy(),calls={list:0,earnings:0,status:0};
  provider.list=async()=>{calls.list++;return [{id:'fixture-device',mac:'FIXTURE',name:'test',online:true}];};
  provider.earnings=async()=>{calls.earnings++;return [{mac:'FIXTURE',today:calls.earnings,all:20}];};
  provider.status=async()=>{calls.status++;return {uploadBps:calls.status*1024,downloadBps:0};};
  const start=Date.parse('2026-10-15T12:00:00Z');
  let previous=await provider.collect({tgt:'fixture-only'},{now:start});
  previous=await provider.collect({tgt:'fixture-only'},{previous,now:start+5000});
  assert.deepEqual(calls,{list:1,earnings:1,status:2});assert.equal(previous.todayPoints,1);assert.equal(previous.devices[0].todayPoints,1);
  previous=await provider.collect({tgt:'fixture-only'},{previous,now:start+60_000});
  assert.deepEqual(calls,{list:2,earnings:1,status:3});
  previous=await provider.collect({tgt:'fixture-only'},{previous,now:start+3600_000});
  assert.deepEqual(calls,{list:3,earnings:2,status:4});assert.equal(previous.todayPoints,2);
  previous=await provider.collect({tgt:'fixture-only'},{previous,now:Date.parse('2026-10-15T15:59:58Z')});
  const before=calls.earnings;
  previous=await provider.collect({tgt:'fixture-only'},{previous,now:Date.parse('2026-10-15T16:00:03Z')});
  assert.equal(calls.earnings,before+1);assert.equal(previous.earningsDay,'2026-10-16');
});

test('five-second scheduler prevents overlapping requests and preserves upstream backoff',async t=>{
  const {store,config}=fixture(t),id=store.add('test',{tgt:'fixture-only',wskey:'fixture-only'});
  let clock=Date.now(),calls=0,release;
  const started=clock,gate=new Promise(r=>{release=r;});
  const provider={collect:async()=>{calls++;if(calls===1){await gate;return data();}throw new UpstreamError('rate_limited','稍后再试。');}};
  const app=createApp(config,store,provider,()=>clock);
  const first=app.refresh(id),overlapping=app.refresh(id);assert.equal(calls,1);
  clock+=2000;release();await Promise.all([first,overlapping]);
  assert.equal(store.account(id).next_poll,started+5000);
  clock=started+4999;await app.tick();assert.equal(calls,1);
  clock=started+5000;await app.tick();assert.equal(calls,2);
  assert.equal(store.account(id).state,'rate_limited');assert.equal(store.account(id).next_poll,clock+30*60_000);
  clock+=5000;await app.tick();assert.equal(calls,2);
});

test('a slow account does not delay fast updates for another account',async t=>{
  const {store,config}=fixture(t);
  store.add('slow',{tgt:'fixture-slow',wskey:'fixture-slow'});
  const fastId=store.add('fast',{tgt:'fixture-fast',wskey:'fixture-fast'});
  let clock=Date.now(),slow=0,fast=0,release;
  const gate=new Promise(r=>{release=r;});
  const provider={collect:async c=>{if(c.tgt==='fixture-slow'){slow++;await gate;}else fast++;return data();}};
  const app=createApp(config,store,provider,()=>clock),first=app.tick();
  await app.jobs.get(fastId);clock+=5000;
  const next=app.tick();await app.jobs.get(fastId);
  assert.equal(slow,1);assert.equal(fast,2);
  release();await Promise.all([first,next]);
});

test('fast readings replace the current minute without growing history every five seconds',t=>{
  const {store}=fixture(t),id=store.add('test',{tgt:'fixture-only',wskey:'fixture-only'});
  const minute=Math.floor(Date.now()/60_000)*60_000;
  store.save(id,data(),minute+1000);
  store.save(id,{...data(),todayPoints:2},minute+6000);
  assert.equal(store.history(id).length,1);assert.equal(store.latest(id).at,minute+6000);assert.equal(store.latest(id).todayPoints,2);
  store.save(id,data(),minute+61000);
  assert.equal(store.history(id).length,2);assert.equal(store.latest(id).at,minute+61000);
});
