type Runtime=Record<string,unknown>;
export type TaxiRouteLeg={distanceKm:number;durationMinutes:number;provider:"google_routes_uat";providerReference:string};
const parseDuration=(value:unknown)=>{const raw=String(value||"");const match=raw.match(/^(\d+(?:\.\d+)?)s$/);return match?Number(match[1]):Number.NaN};
export async function computeTaxiRouteLeg(runtime:Runtime,originAddress:string,destinationAddress:string,fetcher:typeof fetch=fetch):Promise<TaxiRouteLeg>{
 const origin=originAddress.trim(),destination=destinationAddress.trim();
 if(origin.length<5||destination.length<5||origin.toLowerCase()===destination.toLowerCase())throw new Response("Pet Taxi requires distinct complete pickup and drop addresses",{status:400});
 if(String(runtime.PAWSPACE_MAPS_ENV||"sandbox").toLowerCase()!=="sandbox")throw new Response("Pet Taxi UAT route pricing is locked to the Maps sandbox adapter",{status:409});
 const key=String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();if(!key)throw new Response("Pet Taxi route pricing needs GOOGLE_MAPS_SERVER_API_KEY_UAT",{status:503});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetcher("https://routes.googleapis.com/directions/v2:computeRoutes",{method:"POST",signal:controller.signal,headers:{"content-type":"application/json","X-Goog-Api-Key":key,"X-Goog-FieldMask":"routes.duration,routes.distanceMeters"},body:JSON.stringify({origin:{address:origin},destination:{address:destination},travelMode:"DRIVE",routingPreference:"TRAFFIC_AWARE",languageCode:"en-IN",units:"METRIC"})});
  if(!response.ok)throw new Response("Pet Taxi route could not be calculated from the supplied addresses",{status:409});
  const body=await response.json().catch(()=>({})) as{routes?:Array<{duration?:unknown;distanceMeters?:unknown}>};const route=body.routes?.[0],distance=route?.distanceMeters,durationSeconds=parseDuration(route?.duration);
  if(typeof distance!=="number"||!Number.isFinite(distance)||distance<=0||!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Response("Pet Taxi route returned no usable distance/duration",{status:409});
  return{distanceKm:Math.round(distance/10)/100,durationMinutes:Math.max(1,Math.ceil(durationSeconds/60)),provider:"google_routes_uat",providerReference:"google_routes_uat"};
 }catch(error){if(controller.signal.aborted)throw new Response("Pet Taxi route pricing timed out; retry the addresses",{status:504});throw error}finally{clearTimeout(timer)}
}
