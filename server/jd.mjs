import { createHash, createHmac } from 'node:crypto';

// Compatibility parameters documented in JDC-Monitor commit 351c25b (2023-03-24).
// These public SDK constants are NOT a user's TGT. Verified with an authorized account on 2026-10-15.
const ACCESS = 'b8f9c108c190a39760e1b4e373208af5cd75feb4';
const HMAC = '706390cef611241d57573ca601eb3c061e174948';
const GATEWAY = 'https://gw.smart.jd.com/f/service/';
const POINTS = 'https://router-app-api.jdcloud.com/v1/regions/cn-north-1/';
const QUERY = '?plat=ios&hard_platform=iPhone11%2C8&app_version=6.5.5&plat_version=13.7&channel=jd';
export class UpstreamError extends Error {
  constructor(kind, message) { super(message); this.kind=kind; }
}
const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const shape = (detail='') => new UpstreamError('schema_changed','平台返回结构与历史版本不同，需要核对当前 App 响应。'+(detail?`（${detail}）`:''));
export function parseJson(text) {
  // JSON.parse otherwise rounds 64-bit numeric device IDs before validation.
  // Node 24 exposes the original number token in the reviver's source context.
  return JSON.parse(text,(key,value,context)=>{
    if(key==='feed_id'&&typeof value==='number') {
      if(!context?.source||!/^\d+$/.test(context.source))throw shape('feed_id 不是十进制整数');
      return context.source;
    }
    return value;
  });
}
function object(value) {
  if (typeof value === 'string') { try { value=parseJson(value); } catch { throw shape(); } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw shape();
  return value;
}
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!['number','string'].includes(typeof value)) return null;
  const n=Number(value); return Number.isFinite(n) && n>=0 ? n : null;
}
export function signature(body, date=new Date()) {
  // The historical client formats Asia/Shanghai wall time with a literal Z.
  // Preserve it for compatibility; do not silently claim this is UTC.
  const shifted=new Date(date.getTime()+8*3600_000);
  const timestamp=shifted.toISOString();
  const year=shifted.getUTCFullYear();
  const day=Math.floor((Date.UTC(year,shifted.getUTCMonth(),shifted.getUTCDate())-Date.UTC(year,0,1))/86400_000)+1;
  const device=createHash('md5').update(`ios6.5.5iPhone11,813.7:${day}`).digest('hex');
  const digest=createHmac('sha1',HMAC).update(`${device}postjson_body${body}${timestamp}${ACCESS}${device}`).digest('base64');
  return {Authorization:`smart ${ACCESS}:::${digest}:::${timestamp}`,timestamp:timestamp.slice(0,19).replace('T',' '),accesskey:ACCESS,tgt:'',appkey:'996','User-Agent':'ios','Content-Type':'application/json'};
}
export function normalizeRate(value) {
  // Official Android 4.13.3: HomeViewModel converts detail.upload/download
  // to WanUplinkRate/WanDownlinkRate by multiplying by 1024 (bits/second).
  // See docs/核查记录.md for the official package and static inspection evidence.
  const n=numeric(value);
  return n===null || !Number.isFinite(n*1024) ? null : n*1024;
}
export function parseDevices(json) {
  let result=json.result;
  if(typeof result==='string'){try{result=parseJson(result);}catch{throw shape('设备列表 result 无法解析');}}
  if (!Array.isArray(result)) throw shape(`设备列表 result 类型为 ${type(result)}，预期 array`);
  const list=result.flatMap((group,index)=>{
    if (!Array.isArray(group?.list)) throw shape(`设备列表 result[${index}].list 类型为 ${type(group?.list)}`);
    return group.list;
  });
  const ids=new Set();
  return list.map(d=>{
    // feed_id must be a string to avoid precision loss on 64-bit identifiers.
    if (typeof d.feed_id!=='string' || !d.feed_id)throw shape(`设备列表 feed_id 类型为 ${type(d.feed_id)}`);
    if (typeof d.device_id!=='string' || !d.device_id)throw shape(`设备列表 device_id 类型为 ${type(d.device_id)}`);
    if(ids.has(d.feed_id))throw shape('设备列表存在重复的 feed_id');
    ids.add(d.feed_id);
    return {id:d.feed_id,mac:d.device_id,name:String(d.device_name||'未命名设备').slice(0,120),online:String(d.status)==='1'?true:String(d.status)==='0'?false:null};
  });
}
export function parseStatus(json) {
  const result=object(json.result);
  if (!Array.isArray(result.streams) || !result.streams.length) throw shape();
  const current=object(result.streams[0].current_value);
  if('code' in current && String(current.code)!=='0')throw new UpstreamError('business_error','设备状态查询未成功。');
  const data=object(current.data);
  if (!('upload' in data) || !('download' in data)) throw shape();
  const raw=v=>['string','number'].includes(typeof v)?String(v).slice(0,60):null;
  return {uploadRaw:raw(data.upload),downloadRaw:raw(data.download),uploadBps:normalizeRate(data.upload),downloadBps:normalizeRate(data.download),trafficUnit:'Kibps',cpu:numeric(data.cpu),memory:numeric(data.mem)};
}
export function parsePoints(json) {
  if (!Array.isArray(json.result?.pointInfos)) throw shape();
  return json.result.pointInfos.map(p=>{
    if(typeof p.mac!=='string' || numeric(p.todayPointIncome)===null || numeric(p.allPointIncome)===null) throw shape();
    return {mac:p.mac,today:numeric(p.todayPointIncome),all:numeric(p.allPointIncome)};
  });
}
export class JdLegacy {
  constructor(transport=fetch) { this.transport=transport; }
  async request(url,init,type) {
    let response;
    try { response=await this.transport(url,{...init,redirect:'error',signal:AbortSignal.timeout(12_000)}); }
    catch { throw new UpstreamError('network_error','平台请求超时或网络不可达。'); }
    if(response.status===401) throw new UpstreamError('reauth_required','平台拒绝登录态，请重新取得凭据并更新。');
    // 403 can mean scope/permission denial, not necessarily expiry.
    if(response.status===403) throw new UpstreamError('access_denied','平台拒绝访问，可能是凭据、权限或接口策略变化。');
    if(response.status===429) throw new UpstreamError('rate_limited','平台限制访问频率，已暂停轮询。');
    if(!response.ok) throw new UpstreamError('upstream_error','平台服务暂时不可用。');
    const declared=Number(response.headers.get('content-length')||0);
    if(declared>2_000_000) throw shape();
    // Enforce actual response size even when no Content-Length is sent.
    const reader=response.body?.getReader(); let bytes=0; const chunks=[];
    if(!reader) throw shape();
    try { for(;;) {const {done,value}=await reader.read(); if(done) break; bytes+=value.length; if(bytes>2_000_000){await reader.cancel();throw shape();} chunks.push(value);} }
    catch(e){if(e instanceof UpstreamError)throw e;throw new UpstreamError('network_error','平台响应中断。');}
    let json; try {json=parseJson(Buffer.concat(chunks).toString('utf8'));} catch {throw shape('平台响应不是可解析的 JSON');}
    const success=type==='gateway'?String(json.status)==='0':String(json.code)==='200';
    if(!success) throw new UpstreamError('business_error','平台返回业务错误；需核对响应中的错误码，未判定为 TGT 过期。');
    return json;
  }
  async gateway(method,body,tgt) {
    if(!['listAllUserDevices','controlDevice'].includes(method)) throw new Error('Endpoint not allowed');
    const headers=signature(body); headers.tgt=tgt;
    return this.request(GATEWAY+method+QUERY,{method:'POST',headers,body},'gateway');
  }
  async list({tgt}) {
    const body='{"appversion":"2.7.3","appplatform":"iPhone11,8","appplatformversion":"13.7"}';
    return parseDevices(await this.gateway('listAllUserDevices',body,tgt));
  }
  async status(device,{tgt}) {
    // Only the status query is exposed. No reboot, unbind or device control input.
    const body=JSON.stringify({feed_id:device.id,command:[{stream_id:'SetParams',current_value:'{\n  "cmd" : "get_router_status_detail"\n}'}]});
    return parseStatus(await this.gateway('controlDevice',body,tgt));
  }
  async earnings({wskey,tgt}) {
    // Pagination is evidenced by jdc-monitor-api's AppUrlConstant and pageInfo model.
    const all=[],seen=new Set();let pages=1;
    for(let page=1;page<=pages;page++) {
      const json=await this.request(POINTS+`todayPointDetail?sortField=today_point&sortDirection=DESC&currentPage=${page}&pageSize=15`,{method:'GET',headers:{wskey:wskey||tgt}},'points');
      const info=json.result?.pageInfo;
      if(!info||!Number.isInteger(info.totalPage)||info.totalPage<0||info.totalPage>20||Number(info.currentPage)!==page)throw shape();
      if(page===1)pages=Math.max(1,info.totalPage);
      else if(info.totalPage!==pages)throw shape();
      const points=parsePoints(json);
      if(info.totalPage===0&&points.length)throw shape();
      for(const p of points){const id=p.mac.toLowerCase();if(seen.has(id))throw shape();seen.add(id);all.push(p);}
      if(page===pages&&Number.isInteger(info.totalRecord)&&info.totalRecord!==all.length)throw shape();
    }
    return all;
  }
  async collect(credential,{previous=null,now=Date.now()}={}) {
    const day=t=>new Date(t+8*3600_000).toISOString().slice(0,10);
    const listDue=!previous?.listAt||now-previous.listAt>=60_000;
    const devices=listDue?await this.list(credential):previous.devices.map(({id,mac,name,online})=>({id,mac,name,online}));
    const previousDevices=new Map((previous?.devices||[]).map(d=>[d.mac.toLowerCase(),d]));
    const changed=devices.length!==previousDevices.size||devices.some(d=>previousDevices.get(d.mac.toLowerCase())?.id!==d.id);
    const sameDay=previous?.earningsDay===day(now);
    const localHour=new Date(now+8*3600_000).getUTCHours();
    const earningsInterval=localHour<2?10*60_000:3600_000;
    const earningsDue=!previous?.earningsAttemptAt||now-previous.earningsAttemptAt>=earningsInterval||!sameDay||changed;
    let points=null,todayPoints=sameDay?previous.todayPoints:null,allPoints=previous?.allPoints??null;
    let earningsAt=sameDay?previous.earningsAt:null,earningsAttemptAt=previous?.earningsAttemptAt||0;
    let earningsWarnings=(previous?.warnings||[]).filter(w=>w.scope==='earnings');
    if(earningsDue){
      earningsAttemptAt=now;
      try{
        points=await this.earnings(credential);
        todayPoints=points.reduce((n,p)=>n+p.today,0);allPoints=points.reduce((n,p)=>n+p.all,0);earningsAt=now;earningsWarnings=[];
      }catch(e){
        if(!(e instanceof UpstreamError))throw e;
        if(['reauth_required','access_denied','rate_limited'].includes(e.kind))throw e;
        earningsWarnings=[{scope:'earnings',kind:e.kind,message:e.message+(earningsAt?' 收益仍显示上次成功结果。':'')}];
      }
    }
    const warnings=[...earningsWarnings];
    // Query the changing status every poll; reuse device metadata and earnings.
    for(const device of devices){
      const p=points?.find(p=>p.mac.toLowerCase()===device.mac.toLowerCase()),old=previousDevices.get(device.mac.toLowerCase());
      device.todayPoints=points?(p?.today??null):(sameDay?old?.todayPoints??null:null);
      device.allPoints=points?(p?.all??null):old?.allPoints??null;
      Object.assign(device,{uploadRaw:null,downloadRaw:null,uploadBps:null,downloadBps:null,trafficUnit:'Kibps',cpu:null,memory:null});
      if(device.online===false)continue;
      try{Object.assign(device,await this.status(device,credential));device.statusAt=Date.now();}
      catch(e){
        if(!(e instanceof UpstreamError))throw e;
        if(['reauth_required','access_denied','rate_limited'].includes(e.kind))throw e;
        device.error=e.message;warnings.push({scope:device.id,kind:e.kind,message:e.message});
      }
    }
    if(points){
      const matched=new Set(devices.map(d=>d.mac.toLowerCase()));
      const unmatched=points.filter(p=>!matched.has(p.mac.toLowerCase())).length;
      if(unmatched)warnings.push({scope:'earnings',kind:'unmatched_devices',message:`有 ${unmatched} 条收益无法与设备匹配，汇总仍包含这些收益。`});
    }
    return {source:'jd-legacy',devices,todayPoints,allPoints,listAt:listDue?now:previous.listAt,earningsAt,earningsAttemptAt,earningsDay:day(now),earningsUnit:'历史积分口径（当前结算口径待核对）',warnings};
  }
}
