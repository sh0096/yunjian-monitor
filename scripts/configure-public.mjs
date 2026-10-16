import {readFileSync,writeFileSync,renameSync,chmodSync,existsSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {configuration} from '../server/config.mjs';

export function configurePublic(file,origin) {
  file=resolve(file);
  if(lstatSync(file).isSymbolicLink())throw new Error('请直接指定配置文件，不使用软链接。');
  let content=readFileSync(file,'utf8');
  const env=parseEnv(content),dataDir=resolve(dirname(file),env.DATA_DIR||'./data');
  let hash=env.ADMIN_PASSWORD_HASH;
  if(existsSync(join(dataDir,'yunjian.sqlite'))){
    const db=new DatabaseSync(join(dataDir,'yunjian.sqlite'),{readOnly:true});
    try{hash=db.prepare("SELECT value FROM settings WHERE key='admin_hash'").get()?.value||hash;}finally{db.close();}
  }
  const values={PUBLIC_ORIGIN:origin,NODE_ENV:'production',HOST:'127.0.0.1',RUN_MODE:'server',ADMIN_PASSWORD_HASH:hash};
  configuration({...env,...values,DATA_DIR:dataDir});
  for(const [key,value]of Object.entries(values)){
    if(typeof value!=='string'||/[\r\n']/.test(value))throw new Error('配置格式不正确。');
    const line=`${key}='${value}'`,pattern=new RegExp(`^${key}=.*$`,'m');
    content=pattern.test(content)?content.replace(pattern,()=>line):content.trimEnd()+'\n'+line+'\n';
  }
  const temporary=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,content,{mode:0o600,flag:'wx'});renameSync(temporary,file);chmodSync(file,0o600);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4)throw new Error('参数不完整。');
    configurePublic(process.argv[2],process.argv[3]);
    console.log('HTTPS 来源已配置，加密密钥保留。请检查反向代理后只重启本应用。');
  }catch{
    console.error('配置未完成：请确认已有管理密码、原加密密钥和完整 HTTPS 来源地址；用法：node scripts/configure-public.mjs 配置文件 https://monitor.example.com:8443');process.exitCode=1;
  }
}
