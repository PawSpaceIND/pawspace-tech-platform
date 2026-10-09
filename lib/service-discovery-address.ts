import {sameSavedAddress,savedAddressId} from "./saved-address-identity";
import{SERVICE_ADDRESS_REASON_COPY,type ServiceAddressRefusalCode,type ServiceAddressRefusalReason}from"./service-address-refusal-copy";
import{uatRosterSeedingEnabled}from"./scheduling-roster-authority";
import{cityFulfilmentVerdict}from"./city-coverage-authority";
import{geocodeAddress,reverseGeocode}from"./address-autocomplete";
import{validateIndianPincode}from"./pincode-validation";
import{resolveZoneByPincode}from"./service-zones";
import{serviceAddressConflict}from"./service-address-consistency";
import{serviceAddressPincodes}from"./service-address-pincode";
import{serviceAddressText}from"./service-address-text";

type Db=D1Database;
type Row=Record<string,unknown>;

export const SERVICE_DISCOVERY_RADIUS_KM=16;
/** UAT only: every seeded groomer serves the whole city, so the geofence must span it (Kengeri-Whitefield is ~30 km). */
export const UAT_SERVICE_DISCOVERY_RADIUS_KM=45;
async function uatSchedulingRuntime(){const{env}=await import("cloudflare:workers");return uatRosterSeedingEnabled(env as unknown as Record<string,unknown>);}
/** Where the returned coordinates came from. Client coordinates are never a source on their own: a device point is
 * accepted only after the server's own reverse geocode of that point names this same doorstep and PIN. A cached
 * point is reported as cached, never relabelled as a fresh server geocode. */
export type GovernedCoordinateSource="server_geocode"|"server_reverse_geocode"|"cached_geocode";
export type GovernedServiceAddress={addressId:string;address:string;pincode:string;cityId:string;zoneId:string;latitude:number;longitude:number;serviceRadiusKm?:number;coordinateSource:GovernedCoordinateSource};

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
// Once per isolate: this probe and two DDL statements ran in front of every booking and availability check.
async function ensureAddressTablesUncached(db:Db){
  if(!await tableExists(db,"customer_addresses"))await db.prepare("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_service_address_geocodes (address_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pincode TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,resolved_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_service_geocodes_customer ON customer_service_address_geocodes(customer_id,updated_at DESC)").run();
  // Additive side table: where a cached point came from. It counts only while it matches the cached row exactly, so a
  // replaced or older row (written before provenance was recorded) reads as unknown provenance.
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_service_address_geocode_provenance (address_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,coordinate_source TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,recorded_at INTEGER NOT NULL)").run();
}
// Ready-set only: no in-flight promise is shared across requests (a cancelled request's promise never settles).
const addressTablesReady=new WeakSet<object>();
async function ensureAddressTables(db:Db){if(addressTablesReady.has(db))return;await ensureAddressTablesUncached(db);addressTablesReady.add(db);}
function completeAddress(row:Row,pincode:string){return serviceAddressText({line1:String(row.line1||""),line2:String(row.line2||""),area:String(row.area||""),city:String(row.city||""),postalCode:pincode,country:"India"});}
/** Finite, in-range coordinates; anything else is not usable for provider matching. */
function usableCoordinates(latitude:unknown,longitude:unknown){const lat=Number(latitude),lng=Number(longitude);return Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180;}
function truthy(value:unknown){return["1","true","on","yes"].includes(String(value??"").trim().toLowerCase());}
async function testFixtureEnabled(){const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;const processEnv:Record<string,string|undefined>=typeof process!=="undefined"?process.env:{};const read=(key:string)=>runtime[key]??processEnv[key];return truthy(read("PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE"))&&String(read("PAWSPACE_PAYMENT_ENV")||"").toLowerCase()==="sandbox"&&(String(read("NODE_ENV")||"").toLowerCase()==="test"||String(read("PAWSPACE_SCHEDULING_ENV")||"").toLowerCase()==="uat");}
function fixtureCoordinates(cityId:string){switch(cityId){case"maa":return{latitude:13.0827,longitude:80.2707};case"hyd":return{latitude:17.385,longitude:78.4867};case"bom":case"mum":return{latitude:19.076,longitude:72.8777};case"pnq":case"pune":return{latitude:18.5204,longitude:73.8567};default:return{latitude:12.9716,longitude:77.5946};}}
async function ensureTestProviderHomeBases(db:Db){
  await db.prepare("CREATE TABLE IF NOT EXISTS provider_home_base (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,effective_from INTEGER NOT NULL,effective_until INTEGER,reason TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from)").run();
  const bases=[
    {providerId:"groom_arun",...fixtureCoordinates("blr")},{providerId:"groom_kiran",latitude:12.9736,longitude:77.5966},{providerId:"groom_sanjay",latitude:12.9756,longitude:77.5986},
    {providerId:"E2E-PRV-UI-001",latitude:12.9716,longitude:77.5946},
    {providerId:"train_kiran",latitude:12.9776,longitude:77.6006},{providerId:"train_ramesh",latitude:12.9796,longitude:77.6026},{providerId:"train_meera",latitude:12.9816,longitude:77.6046},
    {providerId:"groom_maa",...fixtureCoordinates("maa")},
  ],now=Date.now();
  await db.batch(bases.map(base=>db.prepare("INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT ?,?,?,?,?,0,NULL,'Explicit sandbox service-discovery fixture','test_fixture',? WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id=?)").bind(`TST-PHB-${base.providerId}`,base.providerId,"PawSpace sandbox provider base",base.latitude,base.longitude,now,base.providerId)));
}

