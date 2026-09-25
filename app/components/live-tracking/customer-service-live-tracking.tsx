"use client";
import{useEffect,useRef,useState}from"react";
import LiveTrackingPanel from"./live-tracking-panel";

type TrackingState="not_started"|"not_sharing"|"live"|"stale"|"unavailable"|"ended";
type Payload={bookingId:string;serviceCode:string;status:string;title:string;provider:{id:string|null;name:string|null};tracking:{state:TrackingState;etaMinutes:number|null;distanceKm:number|null};mapAvailable:boolean;mapVersion:number|null};
type Api={data?:Payload;error?:string};

const copy=(state:TrackingState,serviceCode:string)=>{
 if(state==="live")return serviceCode==="pet_taxi"?"Live GPS and ETA are updating from the driver’s trusted location.":"Live GPS and ETA are updating from the walker’s trusted location.";
 if(state==="stale")return"The latest route update is stale. PawSpace will refresh when a newer trusted location arrives.";
 if(state==="unavailable")return"Location sharing is active, but a fresh route ETA is not available yet.";
 if(state==="not_sharing")return"Waiting for the provider’s first trusted location update.";
 if(state==="ended")return"Location sharing has ended for this booking.";
 return"Live tracking starts when the provider begins the active journey.";
};

export default function CustomerServiceLiveTracking({bookingId}:{bookingId:string}){
 const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[mapTick,setMapTick]=useState(0),version=useRef(0);
 useEffect(()=>{if(!bookingId)return;let active=true,current:AbortController|null=null;
  const load=async()=>{const v=++version.current;current?.abort();const controller=new AbortController();current=controller;try{const r=await fetch(`/api/customer-live-tracking?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store",signal:controller.signal}),b=await r.json() as Api;if(!r.ok||!b.data)throw new Error(b.error||"Unable to load live tracking");if(active&&v===version.current){setData(b.data);setMapTick(Number(b.data.mapVersion||0));setError("");}}catch(e){if(controller.signal.aborted)return;if(active&&v===version.current)setError(e instanceof Error?e.message:"Unable to load live tracking");}};
  const first=window.setTimeout(()=>void load(),0),timer=window.setInterval(()=>void load(),5000);
  return()=>{active=false;version.current+=1;window.clearTimeout(first);window.clearInterval(timer);current?.abort();};
 },[bookingId]);
 if(!data&&error)return <p role="alert">{error}</p>;
 if(!data)return <p role="status">Loading live tracking…</p>;
 const actions=data.serviceCode==="pet_taxi"?[{label:"Chat support",href:"/chat",kind:"primary" as const},{label:"Trip help",href:"/contact",kind:"secondary" as const}]:[{label:"Chat support",href:"/chat",kind:"primary" as const},{label:"Walk help",href:"/contact",kind:"secondary" as const}];
 return <div style={{marginBottom:16}}><LiveTrackingPanel title={data.title} eyebrow={data.serviceCode==="pet_taxi"?"LIVE PET TAXI":"LIVE WALK"} state={data.tracking.state} mapUrl={data.mapAvailable&&data.tracking.state==="live"?`/api/customer-live-tracking?bookingId=${encodeURIComponent(bookingId)}&map=1&v=${mapTick}`:null} mapKey={mapTick} etaMinutes={data.tracking.etaMinutes} distanceKm={data.tracking.distanceKm} providerLabel={data.provider.name||data.provider.id} detail={copy(data.tracking.state,data.serviceCode)} live={data.tracking.state==="live"} onRecenter={data.mapAvailable?()=>setMapTick(value=>value+1):undefined} actions={actions}/>{error&&<p role="status" style={{fontSize:11,color:"#9a3d32"}}>Live tracking refresh issue: {error}</p>}</div>;
}
