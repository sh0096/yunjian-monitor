import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,chmod,rename,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {unseal} from './crypto.mjs';

export async function createVerifiedBackup({dataDir,key,at=Date.now(),keep=7}) {
  const dir=join(dataDir,'backups');
  await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
  const day=new Date(at+8*3600_000).toISOString().slice(0,10);
  const name=`yunjian-${day}.sqlite`,destination=join(dir,name),temporary=destination+'.partial';
  await rm(temporary,{force:true});
  const source=new DatabaseSync(join(dataDir,'yunjian.sqlite'),{readOnly:true,timeout:2000});
  try{await backup(source,temporary,{rate:100});}finally{source.close();}
  await chmod(temporary,0o600);
  let restored;
  try{
    restored=new DatabaseSync(temporary);
    const check=restored.prepare('PRAGMA integrity_check').all();
    if(check.length!==1||check[0].integrity_check!=='ok'||restored.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Backup verification failed');
    // A recovery check must verify the encryption key as well as SQLite integrity.
    for(const account of restored.prepare('SELECT id,credential FROM accounts').all())unseal(account.credential,key,account.id);
    restored.exec('DELETE FROM sessions; PRAGMA journal_mode=DELETE; VACUUM;');
    restored.close();restored=null;
    await rename(temporary,destination);
  }catch(e){restored?.close();await rm(temporary,{force:true});throw e;}
  const files=(await readdir(dir)).filter(f=>/^yunjian-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort().reverse();
  for(const file of files.slice(keep))await rm(join(dir,file));
  const status={at,verified:true,retained:Math.min(files.length,keep)};
  const live=new DatabaseSync(join(dataDir,'yunjian.sqlite'),{timeout:2000});
  try{live.prepare("INSERT INTO settings(key,value) VALUES('backup_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(status));}finally{live.close();}
  return {path:destination,...status};
}
