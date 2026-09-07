import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{ensureGroomingMapTables,mapsNavigationUrl}from"../../../lib/grooming-maps";
import{ensureCustomerAccountTables}from"../../../lib/customer-account";
import{validateIndianPincode}from"../../../lib/pincode-validation";
import{resolveGovernedServiceAddress,type GovernedServiceAddress}from"../../../lib/service-discovery-address";
import{resolveZoneByPincode}from"../../../lib/service-zones";
import{validGpsCoordinates}from"../../../lib/gps-telemetry-policy";

type Input={bookingId:string;customerId:string;address:string;pincode?:string;latitude?:number;longitude?:number};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// Browser coordinates are never location authority here. Service discovery resolves the canonical
// address and coordinates server-side; this guard only verifies those governed coordinates are valid.
function verifiedCoordinates(governed:GovernedServiceAddress){
 const latitude=Number(governed.latitude),longitude=Number(governed.longitude);
 if(!validGpsCoordinates(latitude,longitude))throw new Response("Doorstep coordinates could not be verified",{status:409});
 return{latitude,longitude,source:"server_geocode" as const};
}

export async function POST(request:Request){try{
 const input=await request.json()as Input,bookingId=String(input.bookingId||"").trim(),customerId=String(input.customerId||"").trim(),address=String(input.address||"").trim(),rawPincode=String(input.pincode??address.match(/\b[1-9][0-9]{5}\b/)?.[0]??"").trim(),pin=validateIndianPincode(rawPincode);
 if(!bookingId||!customerId||address.length<8||!pin.ok)return json({error:"Booking, customer, complete doorstep address and six-digit pincode are required"},400);
 const db=await database();await ensureGroomingMapTables(db);await ensureCustomerAccountTables(db);const actor=await resolveActor(request);await requireCustomerOwnership(db,actor,customerId);
 const booking=await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,zone_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();
 if(!booking)return json({error:"Canonical booking not found"},404);if(String(booking.customer_id)!==customerId)return json({error:"Customer does not own this booking"},403);if(String(booking.service_code)!=="grooming")return json({error:"This endpoint is currently limited to Grooming UAT"},409);
 const resolvedZone=await resolveZoneByPincode(db,pin.pincode);if(!resolvedZone||!resolvedZone.zone.serviceAvailable)return json({error:"PawSpace is not currently serving this address",code:"service_zone_unavailable"},409);
 const resolvedCity=String(resolvedZone.assignment.cityId||"").trim().toLowerCase();if(String(booking.zone_id)!==resolvedZone.assignment.zoneId||String(booking.city_id).toLowerCase()!==resolvedCity)return json({error:"The verified address zone does not match the booking reservation"},409);
 const governed=await resolveGovernedServiceAddress(db,{customerId,serviceCode:"grooming",serviceAddress:address,servicePincode:pin.pincode});
 if(governed.zoneId!==String(booking.zone_id)||governed.cityId!==String(booking.city_id).toLowerCase())return json({error:"The verified address zone does not match the booking reservation"},409);
 const coordinates=verifiedCoordinates(governed),now=Date.now(),completeAddress=governed.address;
 await db.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET customer_id=excluded.customer_id,provider_id=excluded.provider_id,address_text=excluded.address_text,latitude=excluded.latitude,longitude=excluded.longitude,source=excluded.source,status='active',updated_at=excluded.updated_at").bind(bookingId,customerId,String(booking.provider_id),completeAddress,coordinates.latitude,coordinates.longitude,coordinates.source,now,now).run();
 await securityAudit(db,actor,"grooming.service_location.save","booking",bookingId,"completed",{hasCoordinates:true,coordinateSource:coordinates.source,addressLength:address.length,zoneId:governed.zoneId});
 return json({data:{bookingId,addressSaved:true,coordinatesSaved:true,coordinateSource:coordinates.source,latitude:coordinates.latitude,longitude:coordinates.longitude,navigationUrl:mapsNavigationUrl(completeAddress),cityId:governed.cityId,zoneId:governed.zoneId,serviceRadiusKm:governed.serviceRadiusKm}},201);
 }catch(error){if(error instanceof Response)return error;return authError(error,"Unable to save Grooming service location");}}
