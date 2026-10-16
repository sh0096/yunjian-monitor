import {normalizeRate} from './jd.mjs';

const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function trafficDevices(devices=[]) {
  return devices.map(d=>{
    const reading=k=>{
      if(d.online===false||d.error)return null;
      const n=(k+'Raw') in d?normalizeRate(d[k+'Raw']):d[k+'Bps'];
      return finite(n)?n:null;
    };
    return {id:d.id,online:d.online??null,statusAt:d.statusAt??null,uploadBps:reading('upload'),downloadBps:reading('download')};
  });
}
export function aggregateMinute(previous,devices,at) {
  const values=new Map((previous?.devices||[]).map(d=>[d.id,d]));
  for(const d of devices){
    const row=values.get(d.id)||{id:d.id,samples:0,uploadSum:0,uploadCount:0,uploadPeak:null,downloadSum:0,downloadCount:0,downloadPeak:null};
    row.samples++;
    for(const k of ['upload','download'])if(finite(d[k+'Bps'])){
      row[k+'Sum']+=d[k+'Bps'];row[k+'Count']++;
      row[k+'Peak']=Math.max(row[k+'Peak']??0,d[k+'Bps']);
    }
    values.set(d.id,row);
  }
  return {firstAt:previous?.firstAt??at,lastAt:at,devices:[...values.values()]};
}
export function minuteReadings(value) {
  return value.devices.map(d=>({id:d.id,samples:d.samples,uploadCount:d.uploadCount,downloadCount:d.downloadCount,
    uploadBps:d.uploadCount?d.uploadSum/d.uploadCount:null,downloadBps:d.downloadCount?d.downloadSum/d.downloadCount:null,
    uploadPeak:d.uploadPeak,downloadPeak:d.downloadPeak}));
}
