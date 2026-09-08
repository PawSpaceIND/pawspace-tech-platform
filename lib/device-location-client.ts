/** Request a fresh device fix for a user-initiated location-gated action. */
export function getDeviceLocation(geolocation:Pick<Geolocation,"getCurrentPosition">|undefined=typeof navigator!=="undefined"?navigator.geolocation:undefined):Promise<{latitude:number;longitude:number}>{
 if(!geolocation)return Promise.reject(new Error("Location is not supported on this device."));
 return new Promise((resolve,reject)=>geolocation.getCurrentPosition(position=>{
  const{latitude,longitude}=position.coords;
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180){reject(new Error("Your device returned an invalid location. Please retry."));return;}
  resolve({latitude,longitude});
 },error=>reject(new Error(error.code===1?"Allow location access to check in, then retry.":error.code===3?"Location timed out. Please retry where your device can get a GPS fix.":"Your current location is unavailable. Please retry.")),{enableHighAccuracy:true,maximumAge:0,timeout:15000}));
}
