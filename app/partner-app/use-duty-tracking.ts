"use client";
import {useEffect,useRef,useState} from "react";
import {boundedFetch} from "../../lib/bounded-fetch";
import {gpsIngestionKey} from "../../lib/gps-telemetry-policy";
import {PushNotifications} from "@capacitor/push-notifications";
import {Capacitor,registerPlugin} from "@capacitor/core";
type Fix={latitude:number;longitude:number;accuracy:number;time:number;simulated?:boolean};
type BackgroundPlugin={addWatcher(options:{backgroundMessage:string;backgroundTitle:string;requestPermissions:boolean;stale:boolean;distanceFilter:number},callback:(location:Fix|undefined,error?:{message:string})=>void):Promise<string>;removeWatcher(options:{id:string}):Promise<void>};
const Background=registerPlugin<BackgroundPlugin>("BackgroundGeolocation");
export function useDutyTracking(job:{bookingId:string;providerId:string}|null,onConnection:(value:"Online"|"Reconnecting"|"Offline")=>void,onEnded:()=>void) {
  const [notice,setNotice]=useState("");
  const connection=useRef(onConnection),ended=useRef(onEnded);useEffect(()=>{connection.current=onConnection;ended.current=onEnded;},[onConnection,onEnded]);
  const bookingId=job?.bookingId,providerId=job?.providerId;
  useEffect(()=>{
    if(!bookingId||!providerId)return;
    let disposed=false,lastSent=0,sending=false,watch:number|undefined,nativeId:string|undefined;
    let trackingState=Capacitor.isNativePlatform()?"native":"foreground";
    const stop=()=>{disposed=true;if(watch!==undefined)navigator.geolocation.clearWatch(watch);if(nativeId)void Background.removeWatcher({id:nativeId});};
    const heartbeat=async()=>{
      try{const response=await boundedFetch("/api/partner-heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId,providerId,trackingState})});
        if(disposed)return;
        if(response.status===409||response.status===401||response.status===403){stop();ended.current();return;}
        if(!response.ok)throw new Error("Heartbeat unavailable");connection.current("Online");
      }catch{if(!disposed)connection.current(navigator.onLine?"Reconnecting":"Offline");}
    };
    const send=async(fix:Fix)=>{
      if(disposed||sending||Date.now()-lastSent<15000)return;
      if(fix.simulated){setNotice("Simulated GPS is not accepted as service evidence.");return;}
      sending=true;lastSent=Date.now();
      const point={bookingId,providerId,latitude:fix.latitude,longitude:fix.longitude,accuracyMeters:fix.accuracy,capturedAt:fix.time};
      try{const response=await boundedFetch("/api/grooming-route",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...point,idempotencyKey:gpsIngestionKey(point)})});const body=await response.json();if(disposed)return;if(!response.ok)throw new Error(body.error||"Location could not be verified");setNotice(Capacitor.isNativePlatform()?"Background location active for this job":"Location active while this browser is open");await heartbeat();}
      catch(problem){if(!disposed)setNotice(problem instanceof Error?problem.message:"Waiting for GPS connection");}finally{sending=false;}
    };
    queueMicrotask(()=>{if(!disposed)setNotice("Requesting location permission for your active job…");});
    if(Capacitor.isNativePlatform()){
      const startNative=async()=>{
        if(Capacitor.getPlatform()==="android"){
          const permission=await PushNotifications.requestPermissions();
          if(permission.receive!=="granted")throw new Error("Allow notifications to display the on-duty background location indicator.");
        }
        if(disposed)return;
        const id=await Background.addWatcher({backgroundMessage:"Sharing location during your accepted PawSpace job.",backgroundTitle:"PawSpace — ON DUTY",requestPermissions:true,stale:false,distanceFilter:0},(fix,error)=>{if(disposed)return;if(error){trackingState="permission_denied";setNotice(`Location permission required: ${error.message}`);}else if(fix)void send(fix);});nativeId=id;if(disposed)await Background.removeWatcher({id});
      };void startNative().catch(problem=>{if(!disposed){trackingState="unavailable";setNotice(problem instanceof Error?problem.message:"Background tracking is unavailable in this app build. Contact Operations.");}});
    }else if(navigator.geolocation){watch=navigator.geolocation.watchPosition(position=>void send({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,time:position.timestamp}),error=>{trackingState=error.code===1?"permission_denied":"unavailable";setNotice(`Location needs attention: ${error.message}`);},{enableHighAccuracy:true,maximumAge:5000,timeout:20000});}
    else{trackingState="unavailable";queueMicrotask(()=>{if(!disposed)setNotice("Location is unavailable on this device. Contact Operations.");});}
    void heartbeat();const timer=setInterval(()=>void heartbeat(),30000);window.addEventListener("online",heartbeat);
    return()=>{stop();clearInterval(timer);window.removeEventListener("online",heartbeat);};
  },[bookingId,providerId]);
  return notice;
}
