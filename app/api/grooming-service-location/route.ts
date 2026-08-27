import { authError, database, requireCustomerOwnership, resolveActor, securityAudit } from "../../../lib/server-auth";
import { ensureGroomingMapTables, mapsNavigationUrl } from "../../../lib/grooming-maps";
import { resolveZoneByPincode } from "../../../lib/service-zones";
import { cityFulfilmentVerdict } from "../../../lib/city-coverage-authority";
import { ensureCustomerAccountTables } from "../../../lib/customer-account";

type Input = { bookingId: string; customerId: string; address: string; pincode?: string; latitude?: number; longitude?: number };
const json = (value: unknown, status = 200) => Response.json(value, { status });

export async function POST(request: Request) {
  try {
    const input = await request.json() as Input;
    const bookingId = String(input.bookingId || "").trim();
    const customerId = String(input.customerId || "").trim();
    const address = String(input.address || "").trim();
    const pincode = String(input.pincode || address.match(/\b\d{6}\b/)?.[0] || "").replace(/\D/g, "");
    if (!bookingId || !customerId || address.length < 8 || !/^\d{6}$/.test(pincode)) return json({ error: "Booking, customer, complete doorstep address and six-digit pincode are required" }, 400);

    const db = await database();
    await ensureGroomingMapTables(db);
    await ensureCustomerAccountTables(db);
    const actor = await resolveActor(request);
    await requireCustomerOwnership(db,actor,customerId);
    const booking = await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,zone_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string, unknown>>();
    if (!booking) return json({ error: "Canonical booking not found" }, 404);
    if (String(booking.customer_id) !== customerId) return json({ error: "Customer does not own this booking" }, 403);
    if (String(booking.service_code) !== "grooming") return json({ error: "This endpoint is currently limited to Grooming UAT" }, 409);

    const resolved = await resolveZoneByPincode(db, pincode);
    if (!resolved || !resolved.zone.serviceAvailable) return json({ error: "The service address is outside an enabled PawSpace zone" }, 409);
    // Whether the pincode MAPS to a zone and whether that market is still OPEN are two questions, and
    // this gate asked only the first. Measured: with Bengaluru saved as Paused and 560034 removed from
    // its advertised coverage, this route answered 201 and wrote an active booking_service_locations
    // row, a default customer_addresses row, and a Google Maps navigation URL for a provider to drive
    // to a closed market. The verdict applies the launch console's own kill switch. [PTJA-W1-F38]
    const cityVerdict = await cityFulfilmentVerdict(db, String(resolved.assignment.cityId || ""), pincode);
    if (!cityVerdict.open) return json({ error: "PawSpace is not currently serving this address; the city or this pincode is not open for fulfilment", code: cityVerdict.reason }, 409);
    const resolvedCityId = String(resolved.assignment.cityId || "").trim().toLowerCase();
    if (!resolvedCityId || String(booking.zone_id) !== resolved.assignment.zoneId || String(booking.city_id).toLowerCase() !== resolvedCityId) return json({ error: "The verified address zone does not match the booking reservation" }, 409);

    const lat = Number(input.latitude), lng = Number(input.longitude);
    const hasCoords = Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;
    const now = Date.now(), completeAddress = `${address}, ${resolved.assignment.area}, ${resolved.assignment.city} ${pincode}`;
    const addressId = `ADDR-${customerId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}-${pincode}`;
    await db.batch([
      db.prepare("INSERT INTO booking_service_locations (booking_id,customer_id,provider_id,address_text,latitude,longitude,source,status,created_at,updated_at) VALUES (?,?,?,?,?,?, 'customer_booking','active',?,?) ON CONFLICT(booking_id) DO UPDATE SET customer_id=excluded.customer_id,provider_id=excluded.provider_id,address_text=excluded.address_text,latitude=excluded.latitude,longitude=excluded.longitude,status='active',updated_at=excluded.updated_at").bind(bookingId, customerId, String(booking.provider_id), completeAddress, hasCoords ? lat : null, hasCoords ? lng : null, now, now),
      db.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=?").bind(now, customerId),
      db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,NULL,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET line1=excluded.line1,area=excluded.area,city=excluded.city,postal_code=excluded.postal_code,is_default=1,updated_at=excluded.updated_at WHERE customer_addresses.customer_id=excluded.customer_id").bind(addressId, customerId, "Service address", address, resolved.assignment.area, resolved.assignment.city, pincode, now, now),
    ]);
    await securityAudit(db, actor, "grooming.service_location.save", "booking", bookingId, "completed", { hasCoordinates: hasCoords, addressLength: address.length, zoneId: resolved.assignment.zoneId });
    return json({ data: { bookingId, addressSaved: true, coordinatesSaved: hasCoords, navigationUrl: mapsNavigationUrl(completeAddress), cityId: resolvedCityId, zoneId: resolved.assignment.zoneId } }, 201);
  } catch (error) {
    return authError(error, "Unable to save Grooming service location");
  }
}
