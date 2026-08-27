/**
 * Whether a city that has been LAUNCHED is still open for fulfilment, and whether a pincode is still
 * inside the coverage that city advertises. [PTJA-W1-F38]
 *
 * MEASURED before this existed: an operator with launch.manage saved Bengaluru as `Paused` with 560034
 * removed from its coverage list, and got 201. city_launch_configs then held {status:'Paused', 560034
 * absent}. The platform's own coverage resolver agreed - and was the only thing that did:
 *
 *   resolveCityServiceCoverage(blr, grooming, 560034) -> {supported:false, reason:"city_not_live"}
 *   GET /api/service-zone?pincode=560034              -> 200, zone blr-south, serviceAvailable:true
 *   POST /api/grooming-service-location               -> 201, a booking_service_locations row 'active',
 *                                                       a customer_addresses row is_default=1, and a
 *                                                       Google Maps navigation URL for a provider to
 *                                                       drive to a closed market.
 *
 * The City & Geofence console is the founder's only kill switch for a market. Nothing downstream of it
 * ever asked it anything.
 *
 * WHAT THIS ENFORCES, AND WHY ONLY THIS.
 *
 * This module deliberately does NOT become a second opinion about which pincodes are serviceable.
 * tests/service-zone-coverage.test.mjs pins three decisions this repository has already made, and each
 * of them is left exactly as it stands:
 *
 *   - "city launch ranges must not fabricate operational zone coverage" - a launch config cannot WIDEN
 *     coverage past the reviewed service_zone_mappings table, and lib/service-zones.ts does not consult
 *     city_launch_configs at all. Untouched: the mapping question is still answered only by the mapping
 *     table, and this is asked separately, after it.
 *   - "an explicit reviewed database mapping enables a second-city zone without opening a broad range"
 *     - a reviewed mapping for a city with NO launch config is sufficient authority. Untouched: a city
 *     with no launch config is not refused here.
 *   - "560102 is in the explicit table, so it still resolves - that is intended" for a Draft city.
 *     Untouched: Draft and Pilot are not refused on status.
 *
 * What is left is the direction nothing covered - the launch config cannot NARROW either - and only
 * where the narrowing is unambiguous:
 *
 *   1. Status `Paused`. A control named "pause", operated on a live market, has no reading under which
 *      it means nothing. This is the kill switch firing.
 *   2. A `Live` city that advertises a parseable pincode list which no longer contains this pincode.
 *      That is the same property tests/service-zone-coverage.test.mjs states in its own header - "the
 *      coverage the business ADVERTISES must equal the coverage the booking flow ACCEPTS" - read in
 *      the narrowing direction. It applies only when a parseable list exists, so a centre+radius city
 *      or a range-style list is unaffected.
 *
 * What Draft and Pilot must do to serviceability, and whether an IN-FLIGHT booking in a paused market
 * must also stop rather than only new ones, are product decisions. They are recorded in the ledger as
 * open rather than answered here.
 *
 * Coverage tokens are parsed with validateIndianPincode, never with `.replace(/\D/g,"").slice(0,6)`.
 * lib/pincode-validation.ts states why in as many words: "do not strip letters/punctuation or truncate
 * longer input, because doing so can silently turn garbage into a different, serviceable PIN."
 */
import{validateIndianPincode}from"./pincode-validation";

type Db=D1Database;
type Row=Record<string,unknown>;

export type CityFulfilmentVerdict=
  |{open:true;cityCode:string;reason:"no_launch_governance"|"city_open"}
  |{open:false;reason:"city_paused"|"pincode_not_in_city_coverage";cityCode:string;city:string;status:string};

/**
 * The advertised coverage of a city as valid PIN codes. An empty result means the city does not
 * express its coverage as a pincode list - a range, a centre and radius, or nothing at all - and this
 * module then makes no claim about its pincodes.
 */
export function advertisedPincodes(raw:unknown){
  const out=new Set<string>();
  for(const token of String(raw??"").split(/[,;\s]+/)){
    const parsed=validateIndianPincode(token);
    if(parsed.ok)out.add(parsed.pincode);
  }
  return out;
}

/** Is this launched city still open, and does it still advertise this pincode? */
export async function cityFulfilmentVerdict(db:Db,cityId:string,pincode:string):Promise<CityFulfilmentVerdict>{
  const cityCode=String(cityId||"").trim().toLowerCase();
  if(!cityCode)return{open:true,cityCode,reason:"no_launch_governance"};
  const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='city_launch_configs'").first<Row>();
  if(!table)return{open:true,cityCode,reason:"no_launch_governance"};
  const row=await db.prepare("SELECT city,status,pincodes FROM city_launch_configs WHERE city_code=?").bind(cityCode).first<Row>();
  // A city with no launch config is governed by its reviewed service_zone_mappings rows alone. That is
  // this repository's existing second-city path and it is not overridden here.
  if(!row)return{open:true,cityCode,reason:"no_launch_governance"};
  const city=String(row.city||""),status=String(row.status||"");
  if(status==="Paused")return{open:false,reason:"city_paused",cityCode,city,status};
  if(status!=="Live")return{open:true,cityCode,reason:"no_launch_governance"};
  const advertised=advertisedPincodes(row.pincodes);
  if(!advertised.size)return{open:true,cityCode,reason:"city_open"};
  const parsed=validateIndianPincode(pincode);
  if(!parsed.ok||!advertised.has(parsed.pincode))return{open:false,reason:"pincode_not_in_city_coverage",cityCode,city,status};
  return{open:true,cityCode,reason:"city_open"};
}
