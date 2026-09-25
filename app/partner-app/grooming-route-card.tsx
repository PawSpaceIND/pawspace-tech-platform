"use client";

import{useEffect,useRef,useState}from"react";
import{FOREGROUND_GPS_INTERVAL_MS,gpsIngestionKey,shouldApplyTelemetryResponse}from"../../lib/gps-telemetry-policy";
import LiveTrackingPanel from"../components/live-tracking/live-tracking-panel";

type AddressPrecision="full"|"area"|"billing"|"none";
type RouteData={bookingId:string;providerId:string;addressPrecision?:AddressPrecision;destinationAddress?:string|null;destinationCoordinates?:{lat:number;lng:number}|null;providerLocation:{lat:number;lng:number;accuracyMeters?:number;capturedAt?:number;serverReceivedAt?:number;trustState?:string;eventId?:string}|null;navigationUrl?:string|null;travelState?:string;route?:{status:string;distanceMeters?:number;durationSeconds?:number;error?:string}|null;path?:{distanceFromPreviousMeters:number;cumulativeDistanceMeters:number};telemetryAccepted?:boolean;rejectionReason?:string|null};
type ApiResponse={data?:RouteData;error?:string};

/**
 * Why the doorstep is not on screen.
 *
 * The route returns addressPrecision on both verbs and the card never declared it, so when the policy
 * narrowed the address - a completed booking past its 72h dispute window resolves to "none" - the
 * destination and the navigation link simply vanished behind the generic "Verified customer doorstep"
 * placeholder, which reads as a value rather than as an absence.
 */
const precisionNote=(precision:AddressPrecision|undefined)=>{
 if(precision==="area")return"The full doorstep opens closer to the appointment. Only the area is shared right now.";
 if(precision==="billing")return"Only a billing area is on file for this booking, not a service doorstep.";
 if(precision==="none")return"Address access for this booking has closed. Ask Ops to reopen it if you still need to travel here.";
 return"";
};

/** The trust verdicts classifyGpsObservation can return, in the partner's terms. */
const REJECTION_NOTE:Record<string,string>={
 gps_kill_switch_active:"Location sharing is switched off platform-wide right now.",
 invalid_coordinates:"That fix had impossible coordinates and was not stored.",
 invalid_capture_timestamp:"That fix had no usable capture time and was not stored.",
 freshness_policy_not_configured:"Location policy is not configured for this booking yet, so fixes cannot be trusted.",
 accuracy_policy_not_configured:"Accuracy policy is not configured for this booking yet, so fixes cannot be trusted.",
 client_capture_ahead_of_server_time:"This phone's clock is ahead of PawSpace. Turn on automatic date and time.",
 client_capture_outside_freshness_window:"That fix was too old by the time it arrived. Stay on this screen while tracking.",
 accuracy_not_reported_by_device:"This phone did not report GPS accuracy, so the fix could not be trusted.",
 accuracy_reported_as_negative:"This phone reported an invalid GPS accuracy, so the fix could not be trusted.",
 accuracy_outside_approved_policy:"GPS accuracy is outside the approved range. Move into the open or away from tall buildings.",
};
const rejectionNote=(reason:string|null|undefined)=>reason?REJECTION_NOTE[reason]||`That fix was not accepted (${reason.replaceAll("_"," ")}).`:"That fix was not accepted.";

const km=(meters:unknown)=>`${(Number(meters||0)/1000).toFixed(1)} km`;
const mins=(seconds:unknown)=>`${Math.max(1,Math.round(Number(seconds||0)/60))} min`;

