import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { configuration } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { passwordHash } from '../server/crypto.mjs';
if(!process.stdin.isTTY){console.error('请在交互式终端运行。');process.exit(1);}
const hidden=new Writable({write(_chunk,_encoding,cb){cb();}});
const rl=createInterface({input:process.stdin,output:hidden,terminal:true});
process.stdout.write('新管理密码（14–128 位，输入不回显）：');const p=await rl.question('');
process.stdout.write('\n再次输入：');const c=await rl.question('');rl.close();process.stdout.write('\n');
if(p!==c||p.length<14||p.length>128){console.error('长度不符或两次不一致。');process.exit(1);}
const config=configuration();const store=new Store(config.dataDir,config.key);store.setAdminHash(passwordHash(p));store.close();console.log('密码已重置，所有旧会话已退出。');
