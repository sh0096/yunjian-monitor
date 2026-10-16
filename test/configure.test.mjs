import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {Store} from '../server/store.mjs';
import {passwordHash} from '../server/crypto.mjs';
import {configurePublic} from '../scripts/configure-public.mjs';
import {configuration} from '../server/config.mjs';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'yunjian-production-')),key=randomBytes(32),file=join(dir,'.env');
  writeFileSync(file,`HOST=127.0.0.1\nPORT=8787\nPUBLIC_ORIGIN=http://127.0.0.1:8788\nNODE_ENV=development\nDATA_DIR=./data\nADMIN_PASSWORD_HASH=SETUP\nENCRYPTION_KEY=${key.toString('base64')}\nENABLE_JD_LEGACY=false\n`);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,key,file};
}
test('public configuration retains keys and current admin hash without disclosing secrets',t=>{
  const {dir,key,file}=fixture(t),store=new Store(join(dir,'data'),key),hash=passwordHash('fixture-production-password');
  store.setAdminHash(hash);store.close();
  configurePublic(file,'https://monitor.example.com:8443');
  const env=parseEnv(readFileSync(file,'utf8'));
  assert.equal(env.ADMIN_PASSWORD_HASH,hash);assert.equal(env.ENCRYPTION_KEY,key.toString('base64'));
  assert.equal(env.HOST,'127.0.0.1');assert.equal(env.NODE_ENV,'production');assert.equal(env.ENABLE_JD_LEGACY,'false');
  assert.equal(configuration(env).origin,'https://monitor.example.com:8443');assert.equal(statSync(file).mode&0o777,0o600);
});
test('public configuration refuses missing password and invalid origins without changing the file',t=>{
  const {file,dir,key}=fixture(t),before=readFileSync(file,'utf8');
  assert.throws(()=>configurePublic(file,'https://monitor.example.com'));assert.equal(readFileSync(file,'utf8'),before);
  const store=new Store(join(dir,'data'),key);store.setAdminHash(passwordHash('fixture-production-password'));store.close();
  for(const origin of ['http://monitor.example.com','https://monitor.example.com/','https://monitor.example.com/path']){
    assert.throws(()=>configurePublic(file,origin));assert.equal(readFileSync(file,'utf8'),before);
  }
});
