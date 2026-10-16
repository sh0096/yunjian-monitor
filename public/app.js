import {trafficDisplay,trafficScale} from './traffic.js';
const $=id=>document.getElementById(id);
const state={authenticated:false,csrf:null,legacyEnabled:false,demo:true,accounts:[],histories:{},sample:null,sampleHistory:[],hours:1,earningsDays:7,backup:null,connectionError:false,filter:'all',search:'',account:'all',device:null,editId:null,afterLogin:null,pollSeconds:5};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>n===null||n===undefined?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(n);
const stamp=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(t);
const time=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(t);
const valid=n=>typeof n==='number'&&Number.isFinite(n);
const html=(id,value)=>{const el=$(id);if(el.innerHTML!==value)el.innerHTML=value;};
const text=(id,value)=>{const el=$(id);if(el.textContent!==String(value))el.textContent=value;};
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
async function api(path,{method='GET',data}={}){
  const res=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:{...(data?{'Content-Type':'application/json'}:{}),...(method!=='GET'&&state.csrf?{'X-CSRF-Token':state.csrf}:{})},body:data?JSON.stringify(data):undefined});
  const json=await res.json();if(!res.ok){if(res.status===401&&path!=='/api/login'){state.authenticated=false;state.csrf=null;state.accounts=[];state.histories={};render();}throw new Error(json.error||'请求未完成，请稍后再试。');}return json;
}
function currentAccounts(){return state.accounts.filter(a=>state.account==='all'||state.account===a.id);}
function snapshot(){
  if(state.demo)return state.sample||{devices:[],todayPoints:null,at:0};
  const accounts=currentAccounts(),available=accounts.map(a=>a.snapshot).filter(Boolean);
  return {devices:accounts.flatMap(a=>(a.snapshot?.devices||[]).map(d=>({...d,key:a.id+':'+d.id,accountId:a.id,accountLabel:a.label}))),todayPoints:accounts.length&&available.length===accounts.length&&available.every(s=>valid(s.todayPoints))?available.reduce((n,s)=>n+s.todayPoints,0):null,at:available.length?Math.min(...available.map(s=>s.at)):null};
}
function shownDevices(){let ds=snapshot().devices;return ds.filter(d=>(state.filter==='all'||(state.filter==='online'?d.online===true:d.online===false))&&(!state.search||(d.name+' '+d.mac).toLowerCase().includes(state.search.toLowerCase())));}
function rate(n){const r=trafficDisplay(n);return r?`${num(r.value)}<small> ${r.unit}</small>`:'—';}
function deviceRate(d,direction){return rate(d[direction+'Bps']);}
function freshness(){
  if(state.demo)return {stale:false,label:'示例数据'};
  const s=snapshot(),age=s.at?Math.max(0,Date.now()-s.at):Infinity;
  const stale=state.connectionError||age>(state.pollSeconds*2+15)*1000||currentAccounts().some(a=>a.error);
  return {stale,label:!s.at?'等待采样':stale?'上次采样 · '+stamp(s.at):age<10_000?'刚刚更新':`${Math.floor(age/1000)} 秒前更新`};
}
function renderStats(){
  const s=snapshot(),ds=s.devices,online=ds.filter(d=>d.online===true),f=freshness();
  const single=ds.length===1,primary=single?ds[0]:null;
  text('hero-name',single?primary.name:ds.length?`${ds.length} 台设备`:'我的设备');
  text('hero-meta',single?`${primary.accountLabel||'京东云无线宝'} · ${state.demo?primary.mac:'•••• '+(primary.mac||'').slice(-6)}`:ds.length?'在线设备带宽合计':'接入账户后显示实时读数');
  html('today-stat',`${num(s.todayPoints)}<small>积分</small>`);
  const earningsAt=currentAccounts().map(a=>a.snapshot?.earningsAt).filter(valid);
  text('earnings-foot',state.demo?'示例入账':earningsAt.length?'确认于 '+time(Math.min(...earningsAt)):'等待平台入账');
  for(const [direction,id]of[['upload','up'],['download','down']]){
    const known=online.filter(d=>valid(d[direction+'Bps']));
    html(id+'-stat',rate(known.length&&known.length===online.length?known.reduce((n,d)=>n+d[direction+'Bps'],0):null));
    text(id+'-foot',f.stale?'上次成功读数':single?(primary.online===false?'设备离线':known.length?'官方实时读数':'等待有效读数'):known.length===online.length&&online.length?'在线设备合计':`有效采样 ${known.length}/${online.length}`);
  }
  const health=f.stale?'采集暂停':single?(primary.online===true?'在线':primary.online===false?'离线':'状态未知'):ds.length?`${online.length} / ${ds.length} 台在线`:'等待连接';
  const status=f.stale?'unknown':online.length?'online':single&&primary.online===false?'offline':'unknown';
  $('device-health').className='status '+status;html('device-health',`<i></i>${health}`);
  $('hero').classList.toggle('stale',f.stale);text('updated-at',f.label);
  text('collection-note',state.demo?'示例采样':`约 ${state.pollSeconds} 秒采样`);
  text('device-count',ds.length);
  $('devices-panel').hidden=single&&(state.demo||state.accounts.length===1);
  const alerts=[];
  if(!state.demo){
    if(state.connectionError)alerts.push('连接暂时中断，正在显示上次读数。');
    for(const a of currentAccounts()){
      if(a.error)alerts.push(`${esc(a.label)}：${esc(a.error)}${a.state==='reauth_required'?`<button class="text-button" data-reauth="${esc(a.id)}">更新凭据</button>`:''}`);
      if(a.state==='syncing'&&!a.snapshot)alerts.push(`${esc(a.label)}：正在读取设备。`);
      if(a.snapshot&&Date.now()-a.snapshot.at>(state.pollSeconds*2+15)*1000)alerts.push(`${esc(a.label)}：数据已过期，等待下次成功采样。`);
      for(const w of a.snapshot?.warnings||[])alerts.push(`${esc(a.label)}：${esc(w.message)}`);
    }
  }
  html('alerts',alerts.map(a=>`<div class="alert">${a}</div>`).join(''));
}
function renderTable(){
  const ds=shownDevices();
  html('devices-body',ds.map(d=>{
    const key=d.key||d.id,selected=state.device===key;
    const status=d.online===true?'online':d.online===false?'offline':'unknown';
    return `<tr data-key="${esc(key)}" class="${selected?'selected-row':''}"><td><div class="device-cell"><span class="device-icon"><svg class="icon"><use href="#icon-router"/></svg></span><div class="device-title">${esc(d.name)}<small>${esc(state.demo?d.mac:'•••• '+d.mac.slice(-6))}${d.accountLabel?' · '+esc(d.accountLabel):''}</small></div></div></td><td><span class="status ${status}"><i></i>${d.online===true?'在线':d.online===false?'离线':'未知'}</span></td><td class="points-cell">${num(d.todayPoints)} <small>积分</small></td><td class="up-cell">${deviceRate(d,'upload')}</td><td class="down-cell">${deviceRate(d,'download')}</td><td>${valid(d.cpu)?num(d.cpu)+'%':'—'} <small>/</small> ${valid(d.memory)?num(d.memory)+'%':'—'}</td><td><button class="text-button row-arrow" data-key="${esc(key)}" aria-label="查看${esc(d.name)}的趋势">›</button></td></tr>`;
  }).join(''));
  html('device-cards',ds.map(d=>`<button class="device-card ${(d.key||d.id)===state.device?'selected-card':''}" data-key="${esc(d.key||d.id)}"><span class="device-card-top"><span class="device-icon"><svg class="icon"><use href="#icon-router"/></svg></span><span class="device-title">${esc(d.name)}<small>${esc(state.demo?d.mac:'•••• '+d.mac.slice(-6))}</small></span><span class="status ${d.online===true?'online':'offline'}"><i></i>${d.online===true?'在线':d.online===false?'离线':'未知'}</span></span><span class="device-card-rates"><span><small>上行</small><b>${deviceRate(d,'upload')}</b></span><span><small>下行</small><b>${deviceRate(d,'download')}</b></span><span><small>今日入账</small><b>${num(d.todayPoints)}<small> 积分</small></b></span></span></button>`).join(''));
  $('devices-empty').hidden=ds.length>0;$('table-note').textContent=`显示 ${ds.length} 台 / 共 ${snapshot().devices.length} 台设备${state.demo?' · 演示数据':''}`;$('clear-device').hidden=!state.device;
}
function history(){
  if(state.demo)return state.sampleHistory.filter(r=>state.hours<=1?r.resolution==='sample':r.resolution==='minute');
  const accounts=currentAccounts(),buckets=new Map();
  for(const a of accounts){
    const live=state.hours<=1&&a.snapshot?[{at:a.snapshot.at,resolution:'sample',devices:a.snapshot.devices}]:[];
    for(const row of [...(state.histories[a.id]||[]),...live]){
      const interval=row.resolution==='sample'?state.pollSeconds*1000:60_000;
      const at=Math.floor(row.at/interval)*interval;
      if(!buckets.has(at))buckets.set(at,new Map());
      buckets.get(at).set(a.id,{at:row.at,resolution:row.resolution,devices:row.devices.map(d=>({...d,key:a.id+':'+d.id}))});
    }
  }
  return [...buckets].sort((a,b)=>a[0]-b[0]).filter(([,rows])=>rows.size===accounts.length).map(([,rows])=>({at:Math.min(...[...rows.values()].map(r=>r.at)),resolution:[...rows.values()][0].resolution,devices:[...rows.values()].flatMap(r=>r.devices)}));
}
let chartView=null,inspectionAt=null;
function inspectChart(index){
  if(!chartView?.points.length)return;
  const {points,x,W}=chartView,p=points[Math.max(0,Math.min(index,points.length-1))];
  inspectionAt=p.at;
  const cursor=$('chart-cursor');cursor.setAttribute('x1',x(p.at));cursor.setAttribute('x2',x(p.at));cursor.removeAttribute('visibility');
  const label=p.resolution==='minute'?'平均上传':'上传';
  html('chart-tooltip',`<strong>${stamp(p.at)}</strong>${label}　${rate(p.upload)}<br>下载　${rate(p.download)}${valid(p.uploadPeak)?'<br>上传峰值　'+rate(p.uploadPeak):''}`);
  const tooltip=$('chart-tooltip');tooltip.hidden=false;
  const width=tooltip.offsetWidth,left=x(p.at)/W*$('traffic-chart').clientWidth+23;
  tooltip.style.left=Math.max(10,Math.min(left-width/2,$('traffic-chart').clientWidth-width))+'px';
  $('traffic-chart').setAttribute('aria-label',`${stamp(p.at)}，${label} ${p.upload===null?'未知':num(trafficDisplay(p.upload)?.value)+' '+trafficDisplay(p.upload)?.unit}，下载 ${p.download===null?'未知':num(trafficDisplay(p.download)?.value)+' '+trafficDisplay(p.download)?.unit}`);
}
function clearInspection(){inspectionAt=null;$('chart-tooltip').hidden=true;$('chart-cursor')?.setAttribute('visibility','hidden');}
function renderChart(){
  if($('overview').hidden)return;
  const now=Date.now(),start=now-state.hours*3600_000;
  const points=history().filter(r=>r.at>=start&&r.at<=now).map(r=>{
    const ds=r.devices.filter(d=>!state.device||(d.key||d.id)===state.device);
    const values={at:r.at,resolution:r.resolution};
    for(const k of ['upload','download'])for(const suffix of ['','Peak']){
      const readings=ds.map(d=>d[k+(suffix||'Bps')]);
      values[k+suffix]=readings.length&&readings.every(valid)?readings.reduce((a,b)=>a+b,0):null;
    }
    return values;
  });
  const known=points.filter(p=>valid(p.upload)||valid(p.download));
  const peak=Math.max(0,...known.flatMap(p=>[p.upload||0,p.download||0,p.uploadPeak||0,p.downloadPeak||0]));
  const {unit,divisor}=trafficScale(peak),max=Math.max(1,peak/divisor)*1.18;
  const bounds=$('traffic-chart').getBoundingClientRect();
  const W=Math.max(260,bounds.width),H=Math.max(180,bounds.height),left=38,right=12,top=20,bottom=28;
  $('traffic-chart').setAttribute('viewBox',`0 0 ${W} ${H}`);
  const x=t=>left+(t-start)/(now-start)*(W-left-right),y=v=>H-bottom-v/divisor/max*(H-top-bottom);
  function paths(key){const paths=[];let current='',last=null;for(const p of points){const maxGap=p.resolution==='sample'?(state.demo?15_000:Math.max(15,state.pollSeconds*3)*1000):150_000;if(!valid(p[key])){if(current)paths.push(current);current='';last=null;continue;}if(last&&p.at-last>maxGap){if(current)paths.push(current);current='';}current+=(current?'L':'M')+x(p.at).toFixed(2)+','+y(p[key]).toFixed(2)+' ';last=p.at;}if(current)paths.push(current);return paths;}
  let svg='';
  for(let i=0;i<=4;i++){const yy=top+i*(H-top-bottom)/4;svg+=`<line x1="${left}" x2="${W-right}" y1="${yy}" y2="${yy}" stroke="#eeeef2"/><text x="${left-9}" y="${yy+3}" text-anchor="end" fill="#b2b2b7" font-size="9">${num((1-i/4)*max)}</text>`;}
  svg+=`<text x="${left}" y="8" fill="#a1a1a6" font-size="9">${unit}</text>`;
  const ticks=W<500?4:6;
  for(let i=0;i<=ticks;i++){const xx=left+i*(W-left-right)/ticks;svg+=`<text x="${xx}" y="${H-6}" text-anchor="${i===0?'start':i===ticks?'end':'middle'}" fill="#b2b2b7" font-size="9">${time(start+i*(now-start)/ticks)}</text>`;}
  const lines=[['upload','#007aff',false],['download','#7dc7c9',false]];
  if(state.hours>1)lines.push(['uploadPeak','#007aff66',true],['downloadPeak','#7dc7c980',true]);
  for(const [k,color,dashed] of lines)for(const path of paths(k))svg+=`<path d="${path}" fill="none" stroke="${color}" stroke-width="${dashed?1:2}" ${dashed?'stroke-dasharray="3 4"':''} stroke-linejoin="round" stroke-linecap="round"/>`;
  if(known.length===1)for(const [k,color]of lines)if(valid(known[0][k]))svg+=`<circle cx="${x(known[0].at)}" cy="${y(known[0][k])}" r="3" fill="${color}"/>`;
  svg+=`<line id="chart-cursor" x1="0" x2="0" y1="${top}" y2="${H-bottom}" stroke="#c7c7cc" stroke-dasharray="3 3" visibility="hidden"/>`;
  html('traffic-chart',svg);$('chart-empty').hidden=known.length>0;
  text('chart-empty',state.demo?'暂无示例采样':'开始采集后，曲线会显示在这里。');
  const selected=snapshot().devices.find(d=>(d.key||d.id)===state.device);
  text('chart-label',selected?selected.name:'');
  text('chart-caption',state.demo?'示例数据':state.hours<=1?'逐次记录官方上下行':'每分钟平均值与峰值');
  text('chart-resolution',state.hours<=1?(points.some(p=>p.resolution==='legacy-minute')?'含旧版分钟采样':'约 5 秒采样'):'实线平均值 · 虚线峰值');
  $('peak-legend').hidden=state.hours<=1;
  $('traffic-chart').setAttribute('aria-label',`过去 ${state.hours} 小时的上传与下载趋势，单位 ${unit}`);
  chartView={points,x,W};
  if(inspectionAt!==null&&points.length)inspectChart(points.reduce((best,p,i)=>Math.abs(p.at-inspectionAt)<Math.abs(points[best].at-inspectionAt)?i:best,0));
}
let earningsVersion='';
function renderEarnings(){
  const now=Date.now(),day=t=>new Date(t+8*3600_000).toISOString().slice(0,10),today=day(now),accounts=currentAccounts();
  const dates=Array.from({length:state.earningsDays},(_,i)=>day(now-(state.earningsDays-1-i)*86400_000));
  const rows=dates.map((date,i)=>{
    const values=state.demo?[Math.round(118+Math.sin(i*1.4)*18)]:accounts.map(a=>a.dailyEarnings?.find(r=>r.day===date)?.points);
    return {day:date,points:values.length&&values.every(valid)?values.reduce((a,b)=>a+b,0):null};
  });
  const known=rows.filter(r=>valid(r.points)),peak=Math.max(1,...known.map(r=>r.points));
  text('earnings-summary',state.demo?'示例数据':known.length?`已记录 ${known.length} 天 · 合计 ${num(known.reduce((n,r)=>n+r.points,0))} 积分`:'从今天开始记录，历史将逐日积累');
  const version=JSON.stringify({rows,days:state.earningsDays});if(version===earningsVersion)return;earningsVersion=version;
  $('earnings-chart').style.gridTemplateColumns=`repeat(${rows.length},minmax(0,1fr))`;
  $('earnings-chart').classList.toggle('dense',state.earningsDays===30);
  html('earnings-chart',rows.map((r,i)=>`<div class="earnings-column ${r.day===today?'today':''} ${r.points===null?'missing':''}" title="${r.day} · ${r.points===null?'未记录':num(r.points)+' 积分'}" aria-label="${r.day}，${r.points===null?'未记录':num(r.points)+' 积分'}"><b>${r.points===null?'—':num(r.points)}</b><div class="earnings-bar" data-height="${r.points===null?2:Math.max(2,r.points/peak*100)}"></div><small>${state.earningsDays===7||i%5===0||i===rows.length-1?r.day.slice(5).replace('-','/'):'&nbsp;'}</small></div>`).join(''));
  $('earnings-chart').querySelectorAll('[data-height]').forEach(bar=>bar.style.height=bar.dataset.height+'px');
}
function renderAccounts(){
  if(!state.authenticated){$('account-list').innerHTML='<p class="login-hint">登录管理账户后，可以接入和管理你的设备。</p>';return;}
  $('account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<div class="account-row"><span class="device-icon"><svg class="icon"><use href="#icon-account"/></svg></span><div><h3>${esc(a.label)}</h3><p>${a.snapshot?.devices.length??'—'} 台设备 · ${esc(a.state==='ready'?'已连接':a.state==='syncing'?'同步中':a.error||'等待同步')}<br>添加于 ${stamp(a.created)}</p></div><div class="account-actions"><button class="text-button" data-edit="${esc(a.id)}">更新凭据</button><button class="text-button danger" data-remove="${esc(a.id)}">删除</button></div></div>`).join(''):'<p class="login-hint">还没有接入平台账户。</p>';
}
function render(){
  const remote=state.deploymentMode==='server';
  text('run-location',remote?'你的 VPS':'本地测试');
  text('run-label',state.publicAccess?'HTTPS 加密连接':remote?'SSH 加密连接':'本地连接');
  text('storage-note',remote?'数据保存在你的 VPS。':'数据保存在本机。');
  text('version-note',remote?'自托管':'本地预览');
  text('backup-note',state.backup?.verified?stamp(state.backup.at)+' · 恢复检查通过':'尚无备份记录');
  text('auth-button',state.authenticated?'退出登录':'管理登录');
  text('login-title',state.setupRequired?'设置你的管理密码':'登录你的监控空间');
  text('login-intro',state.setupRequired?'首次使用：设置 14–128 位管理密码。':'输入此网页的管理密码。');
  text('login-submit',state.setupRequired?'设置密码并进入':'登录');
  $('setup-confirm').hidden=!state.setupRequired;$('login-form').elements.confirm.required=!!state.setupRequired;
  $('mode-bar').hidden=!state.demo;
  text('mode-description','正在预览示例设备');text('mode-toggle','查看我的设备 →');
  document.querySelectorAll('[data-hours]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.hours)===state.hours));
  $('account-select').hidden=state.demo||state.accounts.length<2;
  html('account-select','<option value="all">全部账户</option>'+state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.label)}</option>`).join(''));$('account-select').value=state.account;
  renderStats();if(!$('devices-panel').hidden)renderTable();renderChart();renderEarnings();if(!$('accounts').hidden)renderAccounts();
}
let realLoading=null,lastHistoryLoad=0,historyHours=null,lastFetch=0,dataVersion='';
async function loadReal(force=false){
  if(!state.authenticated)return;
  if(realLoading)return realLoading;
  const csrf=state.csrf,requestedHours=state.hours;
  realLoading=(async()=>{
    const {accounts,backup}=await api('/api/accounts');if(!state.authenticated||state.csrf!==csrf)return;
    const needsHistory=force||historyHours!==requestedHours||Date.now()-lastHistoryLoad>=(requestedHours<=1?10_000:30_000)||accounts.some(a=>!state.histories[a.id]);
    if(needsHistory){
      const histories=await Promise.all(accounts.map(async a=>[a.id,(await api(`/api/accounts/${a.id}/history?hours=${requestedHours}`)).history]));
      if(!state.authenticated||state.csrf!==csrf||state.hours!==requestedHours)return;
      state.histories=Object.fromEntries(histories);lastHistoryLoad=Date.now();historyHours=requestedHours;
    }
    state.accounts=accounts;state.backup=backup;state.connectionError=false;
    if(!accounts.some(a=>a.id===state.account))state.account='all';
    const version=JSON.stringify({accounts:accounts.map(({next_poll,state,...a})=>({...a,state:state==='syncing'?'ready':state})),backup,hours:state.hours,historyAt:lastHistoryLoad});
    if(version!==dataVersion){dataVersion=version;render();}else renderStats();
  })();
  lastFetch=Date.now();
  try{return await realLoading;}catch(e){state.connectionError=true;renderStats();throw e;}finally{realLoading=null;}
}
function loginThen(action){if(state.authenticated){action();return;}state.afterLogin=action;$('login-error').textContent='';$('login-dialog').showModal();}
function bind(id=null){loginThen(()=>{
  state.editId=id;$('bind-form').reset();$('bind-error').textContent='';$('bind-title').textContent=id?'更新账户凭据':'接入平台账户';
  if(id)$('bind-form').elements.label.value=state.accounts.find(a=>a.id===id)?.label||'';
  $('bind-dialog').showModal();
});}
for(const element of document.querySelectorAll('[data-close]'))element.addEventListener('click',()=>$(element.dataset.close).close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>{dialog.querySelector('form')?.reset();});
function selectTab(tab){
  const overview=tab==='overview';$('overview').hidden=!overview;$('accounts').hidden=overview;
  document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  $('page-title').textContent=overview?'网络活动':'设置';$('page-subtitle').textContent=overview?'京东云无线宝':'管理已连接的京东云账户。';
  if(overview){renderStats();renderChart();}else{renderAccounts();render();}
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));
for(const id of['docs-open','security-open'])$(id).addEventListener('click',()=>$('docs-dialog').showModal());
for(const id of['bind-button','account-bind-button'])$(id).addEventListener('click',()=>bind());
$('auth-button').addEventListener('click',async()=>{
  if(!state.authenticated){loginThen(()=>{});return;}
  try{await api('/api/logout',{method:'POST'});state.authenticated=false;state.csrf=null;state.accounts=[];state.histories={};state.demo=true;state.device=null;state.account='all';state.hours=1;render();toast('已退出登录。');}catch(e){toast(e.message);}
});
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
  const password=form.elements.password.value,confirmation=form.elements.confirm.value;form.elements.password.value='';form.elements.confirm.value='';
  try{const result=await api(state.setupRequired?'/api/setup':'/api/login',{method:'POST',data:{password,confirm:confirmation}});state.setupRequired=false;state.authenticated=true;state.csrf=result.csrf;await loadReal();state.demo=!state.accounts.length;state.hours=1;render();$('login-dialog').close();const next=state.afterLogin;state.afterLogin=null;next?.();toast('已登录监控空间。');}
  catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}
});
$('bind-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,button=$('bind-submit');button.disabled=true;button.textContent='正在验证设备列表…';$('bind-error').textContent='';
  const data={label:form.elements.label.value,tgt:form.elements.tgt.value.trim(),wskey:form.elements.wskey.value.trim()};
  form.elements.tgt.value='';form.elements.wskey.value='';
  try{const result=await api(state.editId?'/api/accounts/'+state.editId:'/api/accounts',{method:state.editId?'PUT':'POST',data});data.tgt='';data.wskey='';state.demo=false;state.hours=1;state.device=null;state.account=result.id||state.editId||'all';state.filter='all';state.search='';$('search').value='';document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.filter==='all'));$('bind-dialog').close();await loadReal();selectTab('overview');toast(result.existing?`此账户已接入，已打开“${result.label}”。`:'已接入账户，正在同步设备数据。');if(!result.existing)setTimeout(()=>loadReal().catch(e=>toast(e.message)),2000);}
  catch(error){$('bind-error').textContent=error.message;}finally{data.tgt='';data.wskey='';button.disabled=false;button.textContent='验证并接入';}
});
$('mode-toggle').addEventListener('click',()=>{if(state.demo){loginThen(async()=>{state.demo=false;state.hours=1;state.device=null;try{await loadReal();}catch(e){toast(e.message);}render();});}else{state.demo=true;state.hours=1;state.device=null;render();}});
$('refresh-button').addEventListener('click',async()=>{
  const b=$('refresh-button');b.disabled=true;
  try{if(state.demo){const d=await api('/api/demo');state.sample=d.snapshot;state.sampleHistory=d.history;render();toast('演示数据已刷新。');}
  else{await loadReal();let started=0;for(const a of currentAccounts())if(a.next_poll<=Date.now()&&a.state!=='syncing'&&a.state!=='reauth_required'){await api(`/api/accounts/${a.id}/refresh`,{method:'POST'});started++;}toast(started?'已开始采集，稍后显示结果。':state.accounts.length?'已显示最新采样。':'请先接入平台账户。');if(started)setTimeout(()=>loadReal().catch(e=>toast(e.message)),2000);}}
  catch(e){toast(e.message);}finally{b.disabled=false;}
});
$('search').addEventListener('input',e=>{state.search=e.target.value;renderTable();});
$('filters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(!b)return;state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('selected',x===b));renderTable();});
$('periods').addEventListener('click',async e=>{const b=e.target.closest('[data-hours]');if(!b)return;state.hours=Number(b.dataset.hours);clearInspection();document.querySelectorAll('[data-hours]').forEach(x=>x.classList.toggle('selected',x===b));if(state.demo){renderChart();return;}try{await loadReal(true);if(historyHours!==state.hours)await loadReal(true);}catch(error){toast(error.message);}});
$('earnings-periods').addEventListener('click',e=>{const b=e.target.closest('[data-days]');if(!b)return;state.earningsDays=Number(b.dataset.days);document.querySelectorAll('[data-days]').forEach(x=>x.classList.toggle('selected',x===b));renderEarnings();});
$('alerts').addEventListener('click',e=>{const b=e.target.closest('[data-reauth]');if(b)bind(b.dataset.reauth);});
$('traffic-chart').addEventListener('pointermove',e=>{if(!chartView?.points.length)return;const rect=$('traffic-chart').getBoundingClientRect(),position=e.clientX-rect.left;const index=chartView.points.reduce((best,p,i)=>Math.abs(chartView.x(p.at)-position)<Math.abs(chartView.x(chartView.points[best].at)-position)?i:best,0);inspectChart(index);});
$('traffic-chart').addEventListener('pointerleave',clearInspection);
$('traffic-chart').addEventListener('blur',clearInspection);
$('traffic-chart').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Escape'].includes(e.key)||!chartView?.points.length)return;e.preventDefault();if(e.key==='Escape'){clearInspection();return;}const current=inspectionAt===null?chartView.points.length-1:chartView.points.findIndex(p=>p.at===inspectionAt);inspectChart(current+(e.key==='ArrowLeft'?-1:1));});
$('devices-body').addEventListener('click',e=>{const row=e.target.closest('[data-key]');if(row){state.device=row.dataset.key;renderTable();renderChart();}});
$('device-cards').addEventListener('click',e=>{const row=e.target.closest('[data-key]');if(row){state.device=row.dataset.key;renderTable();renderChart();}});
$('clear-device').addEventListener('click',()=>{state.device=null;renderTable();renderChart();});
$('account-select').addEventListener('change',e=>{state.account=e.target.value;state.device=null;render();});
$('account-list').addEventListener('click',async e=>{
  const edit=e.target.closest('[data-edit]');if(edit){bind(edit.dataset.edit);return;}
  const remove=e.target.closest('[data-remove]');if(!remove)return;
  if(!confirm('删除此账户的登录凭据和全部采样记录？'))return;
  try{await api('/api/accounts/'+remove.dataset.remove,{method:'DELETE'});state.device=null;await loadReal();toast('账户与历史记录已删除。');}catch(error){toast(error.message);}
});
$('export-button').addEventListener('click',()=>{
  const ds=shownDevices();if(!ds.length){toast('没有可导出的设备。');return;}
  const field=v=>'"'+String(v??'').replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')+'"';
  const rows=[['数据来源','设备名称','设备编号','状态','今日积分','上行 bit/s','下行 bit/s','上行原始值','下行原始值','原始单位'],...ds.map(d=>[state.demo?'演示':'历史接口',d.name,d.mac,d.online===true?'在线':d.online===false?'离线':'未知',d.todayPoints,d.uploadBps,d.downloadBps,d.uploadRaw,d.downloadRaw,d.trafficUnit])];
  const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(field).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`云监工-${state.demo?'演示':'设备'}-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function init(){
  try{const [session,demo]=await Promise.all([api('/api/session'),api('/api/demo')]);Object.assign(state,session);state.sample=demo.snapshot;state.sampleHistory=demo.history;if(state.authenticated){await loadReal();state.demo=!state.accounts.length;}state.hours=1;render();}
  catch(e){toast(e.message);render();}
}
setInterval(()=>{if(document.hidden||!state.authenticated||state.demo)return;renderStats();if(Date.now()-lastFetch>=state.pollSeconds*1000)loadReal().catch(()=>{});},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.authenticated&&!state.demo)loadReal().catch(e=>toast(e.message));});
window.addEventListener('resize',renderChart);
init();
