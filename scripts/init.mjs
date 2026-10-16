import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { passwordHash } from '../server/crypto.mjs';
process.umask(0o077);
if(existsSync('.env')){console.error('.env 已存在，为保护加密密钥不会覆盖。');process.exit(1);}
if(!process.stdin.isTTY){console.error('请在交互式终端中运行初始化。');process.exit(1);}
async function hidden(prompt){
  process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let result='';const onData=b=>{
      const s=b.toString();
      if(s.includes('\u0003')){process.stdin.setRawMode(false);process.exit(130);}
      if(s.includes('\r')||s.includes('\n')){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');resolve(result);}
      else if(s==='\u007f'||s==='\b')result=result.slice(0,-1);
      else if(!/[\x00-\x1f]/.test(s))result+=s;
    };process.stdin.on('data',onData);
  });
}
const pass=await hidden('设置网页管理密码（至少 14 位，输入不回显）：');
if(pass.length<14||pass.length>128){console.error('密码长度需要 14–128 位。');process.exit(1);}
if(pass!==await hidden('再次输入：')){console.error('两次密码不一致。');process.exit(1);}
writeFileSync('.env',`HOST=127.0.0.1\nPORT=8787\nPUBLIC_ORIGIN=http://127.0.0.1:8787\nNODE_ENV=development\nDATA_DIR=./data\nADMIN_PASSWORD_HASH='${passwordHash(pass)}'\nENCRYPTION_KEY='${randomBytes(32).toString('base64')}'\nENABLE_JD_LEGACY=false\nPOLL_SECONDS=5\n`,{mode:0o600,flag:'wx'});
console.log('初始化完成。运行 npm start，然后打开 http://127.0.0.1:8787。');
