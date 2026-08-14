"use client";

import{useEffect,useRef,useState}from"react";

type RouteData={bookingId:string;providerId:string;destinationAddress:string;destinationCoordinates:{lat:number;lng:number}|null;providerLocation:{lat:number;lng:number;accuracyMeters?:number;capturedAt?:number}|null;navigationUrl:string;travelState?:string;route?:{status:string;distanceMeters?:number;durationSeconds?:number;error?:string}};
type ApiResponse={data?:RouteData;error?:string};

const km=(meters:unknown)=>`${(Number(meters||0)/1000).toFixed(1)} km`;
const mins=(seconds:unknown)=>`${Math.max(1,Math.round(Number(seconds||0)/60))} min`;

export default function GroomingRouteCard({bookingId,providerId}:{bookingId:string;providerId:string}){
  const[data,setData]=useState<RouteData|null>(null);
  const[busy,setBusy]=useState(false);
  const[tracking,setTracking]=useState(false);
  const[error,setError]=useState("");
  const watchId=useRef<number|null>(null);
  const lastSentAt=useRef(0);

  const load=async()=>{try{const response=await fetch(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`,{cache:"no-store"});const body=await response.json() as ApiResponse;if(response.ok&&body.data){setData(body.data);setError("");}else if(response.status!==404)throw new Error(body.error||"Unable to load route");}catch(err){setError(err instanceof Error?err.message:"Unable to load route");}};

  useEffect(()=>{let active=true;fetch(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`,{cache:"no-store"}).then(async response=>({response,body:await response.json() as ApiResponse})).then(({response,body})=>{if(!active)return;if(response.ok&&body.data)setData(body.data);else if(response.status!==404)setError(body.error||"Unable to load route");}).catch(()=>{});return()=>{active=false};},[bookingId,providerId]);

  const sendPosition=async(position:GeolocationPosition)=>{
    const response=await fetch("/api/grooming-route",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId,providerId,latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy,capturedAt:position.timestamp})});
    const body=await response.json() as ApiResponse;
    if(!response.ok||!body.data)throw new Error(body.error||"Unable to calculate route");
    setData(body.data);
    setError("");
  };

  const captureOnce=()=>{if(!navigator.geolocation){setError("Location is not supported on this device");return;}setBusy(true);setError("");navigator.geolocation.getCurrentPosition(async position=>{try{await sendPosition(position);}catch(err){setError(err instanceof Error?err.message:"Unable to calculate route");}finally{setBusy(false);}},geoError=>{setBusy(false);setError(geoError.message||"Location permission was not granted");},{enableHighAccuracy:true,timeout:15000,maximumAge:15000});};

  const stopTracking=()=>{if(watchId.current!==null&&navigator.geolocation){navigator.geolocation.clearWatch(watchId.current);}watchId.current=null;lastSentAt.current=0;setTracking(false);};

  const startTracking=()=>{
    if(!navigator.geolocation){setError("Location is not supported on this device");return;}
    if(watchId.current!==null)return;
    setError("");
    setTracking(true);
    watchId.current=navigator.geolocation.watchPosition(position=>{
      const now=Date.now();
      if(now-lastSentAt.current<8000)return;
      lastSentAt.current=now;
      void sendPosition(position).catch(err=>setError(err instanceof Error?err.message:"Unable to update GPS"));
    },geoError=>{setError(geoError.message||"Location permission was not granted");stopTracking();},{enableHighAccuracy:true,timeout:20000,maximumAge:5000});
  };

  useEffect(()=>()=>{if(watchId.current!==null&&typeof navigator!=="undefined"&&navigator.geolocation)navigator.geolocation.clearWatch(watchId.current);},[]);
  useEffect(()=>{const timer=window.setTimeout(()=>{stopTracking();void load();},0);return()=>window.clearTimeout(timer);},[bookingId,providerId]);

  return <section style={{marginTop:14,padding:16,borderRadius:18,border:"1px solid #dcece5",background:"#fff"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"flex-start"}}><div><small style={{fontWeight:900,color:"#1f6b57",letterSpacing:1}}>FOREGROUND GPS UAT</small><b style={{display:"block",marginTop:4,fontSize:16}}>Route, GPS & ETA</b></div><button onClick={()=>void load()} style={{border:"1px solid #dcece5",background:"white",borderRadius:10,padding:"8px 10px",fontWeight:800}}>↻</button></div>
    {!data&&!error&&<p style={{fontSize:12,color:"#6c7c78"}}>Customer destination appears after the canonical booking saves its service address.</p>}
    {data&&<><div style={{margin:"12px 0",padding:12,borderRadius:12,background:"#f2f7f5"}}><small style={{color:"#6e7e7a"}}>DESTINATION</small><b style={{display:"block",marginTop:4,fontSize:13}}>{data.destinationAddress}</b></div>{data.providerLocation&&<p style={{fontSize:11,margin:"0 0 8px",color:"#64736f"}}>Latest GPS captured {data.providerLocation.capturedAt?new Date(data.providerLocation.capturedAt).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit",second:"2-digit"}):"just now"}{Number.isFinite(data.providerLocation.accuracyMeters)?` · ±${Math.round(Number(data.providerLocation.accuracyMeters))} m`:""}</p>}{data.route?.status==="configured"&&<p style={{fontSize:13,margin:"0 0 8px"}}><b>ETA:</b> {mins(data.route.durationSeconds)} · {km(data.route.distanceMeters)}</p>}{data.route?.status==="configuration_required"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#7a5b20"}}>GPS capture works. Google Routes ETA waits for the approved UAT server key.</p>}{data.route?.status==="route_unavailable"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#9a3d32"}}>Route unavailable: {data.route.error}</p>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginTop:11}}>{!tracking?<button onClick={startTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#01261F",color:"white",fontWeight:900}}>▶ Start GPS</button>:<button onClick={stopTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#9b3038",color:"white",fontWeight:900}}>■ Stop GPS</button>}<button disabled={busy||tracking} onClick={captureOnce} style={{minHeight:47,border:"1px solid #dcece5",borderRadius:12,background:"white",color:"#01261F",fontWeight:900}}>{busy?"Locating…":"Update once"}</button></div>
      <a href={data.navigationUrl} target="_blank" rel="noreferrer" style={{display:"block",marginTop:9,padding:"12px",borderRadius:12,border:"1px solid #dcece5",textDecoration:"none",textAlign:"center",color:"#01261F",fontWeight:900}}>Open turn-by-turn in Google Maps ↗</a>
    </>}
    {tracking&&<div role="status" style={{marginTop:10,padding:"9px 11px",borderRadius:10,background:"#eaf8ef",color:"#176e45",fontSize:11,fontWeight:800}}>● GPS tracking on · updates while this screen stays open</div>}
    {error&&<p style={{fontSize:12,color:"#9a3d32",marginBottom:0}}>{error}</p>}
    <p style={{fontSize:10,color:"#798683",lineHeight:1.45,margin:"10px 0 0"}}>Location sharing is user-started and foreground-only in UAT. Leaving this screen or tapping Stop GPS ends the browser watch. Background tracking is not enabled.</p>
  </section>;
}
