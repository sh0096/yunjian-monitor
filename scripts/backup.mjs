import {configuration} from '../server/config.mjs';
import {createVerifiedBackup} from '../server/backup.mjs';
process.umask(0o077);
try{
  const config=configuration();
  await createVerifiedBackup(config);
  console.log('数据库备份完成，完整性和凭据恢复检查通过。');
}catch{
  console.error('数据库备份未完成，请检查备份目录、加密密钥和数据库状态。');process.exitCode=1;
}
