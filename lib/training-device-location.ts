/** Training only: retain the device's reported accuracy; never synthesize a doorstep fix. */
export function getTrainingDeviceLocation(geolocation:Pick<Geolocation,'getCurrentPosition'>|undefined=typeof navigator!=='undefined'?navigator.geolocation:undefined):Promise<{latitude:number;longitude:number;accuracyMeters:number}>{
 if(!geolocation)return Promise.reject(new Error('Location is not supported on this device.'));
 return new Promise((resolve,reject)=>geolocation.getCurrentPosition(position=>{
  const {latitude,longitude,accuracy}=position.coords;
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!Number.isFinite(accuracy)||accuracy<0){reject(new Error('Your device returned an invalid location or accuracy. Please retry.'));return;}
  resolve({latitude,longitude,accuracyMeters:accuracy});
 },error=>reject(new Error(error.code===1?'Allow location access to confirm arrival, then retry.':'A fresh GPS fix is unavailable. Please retry.')),{enableHighAccuracy:true,maximumAge:0,timeout:15000}));
}
