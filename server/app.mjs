import { createServer } from 'node:http';
import {isIP} from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { passwordHash, verifyPassword } from './crypto.mjs';
import { JdLegacy, UpstreamError, normalizeRate } from './jd.mjs';
import { demoSnapshot, demoHistory } from './demo.mjs';

class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
const assetDir=fileURLToPath(new URL('../public/',import.meta.url));
const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/traffic.js':['traffic.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml']};
function equal(a,b) {const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
const tokenOf=req=>/\byj_session=([A-Za-z0-9_-]{43})\b/.exec(req.headers.cookie||'')?.[1];
async function body(req) {
  if(!String(req.headers['content-type']||'').startsWith('application/json')) throw new HttpError(415,'只接受 JSON 请求。');
  if(Number(req.headers['content-length'])>24_000)throw new HttpError(413,'请求过大。');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>24_000)throw new HttpError(413,'请求过大。');chunks.push(chunk);}
  let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'请求格式不正确。');}
  if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new HttpError(400,'请求格式不正确。');
  return parsed;
}
function credentialInput(input) {
  const label=typeof input.label==='string'?input.label.trim():'';
  if(!label||label.length>80)throw new HttpError(400,'请填写 1–80 字的账户备注。');
  const validate=v=>typeof v==='string'&&v.length>=8&&v.length<=8192&&!/[\r\n\x00-\x20\x7f]/.test(v);
  if(!validate(input.tgt))throw new HttpError(400,'TGT 格式不正确，请只粘贴值。');
  if(input.wskey && !validate(input.wskey))throw new HttpError(400,'WSKEY 格式不正确。');
  return {label,credential:{tgt:input.tgt,wskey:input.wskey||input.tgt}};
}