/** Resolve the address authority used by scheduling.
 * Clients may identify the address and PIN the customer selected, but city, zone, coordinates and
 * radius are always derived here. If a new address is supplied, it becomes a governed customer address
 * only after strict PIN validation, coverage validation and server-side geocoding succeed.
 *
 * Legacy executable suites can opt into one explicit server-owned sandbox fixture with
 * PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE=on. The fixture is impossible to activate unless the runtime
 * is sandbox plus test/UAT, and it never trusts browser city/zone/coordinates. */
export async function resolveGovernedServiceAddress(db:Db,input:{customerId:string;serviceCode:string;serviceAddress?:string;servicePincode?:string;latitude?:number;longitude?:number;/** false: resolve and geocode only; the customer did not ask to keep this address. */saveToAccount?:boolean;/** Persisting a booking doorstep: a cached point of unknown provenance is re-verified by a fresh server geocode before it is used. */requireCoordinateProvenance?:boolean}) : Promise<GovernedServiceAddress>{
  await ensureAddressTables(db);const fixture=await testFixtureEnabled();if(fixture)await ensureTestProviderHomeBases(db);
  let suppliedAddress=String(input.serviceAddress||"").trim();const suppliedPincode=String(input.servicePincode||"").trim();
  let row:Row|null=null;
  if(suppliedAddress||suppliedPincode){
    const pin=validateIndianPincode(suppliedPincode);if(!pin.ok)throw new Response("A valid 6-digit service PIN code is required",{status:400});
    if(suppliedAddress.length<8)throw new Response("A complete service address is required",{status:400});
    row={id:await savedAddressId(input.customerId,{line1:suppliedAddress,postalCode:pin.pincode}),line1:suppliedAddress,line2:null,area:null,city:"",postal_code:pin.pincode};
  }else{
    row=await db.prepare("SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,updated_at DESC,created_at DESC LIMIT 1").bind(input.customerId).first<Row>();
    if(!row&&fixture){const address="PawSpace sandbox service-discovery fixture, Indiranagar",pincode="560038";row={id:await savedAddressId(input.customerId,{line1:address,area:"Indiranagar",city:"Bengaluru",postalCode:pincode}),line1:address,line2:null,area:"Indiranagar",city:"Bengaluru",postal_code:pincode};}
    if(!row)throw new Response("Save a service address before booking",{status:409});
  }
  const validated=validateIndianPincode(String(row.postal_code||""));if(!validated.ok)throw new Response("The saved service address has an invalid PIN code",{status:409});
  const resolved=await resolveZoneByPincode(db,validated.pincode);if(!resolved||!resolved.zone.serviceAvailable)throw Response.json({error:"PawSpace is not currently serving this address",code:"service_zone_unavailable"},{status:409});
  const cityId=String(resolved.assignment.cityId||"").trim().toLowerCase();if(!cityId)throw new Response("The service address has no governed city",{status:409});
  const conflict=serviceAddressConflict([row.line1,row.line2,row.city].filter(Boolean).join(", "),String(resolved.assignment.city),validated.pincode);if(conflict)throw Response.json({error:conflict,code:"service_address_mismatch"},{status:400});
  // The saved-address read does not depend on the coverage verdict, so both are in flight together; the
  // verdict is still checked first, so a closed city refuses exactly as before.
  const savedRead=suppliedAddress?db.prepare("SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? AND postal_code=? ORDER BY is_default DESC,updated_at DESC").bind(input.customerId,validated.pincode).all<Row>():null;savedRead?.catch(()=>undefined);
  const cityVerdict=await cityFulfilmentVerdict(db,cityId,validated.pincode);if(!cityVerdict.open)throw Response.json({error:"PawSpace is not currently serving this address",code:cityVerdict.reason,cityId:cityVerdict.cityCode},{status:409});
  if(suppliedAddress&&savedRead){
    suppliedAddress=serviceAddressText({line1:suppliedAddress,area:resolved.assignment.area,city:resolved.assignment.city,postalCode:validated.pincode});
    const saved=await savedRead;
    const existing=saved.results.find(item=>sameSavedAddress(item,{line1:suppliedAddress,area:resolved.assignment.area,city:resolved.assignment.city,postalCode:validated.pincode}));
    row=existing??{...row,id:await savedAddressId(input.customerId,{line1:suppliedAddress,area:resolved.assignment.area,city:resolved.assignment.city,postalCode:validated.pincode}),line1:suppliedAddress};
  }
  const held=await db.prepare("SELECT * FROM customer_addresses WHERE id=?").bind(String(row.id)).first<Row>();
  if(held&&(String(held.customer_id)!==input.customerId||!sameSavedAddress(held,{...row,postalCode:validated.pincode,area:row.area||resolved.assignment.area,city:row.city||resolved.assignment.city})))throw new Response("Address identity conflict; select your saved address",{status:409});
  const address=completeAddress(row,validated.pincode);
  // The cached geocode is DERIVED data: it is read by address id alone and judged against the canonical address
  // resolved above, never the other way round. The canonical address and PIN are never rewritten here.
  //  - A row owned by another customer is refused.
  //  - Postal drift: the row's PIN column, OR a PIN embedded in its address text, contradicts the canonical PIN
  //    (observed shape: canonical 560043, cached PIN column 560043, cached text "…, 560113, India"). City/zone drift
  //    and unusable coordinates are drift too.
  //  - Drift on a SAVED, owned address whose doorstep is otherwise the same (the text matches the canonical address
  //    once only the contradictory postal code is set aside) is an unusable cache: the unchanged canonical address is
  //    geocoded afresh, the fresh evidence is validated BEFORE anything is written, and ONLY that exact stale snapshot
  //    is replaced. A different doorstep is never treated as postal drift: it stays an identity conflict, as does any
  //    mismatch for an address that is not saved (there is no canonical row to repair from).
  //  - Every write is conditional on the canonical saved row being byte-for-byte what was read, and that row is
  //    checked again before this answer is returned, so a concurrent address edit can never be repaired over.
  const geoColumns="customer_id,pincode,city_id,zone_id,address_text,latitude,longitude,resolved_at,updated_at";
  const knownSource=(value:unknown):value is GovernedCoordinateSource=>value==="server_geocode"||value==="server_reverse_geocode";
  const recordedSource=async(candidate:Row):Promise<GovernedCoordinateSource|null>=>{const p=await db.prepare("SELECT customer_id,coordinate_source,address_text,latitude,longitude FROM customer_service_address_geocode_provenance WHERE address_id=?").bind(String(row.id)).first<Row>();return p&&String(p.customer_id)===input.customerId&&String(p.address_text)===String(candidate.address_text)&&Number(p.latitude)===Number(candidate.latitude)&&Number(p.longitude)===Number(candidate.longitude)&&knownSource(p.coordinate_source)?p.coordinate_source:null;};
  const canonicalLocality={area:resolved.assignment.area,city:resolved.assignment.city,postalCode:validated.pincode};
  const sameDoorstepText=(text:unknown)=>sameSavedAddress({line1:text,...canonicalLocality},{line1:address,...canonicalLocality});
  const embeddedPins=(text:unknown)=>serviceAddressPincodes(String(text??""));
  const postalDrift=(candidate:Row)=>String(candidate.pincode)!==validated.pincode||embeddedPins(candidate.address_text).some(pin=>pin!==validated.pincode);
  const derivedDrift=(candidate:Row)=>postalDrift(candidate)||String(candidate.city_id)!==cityId||String(candidate.zone_id)!==resolved.assignment.zoneId||!usableCoordinates(candidate.latitude,candidate.longitude);
  // Used ONLY to tell postal drift from a different doorstep; the cached text is discarded either way, never stored or trusted.
  const doorstepAsidePostal=(candidate:Row)=>{let text=String(candidate.address_text??"");for(const pin of embeddedPins(text))if(pin!==validated.pincode)text=text.replace(new RegExp(`\\b${pin}\\b`,"g"),validated.pincode);return sameDoorstepText(text);};
  const consistentGeo=(candidate:Row)=>!derivedDrift(candidate)&&sameDoorstepText(candidate.address_text);
  // The canonical saved row's own columns (whichever of these the table has); a write or answer is valid only while they are unchanged.
  const canonicalColumns=held?["customer_id","line1","line2","area","city","postal_code","updated_at"].filter(column=>Object.prototype.hasOwnProperty.call(held,column)):[];
  const canonicalGuard=canonicalColumns.map(column=>`${column} IS ?`).join(" AND "),canonicalValues=canonicalColumns.map(column=>held?.[column]??null);
  const canonicalUnchanged=async()=>{if(!held)return true;const now=await db.prepare(`SELECT ${canonicalColumns.join(",")} FROM customer_addresses WHERE id=?`).bind(String(row.id)).first<Row>();return Boolean(now)&&canonicalColumns.every(column=>(now?.[column]??null)===(held[column]??null));};
  const canonicalChanged=()=>new Response("Saved address changed while it was being verified; try again",{status:409});
  let coordinateSource:GovernedCoordinateSource="cached_geocode";
  let geo=await db.prepare(`SELECT ${geoColumns} FROM customer_service_address_geocodes WHERE address_id=?`).bind(String(row.id)).first<Row>();
  if(geo&&String(geo.customer_id)!==input.customerId)throw new Response("Address geocode identity conflict; select your saved address",{status:409});
  const provenanceOfCached=input.requireCoordinateProvenance&&geo&&consistentGeo(geo)?await recordedSource(geo):null;
  const unprovenanced=Boolean(input.requireCoordinateProvenance&&geo&&consistentGeo(geo)&&!provenanceOfCached);
  const stale=geo&&((held&&derivedDrift(geo)&&doorstepAsidePostal(geo))||unprovenanced)?geo:null;if(stale)geo=null;
  if(geo&&!consistentGeo(geo))throw new Response("Address geocode identity conflict; select your saved address",{status:409});
  // A reused point keeps its recorded provenance; one written before provenance was recorded reads as cached, never as a fresh server geocode.
  if(geo)coordinateSource=provenanceOfCached??"cached_geocode";
  if(!geo){
    const fixtureGeo=fixtureCoordinates(cityId),geocoded=fixture?{status:"configured"as const,address,latitude:fixtureGeo.latitude,longitude:fixtureGeo.longitude,error:undefined}:await geocodeAddress({address});
    // Map authority is server evidence only. A forward geocode of the canonical address is preferred. Device coordinates
    // (or any flag, place id or source label a client sends) are never written on their own: they are used only as the
    // point the server reverse-geocodes, and accepted only if that answer carries this PIN and passes the same
    // doorstep validation below. Otherwise the request refuses neutrally and nothing is written.
    let resolvedGeo:{address?:string;latitude?:number;longitude?:number}|null=null;
    if(geocoded.status==="configured"&&usableCoordinates(geocoded.latitude,geocoded.longitude)){resolvedGeo=geocoded;coordinateSource="server_geocode";}
    else if(!fixture&&usableCoordinates(input.latitude,input.longitude)){
      const reverse=await reverseGeocode({latitude:Number(input.latitude),longitude:Number(input.longitude)});
      if(reverse.status==="configured"&&String(reverse.pincode||"").trim()===validated.pincode&&String(reverse.address||"").trim()){resolvedGeo={address:String(reverse.address),latitude:Number(input.latitude),longitude:Number(input.longitude)};coordinateSource="server_reverse_geocode";}
      else throw new Response("The service address could not be verified against map data",{status:409});
    }
    if(!resolvedGeo)throw new Response(geocoded.error||"The service address could not be geocoded for provider matching. Use current location or contact PawSpace support.",{status:409});
    // Fresh evidence is validated BEFORE any INSERT or compare-and-swap: usable coordinates, no PIN or city in the
    // returned text that contradicts the canonical address, and the same doorstep. A geocoder answer that fails any
    // of these is not written anywhere; the old cache and the canonical address stay exactly as they were.
    const freshText=String(resolvedGeo.address||address);
    if(!usableCoordinates(resolvedGeo.latitude,resolvedGeo.longitude)||serviceAddressConflict(freshText,String(resolved.assignment.city),validated.pincode)||!sameDoorstepText(freshText))throw new Response("The service address could not be verified against map data",{status:409});
    const now=Date.now(),id=String(row.id),fresh=[validated.pincode,cityId,resolved.assignment.zoneId,freshText,Number(resolvedGeo.latitude),Number(resolvedGeo.longitude)] as const;
    const guardSql=held?` AND EXISTS (SELECT 1 FROM customer_addresses WHERE id=? AND ${canonicalGuard})`:"",guardValues=held?[id,...canonicalValues]:[];
    if(stale){
      // Compare-and-swap on every column of the snapshot judged stale AND on the canonical saved row. Zero rows means
      // another request replaced the cache or the customer's address changed; the checks below decide, and nothing
      // newer is overwritten.
      await db.prepare(`UPDATE customer_service_address_geocodes SET pincode=?,city_id=?,zone_id=?,address_text=?,latitude=?,longitude=?,resolved_at=?,updated_at=? WHERE address_id=? AND customer_id=? AND pincode=? AND city_id=? AND zone_id=? AND address_text=? AND latitude=? AND longitude=? AND resolved_at=? AND updated_at=?${guardSql}`).bind(...fresh,now,now,id,input.customerId,String(stale.pincode),String(stale.city_id),String(stale.zone_id),String(stale.address_text),Number(stale.latitude),Number(stale.longitude),Number(stale.resolved_at),Number(stale.updated_at),...guardValues).run();
    }else if(held){
      await db.prepare(`INSERT INTO customer_service_address_geocodes (address_id,customer_id,pincode,city_id,zone_id,address_text,latitude,longitude,resolved_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM customer_addresses WHERE id=? AND ${canonicalGuard}) ON CONFLICT(address_id) DO NOTHING`).bind(id,input.customerId,...fresh,now,now,...guardValues).run();
    }else{
      await db.prepare("INSERT INTO customer_service_address_geocodes (address_id,customer_id,pincode,city_id,zone_id,address_text,latitude,longitude,resolved_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address_id) DO NOTHING").bind(id,input.customerId,...fresh,now,now).run();
    }
    if(!await canonicalUnchanged())throw canonicalChanged();
    const stored=await db.prepare(`SELECT ${geoColumns} FROM customer_service_address_geocodes WHERE address_id=?`).bind(id).first<Row>();
    if(stored&&String(stored.customer_id)!==input.customerId)throw new Response("Address geocode identity conflict; select your saved address",{status:409});
    // Whatever is stored now (ours, or a concurrent writer's) must agree with the canonical address; otherwise the
    // customer retries rather than booking against data this request did not verify.
    if(!stored||!consistentGeo(stored))throw new Response("Address geocode changed while it was being verified; try again",{status:409});
    // A concurrent writer's row is honest data but not this request's fresh answer: report it as cached.
    if(String(stored.address_text)!==fresh[3]||Number(stored.latitude)!==fresh[4]||Number(stored.longitude)!==fresh[5])coordinateSource=(input.requireCoordinateProvenance?await recordedSource(stored):null)??"cached_geocode";
    // Our own validated write: record where the point came from, bound to these exact values.
    else await db.prepare("INSERT INTO customer_service_address_geocode_provenance (address_id,customer_id,coordinate_source,address_text,latitude,longitude,recorded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET customer_id=excluded.customer_id,coordinate_source=excluded.coordinate_source,address_text=excluded.address_text,latitude=excluded.latitude,longitude=excluded.longitude,recorded_at=excluded.recorded_at").bind(id,input.customerId,coordinateSource,fresh[3],fresh[4],fresh[5],now).run();
    geo=stored;
  }
  // Authority is returned only while the canonical saved row is still the one this answer was derived from.
  if(!await canonicalUnchanged())throw canonicalChanged();
  // Saving follows the customer's choice on every call, not only the first one that geocodes the doorstep.
  {const id=String(row.id),now=Date.now();
    if(suppliedAddress&&input.saveToAccount!==false&&!await db.prepare("SELECT id FROM customer_addresses WHERE id=? AND customer_id=?").bind(id,input.customerId).first()){
      // A service search is not permission to replace the customer's preferred address.
      await db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM customer_addresses WHERE customer_id=?) THEN 0 ELSE 1 END,?,? ON CONFLICT(id) DO NOTHING").bind(id,input.customerId,"Service address",suppliedAddress,null,resolved.assignment.area,resolved.assignment.city,validated.pincode,input.customerId,now,now).run();
    }
  }
  if(suppliedAddress&&input.saveToAccount!==false){
    const persisted=await db.prepare("SELECT * FROM customer_addresses WHERE id=?").bind(String(row.id)).first<Row>();
    if(!persisted||String(persisted.customer_id)!==input.customerId||!sameSavedAddress(persisted,{line1:suppliedAddress,area:resolved.assignment.area,city:resolved.assignment.city,postalCode:validated.pincode}))throw new Response("Address identity conflict; refresh and try again",{status:409});
  }
  const radius=input.serviceCode==="grooming"||input.serviceCode==="dog_training"?(await uatSchedulingRuntime()?UAT_SERVICE_DISCOVERY_RADIUS_KM:SERVICE_DISCOVERY_RADIUS_KM):undefined;
  return{addressId:String(row.id),address:String(geo.address_text||address),pincode:validated.pincode,cityId,zoneId:resolved.assignment.zoneId,latitude:Number(geo.latitude),longitude:Number(geo.longitude),serviceRadiusKm:radius,coordinateSource};
}


