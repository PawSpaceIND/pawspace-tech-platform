type Runtime=Record<string,unknown>;
export type TaxiRouteLeg={distanceKm:number;durationMinutes:number;provider:"google_routes_uat"|"sandbox_route_fallback";providerReference:string};
const parseDuration=(value:unknown)=>{const raw=String(value||"");const match=raw.match(/^(\d+(?:\.\d+)?)s$/);return match?Number(match[1]):Number.NaN};

export type TaxiRoutePoint={latitude:number;longitude:number};
const validPoint=(point:TaxiRoutePoint)=>Number.isFinite(point.latitude)&&point.latitude>=-90&&point.latitude<=90&&Number.isFinite(point.longitude)&&point.longitude>=-180&&point.longitude<=180;
// A leg is priced from addresses (Google resolves them) or from already-verified coordinates, which are
// sent as latLng waypoints so the priced route is the one between the exact points the quote freezes.
const waypoint=(value:string|TaxiRoutePoint)=>typeof value==="string"?{address:value.trim()}:{location:{latLng:{latitude:value.latitude,longitude:value.longitude}}};
export async function computeTaxiRouteLeg(runtime:Runtime,originInput:string|TaxiRoutePoint,destinationInput:string|TaxiRoutePoint,fetcher:typeof fetch=fetch):Promise<TaxiRouteLeg>{
 const sameKey=(value:string|TaxiRoutePoint)=>typeof value==="string"?value.trim().toLowerCase():`${value.latitude},${value.longitude}`;
 const complete=(value:string|TaxiRoutePoint)=>typeof value==="string"?value.trim().length>=5:validPoint(value);
 if(!complete(originInput)||!complete(destinationInput)||sameKey(originInput)===sameKey(destinationInput))throw new Response("Pet Taxi requires distinct complete pickup and drop addresses",{status:400});
 if(String(runtime.PAWSPACE_MAPS_ENV||"sandbox").toLowerCase()!=="sandbox")throw new Response("Pet Taxi UAT route pricing is locked to the Maps sandbox adapter",{status:409});
 const key=String(runtime.GOOGLE_ROUTES_SERVER_API_KEY_UAT||runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();if(!key){console.warn("[taxi-route-pricing] Google Routes UAT server key is not configured; route pricing refused");throw new Response("Pet Taxi route pricing is not available right now. Please try again later or contact PawSpace support.",{status:503});}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetcher("https://routes.googleapis.com/directions/v2:computeRoutes",{method:"POST",signal:controller.signal,headers:{"content-type":"application/json","X-Goog-Api-Key":key,"X-Goog-FieldMask":"routes.duration,routes.distanceMeters"},body:JSON.stringify({origin:waypoint(originInput),destination:waypoint(destinationInput),travelMode:"DRIVE",routingPreference:"TRAFFIC_AWARE",languageCode:"en-IN",units:"METRIC"})});
  if(!response.ok){
   if([401,403,429].includes(response.status)||response.status>=500)throw new Response("Pet Taxi route service is temporarily unavailable. Please try again later.",{status:503});
   throw new Response("Pet Taxi route could not be calculated from the supplied addresses",{status:409});
  }
  const body=await response.json().catch(()=>({})) as{routes?:Array<{duration?:unknown;distanceMeters?:unknown}>};const route=body.routes?.[0],distance=route?.distanceMeters,durationSeconds=parseDuration(route?.duration);
  if(typeof distance!=="number"||!Number.isFinite(distance)||distance<=0||!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Response("Pet Taxi route returned no usable distance/duration",{status:409});
  return{distanceKm:Math.round(distance/10)/100,durationMinutes:Math.max(1,Math.ceil(durationSeconds/60)),provider:"google_routes_uat",providerReference:"google_routes_uat"};
 }catch(error){
  if(controller.signal.aborted)throw new Response("Pet Taxi route calculation timed out. Please try again.",{status:503});
  throw error;
 }finally{clearTimeout(timer)}
}
