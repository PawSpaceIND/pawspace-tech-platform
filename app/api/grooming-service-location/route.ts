import{authError,authFailure,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{ensureGroomingMapTables,mapsNavigationUrl}from"../../../lib/grooming-maps";
import{ensureCustomerAccountTables}from"../../../lib/customer-account";
import{validateIndianPincode}from"../../../lib/pincode-validation";
import{publicAddressRefusal,resolveGovernedServiceAddress,type GovernedServiceAddress}from"../../../lib/service-discovery-address";
import{resolveZoneByPincode}from"../../../lib/service-zones";
import{validGpsCoordinates}from"../../../lib/gps-telemetry-policy";

type Input={bookingId:string;customerId:string;address:string;pincode?:string;latitude?:number;longitude?:number;saveAddress?:boolean};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Browser coordinates are never location authority here. Service discovery resolves the canonical address and
// coordinates server-side and says where they came from; that provenance is stored as-is, never relabelled.
function verifiedCoordinates(governed:GovernedServiceAddress){
 const latitude=Number(governed.latitude),longitude=Number(governed.longitude);
 if(!validGpsCoordinates(latitude,longitude))throw authFailure("The doorstep address could not be resolved to verified map coordinates. Re-pick the address or move the pin, then save again.",409);
 return{latitude,longitude,source:governed.coordinateSource};
}
/** The governed refusal as safe customer copy: no resolver text, provider message or address leaves the server. */
async function governedAddress(db:Awaited<ReturnType<typeof database>>,input:Parameters<typeof resolveGovernedServiceAddress>[1]):Promise<GovernedServiceAddress|Response>{
 try{return await resolveGovernedServiceAddress(db,input);}
 catch(error){if(error instanceof Response&&(error.status===400||error.status===409)){
  const detail=await error.clone().text().catch(()=>""),mapped=publicAddressRefusal(error.status,detail);
  // A coverage refusal keeps its governed reason code (city_paused, service_zone_unavailable, ...) with a fixed server
  // sentence; nothing from the request or a provider is echoed. Every other refusal answers with the public mapping.
  if(mapped.code==="SERVICE_ADDRESS_NOT_COVERED"){let code="";try{code=String((JSON.parse(detail) as {code?:unknown}).code??"");}catch{code="";}if(/^[a-z_]{3,64}$/.test(code))return json({error:"PawSpace is not currently serving this address",code,reason:mapped.reason},error.status);}
  return json(mapped,error.status);}throw error;}
}
/**
 * The doorstep the scheduling route bound to this booking's reservation group. Three outcomes, kept apart:
 *  - "bound": the group recorded a governed address id; only that doorstep may be saved.
 *  - "absent": PROVEN legacy absence: no group id, no decisions table, no decision row, or a decision that parses and
 *    never recorded a doorstep (an older array-shaped shortlist, an object without a request, or a request without
 *    serviceAddressId). The legacy zone check and the no-overwrite rule apply.
 *  - "unverifiable": the authority exists but cannot be read or is malformed: a database read error, unparseable
 *    JSON, a JSON primitive, a request that is not an object, or a recorded id that is not a non-empty string. This
 *    is never treated as absence: the save is refused.
 */
type ReservedDoorstep={state:"absent"}|{state:"unverifiable"}|{state:"bound";addressId:string;address:string;pincode:string};
async function schemaHas(db:Awaited<ReturnType<typeof database>>,table:string,column?:string){
 const present=await db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").bind(table).first();
 if(!present||!column)return Boolean(present);
 const columns=await db.prepare(`PRAGMA table_info(${table})`).all<Record<string,unknown>>();
 return columns.results.some(row=>String(row.name)===column);
}
async function reservedDoorstep(db:Awaited<ReturnType<typeof database>>,bookingId:string):Promise<ReservedDoorstep>{
 let group:Record<string,unknown>|null;
 try{group=await db.prepare("SELECT schedule_group_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();}
 catch{try{return await schemaHas(db,"canonical_bookings","schedule_group_id")?{state:"unverifiable"}:{state:"absent"};}catch{return{state:"unverifiable"};}}
 const groupId=String(group?.schedule_group_id??"").trim();
 if(!groupId)return{state:"absent"};
 try{if(!await schemaHas(db,"scheduling_assignment_decisions"))return{state:"absent"};}catch{return{state:"unverifiable"};}
 let decision:Record<string,unknown>|null;
 try{decision=await db.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId).first<Record<string,unknown>>();}catch{return{state:"unverifiable"};}
 if(!decision)return{state:"absent"};
 let parsed:unknown;
 try{parsed=JSON.parse(String(decision.shortlist_json??""));}catch{return{state:"unverifiable"};}
 if(!parsed||typeof parsed!=="object")return{state:"unverifiable"};
 if(Array.isArray(parsed)||!Object.prototype.hasOwnProperty.call(parsed,"request"))return{state:"absent"};
 const request=(parsed as {request?:unknown}).request;
 if(!request||typeof request!=="object"||Array.isArray(request))return{state:"unverifiable"};
 const recorded=request as Record<string,unknown>;
 if(!Object.prototype.hasOwnProperty.call(recorded,"serviceAddressId"))return{state:"absent"};
 if(typeof recorded.serviceAddressId!=="string"||!recorded.serviceAddressId.trim())return{state:"unverifiable"};
 return{state:"bound",addressId:recorded.serviceAddressId,address:String(recorded.serviceAddress??"").trim(),pincode:String(recorded.servicePincode??"").trim()};
}
/** Whether this doorstep is one of the customer's saved addresses right now (the account-save state the response reports). */
async function accountHasAddress(db:Awaited<ReturnType<typeof database>>,customerId:string,addressId:string){
 return Boolean(await db.prepare("SELECT 1 FROM customer_addresses WHERE id=? AND customer_id=?").bind(addressId,customerId).first());
}

export async function POST(request:Request){try{
 const input=await request.json()as Input,bookingId=String(input.bookingId||"").trim(),customerId=String(input.customerId||"").trim(),address=String(input.address||"").trim(),pin=validateIndianPincode(typeof input.pincode==="string"?input.pincode:null);/* An explicit PIN only: none is extracted from the address text. */
 if(!bookingId||!customerId||address.length<8||!pin.ok)return json({error:"Booking, customer, complete doorstep address and six-digit pincode are required"},400);
 const db=await database();await ensureGroomingMapTables(db);await ensureCustomerAccountTables(db);const actor=await resolveActor(request);await requireCustomerOwnership(db,actor,customerId);
 const booking=await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,zone_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();
 if(!booking)return json({error:"Canonical booking not found"},404);if(String(booking.customer_id)!==customerId)return json({error:"Customer does not own this booking"},403);if(String(booking.service_code)!=="grooming")return json({error:"This endpoint is currently limited to Grooming UAT"},409);
 const resolvedZone=await resolveZoneByPincode(db,pin.pincode);if(!resolvedZone||!resolvedZone.zone.serviceAvailable)return json({error:"PawSpace is not currently serving this address",code:"service_zone_unavailable"},409);
 const resolvedCity=String(resolvedZone.assignment.cityId||"").trim().toLowerCase();if(String(booking.zone_id)!==resolvedZone.assignment.zoneId||String(booking.city_id).toLowerCase()!==resolvedCity)return json({error:"The verified address zone does not match the booking reservation"},409);
 // The doorstep must be the one this booking's reservation was made for, not merely an address in the same zone.
 const reserved=await reservedDoorstep(db,bookingId),mismatch=()=>json({error:"This address is not the doorstep this booking was reserved for. Book again for a different address.",code:"booking_doorstep_mismatch"},409);
 // Corrupt or unreadable authority fails CLOSED, before any geocode, doorstep or account-address write.
 if(reserved.state==="unverifiable")return json({error:"We could not verify the doorstep this booking was reserved for. Nothing was saved; please contact PawSpace support.",code:"booking_doorstep_unverifiable"},409);
 const bound=reserved.state==="bound"?reserved:null;
 if(bound&&bound.address&&(bound.address!==address||(bound.pincode&&bound.pincode!==pin.pincode)))return mismatch();
 // Resolve without saving first; the customer's saved places change only after the doorstep is proven to be this booking's.
 let governed=await governedAddress(db,{customerId,serviceCode:"grooming",serviceAddress:address,servicePincode:pin.pincode,latitude:input.latitude,longitude:input.longitude,requireCoordinateProvenance:true,saveToAccount:false});
 if(governed instanceof Response)return governed;
 if(governed.zoneId!==String(booking.zone_id)||governed.cityId!==String(booking.city_id).toLowerCase())return json({error:"The verified address zone does not match the booking reservation"},409);
 if(bound&&bound.addressId!==governed.addressId)return mismatch();
 // An existing doorstep is never overwritten: the same doorstep answers idempotently, a different one is refused.
 const existing=await db.prepare("SELECT address_id,address_text,latitude,longitude,source FROM booking_service_locations WHERE booking_id=?").bind(bookingId).first<Record<string,unknown>>();
 if(existing){
  if(String(existing.address_id||"")!==governed.addressId)return json({error:"This booking already has a different doorstep recorded. Contact PawSpace support to change it.",code:"booking_doorstep_exists"},409);
  // A later explicit account-save choice is honoured on the same doorstep (deduplicated by the resolver; it never
  // replaces the booking doorstep or the default address). An explicit false never deletes a saved address.
  let accountAddressSaved=await accountHasAddress(db,customerId,governed.addressId);
  if(input.saveAddress===true&&!accountAddressSaved){const saved=await governedAddress(db,{customerId,serviceCode:"grooming",serviceAddress:address,servicePincode:pin.pincode,latitude:input.latitude,longitude:input.longitude,requireCoordinateProvenance:true,saveToAccount:true});if(saved instanceof Response)return saved;if(saved.addressId!==governed.addressId)return mismatch();accountAddressSaved=await accountHasAddress(db,customerId,governed.addressId);}
  return json({data:{bookingId,addressSaved:true,coordinatesSaved:Number.isFinite(Number(existing.latitude))&&Number.isFinite(Number(existing.longitude)),coordinateSource:String(existing.source),latitude:Number(existing.latitude),longitude:Number(existing.longitude),navigationUrl:mapsNavigationUrl(String(existing.address_text)),cityId:governed.cityId,zoneId:governed.zoneId,serviceRadiusKm:governed.serviceRadiusKm,duplicatePrevented:true,accountAddressSaved}},200);
 }
 if(input.saveAddress!==false){const saved=await governedAddress(db,{customerId,serviceCode:"grooming",serviceAddress:address,servicePincode:pin.pincode,latitude:input.latitude,longitude:input.longitude,requireCoordinateProvenance:true,saveToAccount:true});if(saved instanceof Response)return saved;if(saved.addressId!==governed.addressId)return mismatch();governed=saved;}
 const coordinates=verifiedCoordinates(governed),now=Date.now(),completeAddress=governed.address;
 await db.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,'active',?,?) ON CONFLICT(booking_id) DO NOTHING").bind(bookingId,customerId,String(booking.provider_id),governed.addressId,completeAddress,coordinates.latitude,coordinates.longitude,coordinates.source,now,now).run();
 /* A concurrent save of a different doorstep wins nothing here either: what is stored must be this doorstep. */const stored=await db.prepare("SELECT address_id FROM booking_service_locations WHERE booking_id=?").bind(bookingId).first<Record<string,unknown>>();if(String(stored?.address_id||"")!==governed.addressId)return json({error:"This booking already has a different doorstep recorded. Contact PawSpace support to change it.",code:"booking_doorstep_exists"},409);
 await securityAudit(db,actor,"grooming.service_location.save","booking",bookingId,"completed",{hasCoordinates:true,coordinateSource:coordinates.source,addressLength:address.length,zoneId:governed.zoneId});
 /* addressSaved: the booking doorstep is recorded. accountAddressSaved: this doorstep is one of the customer's saved addresses. */return json({data:{bookingId,addressSaved:true,coordinatesSaved:true,coordinateSource:coordinates.source,latitude:coordinates.latitude,longitude:coordinates.longitude,navigationUrl:mapsNavigationUrl(completeAddress),cityId:governed.cityId,zoneId:governed.zoneId,serviceRadiusKm:governed.serviceRadiusKm,accountAddressSaved:await accountHasAddress(db,customerId,governed.addressId)}},201);
 }catch(error){if(error instanceof Response)return error;return authError(error,"Unable to save Grooming service location");}}