/**
 * The customer-facing answer to a governed-address refusal (a 400/409 Response thrown above), for the
 * scheduling route. Each branch keeps a safe reason and the shared sentence from service-address-refusal-copy;
 * nothing from the refusal's own text, a geocoder or a saved address is echoed. Customer-correctable validation
 * keeps the long-standing code SERVICE_ADDRESS_UNVERIFIED with a `reason`; coverage and verification-infrastructure
 * failures get their own codes, because the customer's PIN is not what is wrong there. Anything unrecognised keeps
 * the generic code and reason.
 */
export type PublicAddressRefusal={code:ServiceAddressRefusalCode;reason:ServiceAddressRefusalReason;error:string};
export function publicAddressRefusal(status:number,detail:string):PublicAddressRefusal{
  const text=String(detail||"").trim();
  let code="";try{const parsed=JSON.parse(text) as {code?:unknown};code=String(parsed?.code??"");}catch{/* plain-text refusal */}
  const answer=(code:ServiceAddressRefusalCode,reason:ServiceAddressRefusalReason):PublicAddressRefusal=>({code,reason,error:SERVICE_ADDRESS_REASON_COPY[reason]});
  if(text==="Save a service address before booking")return answer("SERVICE_ADDRESS_REQUIRED","address_missing");
  if(text==="A valid 6-digit service PIN code is required")return answer("SERVICE_ADDRESS_UNVERIFIED","pin_invalid");
  if(text==="A complete service address is required")return answer("SERVICE_ADDRESS_UNVERIFIED","address_incomplete");
  if(text==="The saved service address has an invalid PIN code")return answer("SERVICE_ADDRESS_UNVERIFIED","saved_pin_invalid");
  if(code==="service_address_mismatch")return answer("SERVICE_ADDRESS_UNVERIFIED","address_pin_mismatch");
  if(text.startsWith("Address geocode changed while it was being verified"))return answer("SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_retry");
  if(text.startsWith("Saved address changed while it was being verified"))return answer("SERVICE_ADDRESS_UNVERIFIED","address_changed");
  if(text.startsWith("Address identity conflict")||text.startsWith("Address geocode identity conflict"))return answer("SERVICE_ADDRESS_UNVERIFIED","identity_conflict");
  if(code==="service_zone_unavailable"||text==="The service address has no governed city"||(code&&status===409))return answer("SERVICE_ADDRESS_NOT_COVERED","not_covered");
  // Every remaining 409 is thrown after the PIN, coverage and identity checks passed: the geocoder (or its configuration) answered badly.
  if(status===409)return answer("SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE","verification_unavailable");
  return answer("SERVICE_ADDRESS_UNVERIFIED","unknown");
}
