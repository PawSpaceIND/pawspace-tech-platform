import { authError, database, requireCustomerOwnership, resolveActor } from "../../../lib/server-auth";
import { ensureGroomingMapTables, mapsNavigationUrl } from "../../../lib/grooming-maps";
import { resolveZoneByPincode } from "../../../lib/service-zones";
import { cityFulfilmentVerdict } from "../../../lib/city-coverage-authority";
import { ensureCustomerAccountTables } from "../../../lib/customer-account";
import { resolvePlaceToAddress, searchAddressSuggestions } from "../../../lib/address-autocomplete";
import { validGpsCoordinates } from "../../../lib/gps-telemetry-policy";

type Input = { bookingId: string; customerId: string; address: string; pincode?: string; latitude?: number; longitude?: number };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers:{"cache-control":"no-store"} });

async function verifiedCoordinates(input:Input,address:string,pincode:string){
 const suppliedLat=Number(input.latitude),suppliedLng=Number(input.longitude);
 if(validGpsCoordinates(suppliedLat,suppliedLng))return{latitude:suppliedLat,longitude:suppliedLng,source:"customer_verified_coordinates"};
 const sessionToken=crypto.randomUUID(),suggestions=await searchAddressSuggestions({query:`${address}, ${pincode}`,sessionToken});
 if(suggestions.status!=="configured")throw new Response(suggestions.error||"Doorstep coordinate lookup is not configured",{status:409});
 const candidate=suggestions.suggestions[0];if(!candidate)throw new Response("We could not verify this doorstep address on the map. Choose a mapped address before booking.",{status:409});
 const place=await resolvePlaceToAddress({placeId:candidate.placeId,sessionToken});
 if(place.status!=="configured"||!validGpsCoordinates(Number(place.latitude),Number(place.longitude)))throw new Response(place.error||"Doorstep coordinates could not be verified",{status:409});
 const resolvedAddress=String(place.address||candidate.fullText||"");if(!resolvedAddress.includes(pincode))throw new Response("The mapped doorstep does not match the selected pincode",{status:409});
 return{latitude:Number(place.latitude),longitude:Number(place.longitude),source:"places_verified"};
}

export async function POST(request: Request) {
  try {
    const input = await request.json() as Input;
    const bookingId = String(input.bookingId || "").trim();
    const customerId = String(input.customerId || "").trim();
    const address = String(input.address || "").trim();
    const pincode = String(input.pincode || address.match(/\b\d{6}\b/)?.[0] || "").replace(/\D/g, "");
    if (!bookingId || !customerId || address.length < 8 || !/^\d{6}$/.test(pincode)) return json({ error: "Booking, customer, complete doorstep address and six-digit pincode are required" }, 400);
    const db = await database();await ensureGroomingMapTables(db);await ensureCustomerAccountTables(db);const actor = await resolveActor(request);await requireCustomerOwnership(db,actor,customerId);
    const booking = await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,zone_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string, unknown>>();
    if (!booking) return json({ error: "Canonical booking not found" }, 404);if (String(booking.customer_id) !== customerId) return json({ error: "Customer does not own this booking" }, 403);if (String(booking.service_code) !== "grooming") return json({ error: "This endpoint is currently limited to Grooming UAT" }, 409);
    const resolved = await resolveZoneByPincode(db, pincode);if (!resolved || !resolved.zone.serviceAvailable) return json({ error: "The service address is outside an enabled PawSpace zone" }, 409);
    const cityVerdict = await cityFulfilmentVerdict(db, String(resolved.assignment.cityId || ""), pincode);if (!cityVerdict.open) return json({ error: "PawSpace is not currently serving this address; the city or this pincode is not open for fulfilment", code: cityVerdict.reason }, 409);
    const resolvedCityId = String(resolved.assignment.cityId || "").trim().toLowerCase();if (!resolvedCityId || String(booking.zone_id) !== resolved.assignment.zoneId || String(booking.city_id).toLowerCase() !== resolvedCityId) return json({ error: "The verified address zone does not match the booking reservation" }, 409);
    const coordinates=await verifiedCoordinates(input,address,pincode),now = Date.now(), completeAddress = `${address}, ${resolved.assignment.area}, ${resolved.assignment.city} ${pincode}`,addressId = `ADDR-${customerId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}-${pincode}`;
    await db.batch([
      db.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(booking_id) DO UPDATE SET customer_id=excluded.customer_id,provider_id=excluded.provider_id,address_text=excluded.address_text,latitude=excluded.latitude,longitude=excluded.longitude,source=excluded.source,status='active',updated_at=excluded.updated_at").bind(bookingId, customerId, String(booking.provider_id), completeAddress, coordinates.latitude, coordinates.longitude, coordinates.source, now, now),
      db.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=?").bind(now, customerId),
      db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET line1=excluded.line1,area=excluded.area,city=excluded.city,postal_code=excluded.postal_code,is_default=1,updated_at=excluded.updated_at WHERE customer_addresses.customer_id=excluded.customer_id").bind(addressId, customerId, "Service address", address, resolved.assignment.area, resolved.assignment.city, pincode, now, now),
      db.prepare("INSERT INTO security_audit_events (id,actor_email,actor_role,action,resource_type,resource_id,outcome,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),actor.email,actor.roleCode,"grooming.service_location.save","booking",bookingId,"completed",JSON.stringify({hasCoordinates:true,coordinateSource:coordinates.source,addressLength:address.length,zoneId:resolved.assignment.zoneId}),now),
    ]);
    return json({ data: { bookingId, addressSaved: true, coordinatesSaved: true, coordinateSource:coordinates.source, latitude:coordinates.latitude, longitude:coordinates.longitude, navigationUrl: mapsNavigationUrl(completeAddress), cityId: resolvedCityId, zoneId: resolved.assignment.zoneId } }, 201);
  } catch (error) {return authError(error, "Unable to save Grooming service location");}
}
