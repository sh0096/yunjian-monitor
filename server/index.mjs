import { configuration } from './config.mjs';
import { Store } from './store.mjs';
import { createApp } from './app.mjs';
process.umask(0o077);
let config;try {config=configuration();}catch(e){console.error(e.message);process.exit(1);}
const store=new Store(config.dataDir,config.key);
for(const a of store.accounts())if(['ready','syncing'].includes(a.state))store.state(a.id,'ready',null,0);
const app=createApp(config,store);
app.server.listen(config.port,config.host,()=>console.log(`云监工已启动：${config.origin}`));
app.server.on('error',()=>{console.error('服务启动失败，请检查监听端口和目录权限。');process.exit(1);});
const timer=setInterval(()=>{void app.tick();},1000);timer.unref();void app.tick();
async function stop(){clearInterval(timer);app.server.close();await Promise.allSettled([...app.jobs.values()]);store.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