export function createApp(config,store,provider=new JdLegacy(),now=Date.now) {
  // Reinterpret retained raw samples with the verified official conversion too.
  const convertDevice=d=>({...d,...('uploadRaw' in d?{uploadBps:normalizeRate(d.uploadRaw),downloadBps:normalizeRate(d.downloadRaw),trafficUnit:'Kibps'}:{})});
  const convertSnapshot=s=>s?{...s,devices:s.devices.map(convertDevice)}:null;
  const accountWithCredential=tgt=>store.accounts().find(a=>store.credential(a.id).tgt===tgt);
  const loginBuckets=new Map(), jobs=new Map();
  let globalLogins={at:Date.now(),count:0};
  const cookie=token=>`yj_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?43200:0}${config.production?'; Secure':''}`;
  const refresh=async(id)=>{
    if(jobs.has(id))return jobs.get(id);
    const a=store.account(id);if(!a || a.state==='reauth_required' || a.next_poll>now())return;
    const revision=a.credential;
    const started=now();
    // Reserve the next slot before making network calls. Applies to manual refresh too.
    store.state(id,'syncing',null,started+config.pollSeconds*1000);
    const work=(async()=>{
      try {
        const data=await provider.collect(store.credential(id),{previous:store.latest(id),now:started});
        if(store.account(id)?.credential!==revision)return;
        store.save(id,data,now());store.state(id,'ready',null,Math.max(started+config.pollSeconds*1000,now()));
      }catch(e){
        if(store.account(id)?.credential!==revision)return;
        const kind=e instanceof UpstreamError?e.kind:'internal_error';
        const message=e instanceof UpstreamError?e.message:'采集未完成，请检查服务配置。';
        const cooldown=kind==='rate_limited'?30*60_000:kind==='access_denied'?15*60_000:5*60_000;
        store.state(id,kind,message,now()+cooldown);
      }finally{jobs.delete(id);}
    })();jobs.set(id,work);return work;
  };
  const tick=async()=>{
    if(!config.legacy)return;
    // Each account has its own lock and deadline; a slow account cannot stall others.
    await Promise.all(store.accounts().map(a=>refresh(a.id)));
  };
  const handler=async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    if(config.production)headers['Strict-Transport-Security']='max-age=31536000';
    const json=(status,data,extra={})=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,'http://local'),path=url.pathname, method=req.method;
      if(method==='GET'&&assets[path]) {const [file,type]=assets[path];res.writeHead(200,{...headers,'Content-Type':type});res.end(await readFile(assetDir+file));return;}
      if(method==='GET'&&path==='/healthz'){json(200,{ok:true,app:'yunjian'});return;}
      if(method==='GET'&&path==='/api/demo'){json(200,{snapshot:demoSnapshot(),history:demoHistory()});return;}
      const token=tokenOf(req), session=store.session(token);
      const setupRequired=config.password==='SETUP'&&!store.adminHash();
      if(method==='GET'&&path==='/api/session'){json(200,{authenticated:!!session,csrf:session?.csrf,setupRequired,legacyEnabled:config.legacy,pollSeconds:config.pollSeconds,deploymentMode:config.deploymentMode||'local',publicAccess:config.production});return;}
      if(!['GET','HEAD'].includes(method)) {
        if(req.headers.origin!==config.origin)throw new HttpError(403,'请求来源不匹配。请使用配置的网页地址。');
      }
      if(method==='POST'&&path==='/api/setup') {
        if(!setupRequired)throw new HttpError(409,'管理密码已经设置。');
        const input=await body(req);
        if(typeof input.password!=='string'||input.password.length<14||input.password.length>128)throw new HttpError(400,'管理密码需要 14–128 位。');
        if(input.password!==input.confirm)throw new HttpError(400,'两次密码不一致。');
        // SETUP is refused at startup except for loopback-only tunnel deployments.
        if(!store.createAdminHash(passwordHash(input.password)))throw new HttpError(409,'管理密码已经设置。');
        const s=store.login();json(201,{ok:true,csrf:s.csrf},{'Set-Cookie':cookie(s.token)});return;
      }
      if(method==='POST'&&path==='/api/login') {
        if(setupRequired)throw new HttpError(409,'请先设置管理密码。');
        const input=await body(req),peer=req.socket.remoteAddress||'unknown',forwarded=req.headers['x-real-ip'];
        const trusted=config.production&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
        const ip=trusted&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:peer,now=Date.now();
        if(now-globalLogins.at>60_000)globalLogins={at:now,count:0};
        for(const [k,v] of loginBuckets)if(v.until<now)loginBuckets.delete(k);
        const bucket=loginBuckets.get(ip)||{count:0,until:now+15*60_000};
        if(bucket.count>=5||globalLogins.count>=30)throw new HttpError(429,'登录尝试过多，请稍后再试。');
        bucket.count++;globalLogins.count++;loginBuckets.set(ip,bucket);
        if(!verifyPassword(input.password,store.adminHash()||config.password))throw new HttpError(401,'管理密码不正确。');
        loginBuckets.delete(ip);
        if(token)store.logout(token);
        const s=store.login();json(200,{ok:true,csrf:s.csrf},{'Set-Cookie':cookie(s.token)});return;
      }
      if(!session)throw new HttpError(401,'请先登录管理账户。');
      if(!['GET','HEAD'].includes(method)&&!equal(req.headers['x-csrf-token'],session.csrf))throw new HttpError(403,'会话校验失败，请刷新页面。');
      if(method==='POST'&&path==='/api/logout'){store.logout(token);json(200,{ok:true},{'Set-Cookie':cookie('')});return;}
      if(method==='GET'&&path==='/api/accounts'){json(200,{accounts:store.accounts().map(a=>({...a,snapshot:convertSnapshot(store.latest(a.id)),dailyEarnings:store.dailyEarnings(a.id)})),backup:store.backupStatus()});return;}
      if(method==='POST'&&path==='/api/accounts') {
        if(!config.legacy)throw new HttpError(409,'真实接口尚未启用，请按部署说明启用历史接口适配。');
        const {label,credential}=credentialInput(await body(req));
        const openExisting=()=>{
          const existing=accountWithCredential(credential.tgt);
          if(!existing)return false;
          json(200,{id:existing.id,label:existing.label,existing:true,deviceCount:store.latest(existing.id)?.devices.length||0});
          return true;
        };
        if(openExisting())return;
        if(store.accounts().length>=5)throw new HttpError(409,'最多可添加 5 个平台账户。');
        const list=await provider.list(credential);
        if(list.length>100)throw new HttpError(400,'本版本每账户最多支持 100 台设备。');
        // Another request can finish binding while this device-list request waits.
        if(openExisting())return;
        if(store.accounts().length>=5)throw new HttpError(409,'最多可添加 5 个平台账户。');
        const id=store.add(label,credential);
        // Credentials verified against device listing; collect runs in the background.
        store.state(id,'ready',null,0);void refresh(id);
        json(201,{id,label,deviceCount:list.length});return;
      }
      const match=/^\/api\/accounts\/([a-f0-9-]{36})(?:\/(history|refresh))?$/.exec(path);
      if(match) {
        const [,id,action]=match;if(!store.account(id))throw new HttpError(404,'账户不存在。');
        if(method==='DELETE'&&!action){store.remove(id);json(200,{ok:true});return;}
        if(method==='PUT'&&!action){
          if(!config.legacy)throw new HttpError(409,'真实接口尚未启用。');
          if(jobs.has(id))throw new HttpError(409,'账户正在同步，请稍后更新凭据。');
          const {label,credential}=credentialInput(await body(req));
          const list=await provider.list(credential);if(list.length>100)throw new HttpError(400,'设备数量超过限制。');
          const existing=accountWithCredential(credential.tgt);
          if(existing&&existing.id!==id)throw new HttpError(409,'此凭据属于另一个已接入账户，请打开该账户更新。');
          store.replace(id,label,credential);void refresh(id);json(200,{ok:true});return;
        }
        if(method==='GET'&&action==='history'){
          if(!url.searchParams.has('hours')){json(200,{history:store.history(id).map(row=>({...row,devices:row.devices.map(convertDevice)}))});return;}
          const hours=Number(url.searchParams.get('hours'));
          if(![0.5,1,6,24].includes(hours))throw new HttpError(400,'不支持的曲线时间范围。');
          json(200,{history:store.trafficHistory(id,hours,now()),resolution:hours<=1?'sample':'minute'});return;
        }
        if(method==='POST'&&action==='refresh'){
          if(!config.legacy)throw new HttpError(409,'真实接口尚未启用。');
          const a=store.account(id);
          if(a.state==='reauth_required')throw new HttpError(409,'请更新平台登录凭据。');
          if(a.next_poll>Date.now()||jobs.has(id))throw new HttpError(429,'尚未到下次采集时间，请稍后刷新。');
          void refresh(id);json(202,{ok:true});return;
        }
      }
      throw new HttpError(404,'未找到请求的内容。');
    }catch(e){
      // Never log request bodies, credentials, cookies, upstream response text or exceptions.
      if(e instanceof HttpError)json(e.status,{error:e.message});
      else if(e instanceof UpstreamError)json(502,{error:e.message,kind:e.kind});
      else json(500,{error:'服务暂时未能完成请求。'});
    }
  };
  const server=createServer(handler);server.requestTimeout=30_000;server.headersTimeout=15_000;server.maxHeadersCount=40;
  return {server,tick,refresh,jobs};
}
