"use client";

import{useEffect,useRef,useState}from"react";
import{FOREGROUND_GPS_INTERVAL_MS,gpsIngestionKey,shouldApplyTelemetryResponse}from"../../lib/gps-telemetry-policy";

type RouteData={bookingId:string;providerId:string;destinationAddress?:string;destinationCoordinates?:{lat:number;lng:number}|null;providerLocation:{lat:number;lng:number;accuracyMeters?:number;capturedAt?:number;serverReceivedAt?:number;trustState?:string;eventId?:string}|null;navigationUrl?:string;travelState?:string;route?:{status:string;distanceMeters?:number;durationSeconds?:number;error?:string}|null;path?:{distanceFromPreviousMeters:number;cumulativeDistanceMeters:number};telemetryAccepted?:boolean;rejectionReason?:string|null};
type ApiResponse={data?:RouteData;error?:string};

const km=(meters:unknown)=>`${(Number(meters||0)/1000).toFixed(1)} km`;
const mins=(seconds:unknown)=>`${Math.max(1,Math.round(Number(seconds||0)/60))} min`;

export default function GroomingRouteCard({bookingId,providerId}:{bookingId:string;providerId:string}){
  const[data,setData]=useState<RouteData|null>(null),[busy,setBusy]=useState(false),[tracking,setTracking]=useState(false),[error,setError]=useState("");
  const watchId=useRef<number|null>(null),lastSentAt=useRef(0),inFlight=useRef(false),pending=useRef<GeolocationPosition|null>(null),controller=useRef<AbortController|null>(null),sequence=useRef(0),lastAppliedSequence=useRef(0),mounted=useRef(true);

  const load=async()=>{try{const response=await fetch(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`,{cache:"no-store"});const body=await response.json() as ApiResponse;if(response.ok&&body.data){setData(body.data);setError("");}else if(response.status!==404)throw new Error(body.error||"Unable to load route");}catch(err){setError(err instanceof Error?err.message:"Unable to load route");}};

  const transmit=async(position:GeolocationPosition)=>{
    const seq=++sequence.current,abort=new AbortController();controller.current=abort;inFlight.current=true;
    const telemetry={bookingId,providerId,latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy,capturedAt:position.timestamp};
    try{
      const response=await fetch("/api/grooming-route",{method:"POST",signal:abort.signal,headers:{"content-type":"application/json"},body:JSON.stringify({...telemetry,idempotencyKey:gpsIngestionKey(telemetry)})});
      const body=await response.json().catch(()=>({})) as ApiResponse;
      if(!mounted.current)return;
      if(body.data&&shouldApplyTelemetryResponse(seq,lastAppliedSequence.current)){lastAppliedSequence.current=seq;if(response.ok)setData(previous=>({...previous,...body.data} as RouteData));}
      if(!response.ok)throw new Error(body.error||"Unable to calculate route");
      setError("");
    }catch(err){if((err as Error)?.name!=="AbortError"&&mounted.current)setError(err instanceof Error?err.message:"Unable to update GPS");}
    finally{
      if(controller.current===abort)controller.current=null;inFlight.current=false;
      const next=pending.current;pending.current=null;
      if(next&&mounted.current)void transmit(next);
    }
  };

  const queuePosition=(position:GeolocationPosition)=>{if(inFlight.current){pending.current=position;return;}void transmit(position);};
  const captureOnce=()=>{if(!navigator.geolocation){setError("Location is not supported on this device");return;}setBusy(true);setError("");navigator.geolocation.getCurrentPosition(position=>{queuePosition(position);setBusy(false);},geoError=>{setBusy(false);setError(geoError.message||"Location permission was not granted");},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});};

  const stopTracking=()=>{if(watchId.current!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId.current);watchId.current=null;lastSentAt.current=0;pending.current=null;controller.current?.abort();controller.current=null;setTracking(false);};
  const startTracking=()=>{
    if(!navigator.geolocation){setError("Location is not supported on this device");return;}if(watchId.current!==null)return;setError("");setTracking(true);
    watchId.current=navigator.geolocation.watchPosition(position=>{const t=Date.now();if(t-lastSentAt.current<FOREGROUND_GPS_INTERVAL_MS)return;lastSentAt.current=t;queuePosition(position);},geoError=>{setError(geoError.message||"Location update failed");if(geoError.code===geoError.PERMISSION_DENIED)stopTracking();},{enableHighAccuracy:true,timeout:20000,maximumAge:5000});
  };

  useEffect(()=>{
    mounted.current=true;
    const timer=window.setTimeout(()=>{
      if(watchId.current!==null&&navigator.geolocation)navigator.geolocation.clearWatch(watchId.current);
      watchId.current=null;lastSentAt.current=0;pending.current=null;controller.current?.abort();controller.current=null;
      setTracking(false);
      void load();
    },0);
    return()=>{window.clearTimeout(timer);mounted.current=false;if(watchId.current!==null&&typeof navigator!=="undefined"&&navigator.geolocation)navigator.geolocation.clearWatch(watchId.current);controller.current?.abort();pending.current=null;};
  },[bookingId,providerId]);

  return <section style={{marginTop:14,padding:16,borderRadius:18,border:"1px solid #e7dcef",background:"#fff"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"flex-start"}}><div><small style={{fontWeight:900,color:"#7540aa",letterSpacing:1}}>FOREGROUND GPS UAT</small><b style={{display:"block",marginTop:4,fontSize:16}}>Trusted route, GPS & ETA</b></div><button onClick={()=>void load()} style={{border:"1px solid #d8cae7",background:"white",borderRadius:10,padding:"8px 10px",fontWeight:800}}>↻</button></div>
    {!data&&!error&&<p style={{fontSize:12,color:"#746b7d"}}>The verified customer doorstep appears after the canonical booking saves its mapped coordinates.</p>}
    {data&&<><div style={{margin:"12px 0",padding:12,borderRadius:12,background:"#f8f5fb"}}><small style={{color:"#786b81"}}>DESTINATION</small><b style={{display:"block",marginTop:4,fontSize:13}}>{data.destinationAddress||"Verified customer doorstep"}</b></div>{data.providerLocation&&<p style={{fontSize:11,margin:"0 0 8px",color:"#6d6275"}}>Latest trusted GPS {data.providerLocation.capturedAt?new Date(data.providerLocation.capturedAt).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit",second:"2-digit"}):"just now"}{Number.isFinite(data.providerLocation.accuracyMeters)?` · ±${Math.round(Number(data.providerLocation.accuracyMeters))} m`:""}</p>}{data.route?.status==="configured"&&<p style={{fontSize:13,margin:"0 0 8px"}}><b>ETA:</b> {mins(data.route.durationSeconds)} · {km(data.route.distanceMeters)}</p>}{data.path&&<p style={{fontSize:11,margin:"0 0 8px",color:"#6d6275"}}>Travelled since tracking start: {km(data.path.cumulativeDistanceMeters)} · last delta {Math.round(data.path.distanceFromPreviousMeters)} m</p>}{data.route?.status==="configuration_required"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#7a5b20"}}>Trusted GPS capture works. Google Routes ETA waits for the approved UAT server key.</p>}{data.route?.status==="route_unavailable"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#9a3d32"}}>Route unavailable: {data.route.error}</p>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginTop:11}}>{!tracking?<button onClick={startTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#4b168c",color:"white",fontWeight:900}}>▶ Start GPS</button>:<button onClick={stopTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#9b3038",color:"white",fontWeight:900}}>■ Stop GPS</button>}<button disabled={busy||tracking} onClick={captureOnce} style={{minHeight:47,border:"1px solid #d8cae7",borderRadius:12,background:"white",color:"#4b168c",fontWeight:900}}>{busy?"Locating…":"Update once"}</button></div>
      {data.navigationUrl&&<a href={data.navigationUrl} target="_blank" rel="noreferrer" style={{display:"block",marginTop:9,padding:"12px",borderRadius:12,border:"1px solid #d8cae7",textDecoration:"none",textAlign:"center",color:"#4b168c",fontWeight:900}}>Open turn-by-turn in Google Maps ↗</a>}
    </>}
    {tracking&&<div role="status" style={{marginTop:10,padding:"9px 11px",borderRadius:10,background:"#eaf8ef",color:"#176e45",fontSize:11,fontWeight:800}}>● GPS tracking on · one request at a time · latest fix queued</div>}
    {error&&<p style={{fontSize:12,color:"#9a3d32",marginBottom:0}}>{error}</p>}
    <p style={{fontSize:10,color:"#817887",lineHeight:1.45,margin:"10px 0 0"}}>Location sharing is user-started and foreground-only in UAT. Stale, future-clock and low-accuracy fixes are stored as rejected evidence and never drive ETA or arrival.</p>
  </section>;
}