export default function GroomingRouteCard({bookingId,providerId,managedTracking=false}:{bookingId:string;providerId:string;managedTracking?:boolean}){
  const[data,setData]=useState<RouteData|null>(null),[busy,setBusy]=useState(false),[tracking,setTracking]=useState(false),[error,setError]=useState(""),[mapTick,setMapTick]=useState(0);
  // Held apart from `data` on purpose: a rejected fix must explain itself WITHOUT overwriting the last
  // accepted route and ETA, which are still the best information the partner has.
  const[rejection,setRejection]=useState<{trustState?:string;reason?:string|null}|null>(null);
  const watchId=useRef<number|null>(null),lastSentAt=useRef(0),inFlight=useRef(false),pending=useRef<GeolocationPosition|null>(null),controller=useRef<AbortController|null>(null),sequence=useRef(0),lastAppliedSequence=useRef(0),mounted=useRef(true);

  const load=async()=>{try{const response=await fetch(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`,{cache:"no-store"});const body=await response.json() as ApiResponse;if(response.ok&&body.data){setData(body.data);setMapTick(value=>value+1);setError("");}else if(response.status!==404)throw new Error(body.error||"Unable to load route");}catch(err){setError(err instanceof Error?err.message:"Unable to load route");}};

  const transmit=async(position:GeolocationPosition)=>{
    const seq=++sequence.current,abort=new AbortController();controller.current=abort;inFlight.current=true;
    const telemetry={bookingId,providerId,latitude:position.coords.latitude,longitude:position.coords.longitude,accuracyMeters:position.coords.accuracy,capturedAt:position.timestamp};
    try{
      const response=await fetch("/api/grooming-route",{method:"POST",signal:abort.signal,headers:{"content-type":"application/json"},body:JSON.stringify({...telemetry,idempotencyKey:gpsIngestionKey(telemetry)})});
      const body=await response.json().catch(()=>({})) as ApiResponse;
      if(!mounted.current)return;
      if(body.data&&shouldApplyTelemetryResponse(seq,lastAppliedSequence.current)){
        lastAppliedSequence.current=seq;
        if(response.ok){setData(previous=>({...previous,...body.data} as RouteData));setMapTick(value=>value+1);setRejection(null);}
        // A 422 carries the classified verdict alongside the error. It used to be discarded, leaving the
        // partner with a raw "GPS observation rejected: accuracy_outside_approved_policy" and no idea
        // that stepping into the open would fix it.
        else if(response.status===422)setRejection({trustState:body.data.providerLocation?.trustState,reason:body.data.rejectionReason??null});
      }
      if(response.status===422){setError("");return;}
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
      // rejection describes ONE booking's refused fix. It is cleared only by a 200 or replaced by a
      // later 422, so without this it stayed on screen after switching jobs - the previous booking's
      // amber GPS warning sitting under the new booking's route.
      setRejection(null);
      void load();
    },0);
    const poll=managedTracking?window.setInterval(()=>void load(),30000):undefined;
    return()=>{window.clearTimeout(timer);if(poll)window.clearInterval(poll);mounted.current=false;if(watchId.current!==null&&typeof navigator!=="undefined"&&navigator.geolocation)navigator.geolocation.clearWatch(watchId.current);controller.current?.abort();pending.current=null;};
  },[bookingId,providerId,managedTracking]);

  return <section style={{marginTop:14,padding:16,borderRadius:18,border:"1px solid #e7dcef",background:"#fff"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"flex-start"}}><div><small style={{fontWeight:900,color:"#7540aa",letterSpacing:1}}>{managedTracking?"ACTIVE JOB LOCATION":"FOREGROUND GPS"}</small><b style={{display:"block",marginTop:4,fontSize:16}}>Trusted route, GPS & ETA</b></div><button onClick={()=>void load()} style={{border:"1px solid #d8cae7",background:"white",borderRadius:10,padding:"8px 10px",fontWeight:800}}>↻</button></div>
    {!data&&!error&&<p style={{fontSize:12,color:"#746b7d"}}>The verified customer doorstep appears after the canonical booking saves its mapped coordinates.</p>}
    {data&&<><div style={{margin:"12px 0"}}><LiveTrackingPanel title="Route to customer" eyebrow={managedTracking?"ACTIVE JOB LOCATION":"PARTNER NAVIGATION"} state={data.travelState||"tracking"} mapUrl={data.providerLocation&&data.destinationCoordinates?`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}&map=1&v=${mapTick}`:null} mapKey={mapTick} etaMinutes={data.route?.durationSeconds!=null?Number(data.route.durationSeconds)/60:null} distanceKm={data.route?.distanceMeters!=null?Number(data.route.distanceMeters)/1000:null} providerLabel="You" detail={data.providerLocation?"Trusted GPS is driving this route. Recenter refreshes the latest canonical map; stale or rejected fixes never replace the last trusted position.":"Share a trusted GPS fix to start the live route."} live={Boolean(data.providerLocation&&data.route?.status==="configured")} onRecenter={()=>setMapTick(value=>value+1)} actions={data.navigationUrl?[{label:"Open navigation",href:data.navigationUrl,kind:"primary",external:true}]:[]}/></div><div style={{margin:"12px 0",padding:12,borderRadius:12,background:"#f8f5fb"}}><small style={{color:"#786b81"}}>DESTINATION</small><b style={{display:"block",marginTop:4,fontSize:13}}>{data.destinationAddress||(data.addressPrecision&&data.addressPrecision!=="full"?"Doorstep not shared yet":"Verified customer doorstep")}</b>{!data.destinationAddress&&precisionNote(data.addressPrecision)&&<span style={{display:"block",marginTop:5,fontSize:11,color:"#6d6275"}}>{precisionNote(data.addressPrecision)}</span>}</div>{data.providerLocation&&<p style={{fontSize:11,margin:"0 0 8px",color:"#6d6275"}}>Latest trusted GPS {data.providerLocation.capturedAt?new Date(data.providerLocation.capturedAt).toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit",second:"2-digit"}):"just now"}{Number.isFinite(data.providerLocation.accuracyMeters)?` · ±${Math.round(Number(data.providerLocation.accuracyMeters))} m`:""}</p>}{data.route?.status==="configured"&&<p style={{fontSize:13,margin:"0 0 8px"}}><b>ETA:</b> {mins(data.route.durationSeconds)} · {km(data.route.distanceMeters)}</p>}{data.path&&<p style={{fontSize:11,margin:"0 0 8px",color:"#6d6275"}}>Travelled since tracking start: {km(data.path.cumulativeDistanceMeters)} · last delta {Math.round(data.path.distanceFromPreviousMeters)} m</p>}{data.route?.status==="configuration_required"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#7a5b20"}}>Trusted GPS capture works. Google Routes ETA waits for the approved UAT server key.</p>}{data.route?.status==="route_unavailable"&&<p style={{fontSize:12,margin:"0 0 8px",color:"#9a3d32"}}>Route unavailable: {data.route.error}</p>}
      {!managedTracking&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginTop:11}}>{!tracking?<button onClick={startTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#4b168c",color:"white",fontWeight:900}}>▶ Start GPS</button>:<button onClick={stopTracking} style={{minHeight:47,border:0,borderRadius:12,background:"#9b3038",color:"white",fontWeight:900}}>■ Stop GPS</button>}<button disabled={busy||tracking} onClick={captureOnce} style={{minHeight:47,border:"1px solid #d8cae7",borderRadius:12,background:"white",color:"#4b168c",fontWeight:900}}>{busy?"Locating…":"Update once"}</button></div>}
      {data.navigationUrl&&<a href={data.navigationUrl} target="_blank" rel="noreferrer" style={{display:"block",marginTop:9,padding:"12px",borderRadius:12,border:"1px solid #d8cae7",textDecoration:"none",textAlign:"center",color:"#4b168c",fontWeight:900}}>Navigate ↗</a>}
    </>}
    {rejection&&<div role="status" style={{marginTop:10,padding:"9px 11px",borderRadius:10,background:"#fdf3e7",color:"#7a5b20",fontSize:11,fontWeight:700}}>{rejectionNote(rejection.reason)}{rejection.trustState?` (${rejection.trustState.replaceAll("_"," ")})`:""} The last trusted fix and ETA above are unchanged.</div>}
    {tracking&&<div role="status" style={{marginTop:10,padding:"9px 11px",borderRadius:10,background:"#eaf8ef",color:"#176e45",fontSize:11,fontWeight:800}}>● GPS tracking on · one request at a time · latest fix queued</div>}
    {error&&<p style={{fontSize:12,color:"#9a3d32",marginBottom:0}}>{error}</p>}
    <p style={{fontSize:10,color:"#817887",lineHeight:1.45,margin:"10px 0 0"}}>{managedTracking?"Location sharing follows this accepted job. Native background tracking requires device permission; keep browsers open.":"This manual GPS view tracks only while open."} Stale or inaccurate fixes never drive ETA or arrival.</p>
  </section>;
}
