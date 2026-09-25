import {env} from "cloudflare:workers";

export type LiveMapPoint={lat:number;lng:number};
type Input={provider:LiveMapPoint;destination:LiveMapPoint;polyline?:string|null;privacyRounded?:boolean};

function finite(value:number,min:number,max:number){return Number.isFinite(value)&&value>=min&&value<=max;}
function rounded(value:number){return Math.round(value*1000)/1000;}

export async function liveStaticMapResponse(input:Input){
 if(!finite(input.provider.lat,-90,90)||!finite(input.provider.lng,-180,180)||!finite(input.destination.lat,-90,90)||!finite(input.destination.lng,-180,180))return new Response("Live map coordinates are unavailable",{status:409,headers:{"cache-control":"no-store"}});
 const runtime=env as unknown as Record<string,unknown>,key=String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();
 if(!key)return new Response("Google Maps is not configured",{status:503,headers:{"cache-control":"no-store"}});
 const provider=input.privacyRounded?{lat:rounded(input.provider.lat),lng:rounded(input.provider.lng)}:input.provider;
 const url=new URL("https://maps.googleapis.com/maps/api/staticmap");
 url.searchParams.set("size","640x360");url.searchParams.set("scale","2");url.searchParams.set("maptype","roadmap");
 url.searchParams.append("markers","color:0x1f8f5f|label:P|"+provider.lat+","+provider.lng);
 url.searchParams.append("markers","color:0xc7962d|label:H|"+input.destination.lat+","+input.destination.lng);
 if(input.polyline)url.searchParams.append("path","weight:5|color:0x5d22a4ff|enc:"+input.polyline);
 url.searchParams.set("key",key);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{const response=await fetch(url.toString(),{signal:controller.signal});if(!response.ok)return new Response("Google map is temporarily unavailable",{status:502,headers:{"cache-control":"no-store"}});const bytes=await response.arrayBuffer();return new Response(bytes,{status:200,headers:{"content-type":response.headers.get("content-type")||"image/png","cache-control":"private, no-store, max-age=0","x-pawspace-map-source":"google-static-maps","x-pawspace-location-privacy":input.privacyRounded?"provider-rounded-3dp":"provider-owned-exact"}});}catch{return new Response("Google map is temporarily unavailable",{status:502,headers:{"cache-control":"no-store"}});}finally{clearTimeout(timer);}
}
