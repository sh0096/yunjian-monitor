// Official client uses powers of 1024 and labels byte rates KB/s, MB/s, etc.
// Keep that display convention while retaining bit/s internally for arithmetic.
export function trafficScale(bps) {
  const units=['KB/s','MB/s','GB/s','TB/s'];
  let divisor=8*1024,index=0;
  while(bps>=divisor*1024&&index<units.length-1){divisor*=1024;index++;}
  return {unit:units[index],divisor};
}
export function trafficDisplay(bps) {
  if(typeof bps!=='number'||!Number.isFinite(bps)||bps<0)return null;
  const {unit,divisor}=trafficScale(bps);
  return {value:bps/divisor,unit};
}
