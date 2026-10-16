export function demoSnapshot(at=Date.now()) {
  const devices=Array.from({length:1},(_,i)=>{
    const offline=i===5;
    const up=offline?null:Math.round((24+i*8+Math.sin(at/180000+i)*12)*1e6);
    return {id:`demo-${i}`,mac:`DEMO-000${i+1}`,name:['客厅 · 太乙','书房 · 太乙','工作室 · 雅典娜','卧室 · 亚瑟','备用线路 · 太乙','仓库 · 鲁班'][i],online:!offline,todayPoints:[136,152,118,96,145,0][i],allPoints:[21860,23821,18930,16720,21590,8600][i],uploadBps:up,downloadBps:offline?null:Math.round((3+i+Math.cos(at/130000+i)*2)*1e6),trafficUnit:'bps',cpu:offline?null:12+i*6,memory:offline?null:38+i*4,statusAt:at};
  });
  return {at,source:'demo',devices,todayPoints:136,allPoints:21860,earningsUnit:'演示积分',warnings:[]};
}
export function demoHistory(now=Date.now()) {
  const minute=Array.from({length:1440},(_,i)=>{const at=now-(1439-i)*60_000;return {at,resolution:'minute',devices:demoSnapshot(at).devices.map(d=>({id:d.id,uploadBps:d.uploadBps,downloadBps:d.downloadBps,uploadPeak:d.uploadBps*1.15,downloadPeak:d.downloadBps*1.1}))};});
  const fast=Array.from({length:721},(_,i)=>{const at=now-(720-i)*5000;return {at,resolution:'sample',devices:demoSnapshot(at).devices.map(d=>({id:d.id,uploadBps:d.uploadBps,downloadBps:d.downloadBps}))};});
  return [...minute,...fast];
}
