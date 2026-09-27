import{authError,database}from"../../../lib/server-auth";
import{GovernedRefusal}from"../../../lib/governed-http-error";
import{createTaxiQuote,listTaxiRouteClasses,type TaxiPaymentMode}from"../../../lib/taxi-governance";
import{createTaxiRideQuote}from"../../../lib/taxi-ride-governance";
import{computeTaxiRouteLeg}from"../../../lib/taxi-route-pricing";
import{TAXI_VEHICLES}from"../../../lib/taxi-business-rules";
import{geocodeAddress}from"../../../lib/address-autocomplete";
import{assertTaxiPickupInServiceArea}from"../../../lib/taxi-service-area";
const json=(value:unknown,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers:{"cache-control":"no-store",...headers}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Pet Taxi quote blocked",{status:403});}
/*
 * Every quote failure is governed JSON. A refusal (4xx) keeps its own sentence. A server-side failure - a
 * D1 outage, a Maps outage, our own deadline - is a 503 that names itself with a code and tells the
 * customer to try again; it used to be a redacted 500, or, when the work ran past the platform's limit, the
 * platform's HTML error page that the browser then failed to parse ("Unexpected token '<'").
 */
const QUOTE_RETRY_SECONDS=5;
const quoteRetry=(error:string)=>json({error,code:"TAXI_QUOTE_UNAVAILABLE",retryAfterSeconds:QUOTE_RETRY_SECONDS},503,{"retry-after":String(QUOTE_RETRY_SECONDS)});
async function failure(error:unknown){if(error instanceof Response&&error.status>=400&&error.status<600){const message=await error.text().catch(()=>"");if(error.status>=500)return quoteRetry(message||"Pet Taxi pricing is not available right now. Please try again in a moment.");return json({error:message||"Pet Taxi commercial request failed"},error.status);}if(error instanceof GovernedRefusal||error instanceof Response)return authError(error,"Pet Taxi commercial request failed");console.error("[taxi-commercial] quote failed",error);return quoteRetry("We could not calculate your Pet Taxi fare just now. Please try again in a moment.");}
export async function GET(request:Request){try{const scheduledStart=new URL(request.url).searchParams.get("scheduledStart")||new Date().toISOString(),routes=await listTaxiRouteClasses(await database(),scheduledStart);return json({data:{routes,vehicles:Object.values(TAXI_VEHICLES),source:"canonical_taxi_governance",routeSource:"google_routes_uat_for_new_rides",productionMapsVerified:false,liveAvailability:false,liveMoney:false}})}catch(error){return failure(error)}}
type RideBody={originLabel?:string;destinationLabel?:string;returnDropLabel?:string;passengerCount?:number;petCount?:number;luggageCount?:number;scheduledStart?:string;tripType?:"one_way"|"round_trip";ridePurpose?:"regular"|"airport";waitingMinutes?:number};
async function quote(request:Request){try{sameOriginWrite(request);let body:RideBody&{routeCode?:string;paymentMode?:TaxiPaymentMode;couponCode?:string};try{body=await request.json() as typeof body;}catch{return json({error:"The Pet Taxi quote request could not be read. Please try again."},400);}
  // Legacy route-class input remains executable for old callers while the customer UI uses address pricing.
  if(body.routeCode){if(!body.originLabel||!body.destinationLabel||!body.scheduledStart)return json({error:"Pet Taxi route, pickup, drop-off and pickup time are required"},400);const quote=await createTaxiQuote(await database(),{routeCode:body.routeCode,originLabel:body.originLabel,destinationLabel:body.destinationLabel,petCount:Number(body.petCount||0),scheduledStart:body.scheduledStart,paymentMode:body.paymentMode||"sandbox_deferred",couponCode:body.couponCode});return json({data:{...quote,liveMoney:false}},201)}
  const origin=String(body.originLabel||"").trim(),destination=String(body.destinationLabel||"").trim(),scheduledStart=String(body.scheduledStart||"").trim(),tripType=body.tripType||"one_way",ridePurpose=body.ridePurpose||"regular",returnDrop=String(body.returnDropLabel||"").trim();if(!origin||!destination||!scheduledStart)return json({error:"Pickup address, drop address, pickup date and time are required"},400);if(tripType==="round_trip"&&!returnDrop)return json({error:"Round trip requires a return drop address"},400);
  const {env}=await import("cloudflare:workers"),runtime=env as unknown as Record<string,unknown>,[originGeo,destinationGeo,returnGeo]=await Promise.all([geocodeAddress({address:origin}),geocodeAddress({address:destination}),tripType==="round_trip"?geocodeAddress({address:returnDrop}):Promise.resolve(null)]);if(originGeo.status!=="configured"||destinationGeo.status!=="configured"||!Number.isFinite(originGeo.latitude)||!Number.isFinite(originGeo.longitude)||!Number.isFinite(destinationGeo.latitude)||!Number.isFinite(destinationGeo.longitude)||tripType==="round_trip"&&(returnGeo?.status!=="configured"||!Number.isFinite(returnGeo?.latitude)||!Number.isFinite(returnGeo?.longitude)))return json({error:"Pet Taxi pickup and drop-off must resolve to verified map coordinates before quoting"},409);const originPoint={latitude:Number(originGeo.latitude),longitude:Number(originGeo.longitude)},destinationPoint={latitude:Number(destinationGeo.latitude),longitude:Number(destinationGeo.longitude)},returnPoint=returnGeo&&returnGeo.status==="configured"?{latitude:Number(returnGeo.latitude),longitude:Number(returnGeo.longitude)}:undefined;
  // The pickup is judged on where Google puts it, before any route is priced (lib/taxi-service-area.ts).
  await assertTaxiPickupInServiceArea(await database(),{pickup:originPoint});
  /* A round trip's two legs are priced at once (one Google Routes wait, not two); the outbound leg's refusal still wins, as when it was asked first. */const [outboundLeg,returnLegResult]=await Promise.allSettled([computeTaxiRouteLeg(runtime,originPoint,destinationPoint),tripType==="round_trip"&&returnPoint?computeTaxiRouteLeg(runtime,destinationPoint,returnPoint):Promise.resolve(null)]);if(outboundLeg.status==="rejected")throw outboundLeg.reason;if(returnLegResult.status==="rejected")throw returnLegResult.reason;const outbound=outboundLeg.value,returnLeg=returnLegResult.value,distanceKm=Math.round((outbound.distanceKm+(returnLeg?.distanceKm||0))*100)/100,estimatedDurationMinutes=outbound.durationMinutes+(returnLeg?.durationMinutes||0),routeProvider=outbound.provider==="sandbox_route_fallback"||returnLeg?.provider==="sandbox_route_fallback"?"sandbox_route_fallback":"google_routes_uat";const quote=await createTaxiRideQuote(await database(),{originLabel:origin,destinationLabel:destination,returnDropLabel:returnDrop||undefined,origin:originPoint,destination:destinationPoint,returnDrop:returnPoint,passengerCount:Number(body.passengerCount),petCount:Number(body.petCount),luggageCount:Number(body.luggageCount),scheduledStart,tripType,ridePurpose,waitingMinutes:Number(body.waitingMinutes||0),distanceKm,estimatedDurationMinutes,routeProvider});return json({data:quote},201)
 }catch(error){return failure(error)}}
/*
 * The quote answers inside TAXI_QUOTE_DEADLINE_MS. On staging one quote ran ~45 s and the customer got the
 * platform's HTML 500 instead of an answer; the geocode and Routes calls each stop at 8 s, but D1 set-up
 * and writes had no limit. At the deadline the customer gets a governed 503 with Retry-After, and the
 * unfinished work is handed to waitUntil so the runtime does not cancel it half-way (a cancelled promise
 * never settles; lib/financial-runtime-bootstrap.ts records what that did to later requests). An orphaned
 * quote row is harmless: a quote reserves nothing and expires in 15 minutes.
 */
export const TAXI_QUOTE_DEADLINE_MS=25_000;
async function finishAfterAnswer(work:Promise<unknown>){const settled=work.then(()=>undefined,()=>undefined);try{const runtime=await import("cloudflare:workers") as unknown as{waitUntil?:(promise:Promise<unknown>)=>void};runtime.waitUntil?.(settled);}catch{/* Outside a Worker (tests, scripts) nothing cancels the work. */}}
export async function executeTaxiRideQuote(request:Request,options:{deadlineMs?:number}={}){
 const deadlineMs=options.deadlineMs??TAXI_QUOTE_DEADLINE_MS,work=quote(request);let timer:ReturnType<typeof setTimeout>|undefined;
 const answered=await Promise.race([work,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),deadlineMs);})]);clearTimeout(timer);
 if(answered)return answered;
 await finishAfterAnswer(work);
 console.warn(JSON.stringify({event:"taxi_quote_deadline_exceeded",deadlineMs}));
 return json({error:"Calculating your Pet Taxi fare is taking longer than usual. Please try again in a moment.",code:"TAXI_QUOTE_TIMEOUT",retryAfterSeconds:QUOTE_RETRY_SECONDS},503,{"retry-after":String(QUOTE_RETRY_SECONDS)});
}
export async function POST(request:Request){return executeTaxiRideQuote(request);}
