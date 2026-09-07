import{cityFulfilmentVerdict}from"./city-coverage-authority";
import{geocodeAddress}from"./address-autocomplete";
import{validateIndianPincode}from"./pincode-validation";
import{resolveZoneByPincode}from"./service-zones";

type Db=D1Database;
type Row=Record<string,unknown>;

export const SERVICE_DISCOVERY_RADIUS_KM=16;
export type GovernedServiceAddress={addressId:string;address:string;pincode:string;cityId:string;zoneId:string;latitude:number;longitude:number;serviceRadiusKm?:number};

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function ensureAddressTables(db:Db){
  if(!await tableExists(db,"customer_addresses"))await db.prepare("CREATE TABLE IF NOT EXISTS customer_addresses (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,label TEXT NOT NULL,line1 TEXT NOT NULL,line2 TEXT,area TEXT,city TEXT NOT NULL,postal_code TEXT,is_default INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS customer_service_address_geocodes (address_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,pincode TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,resolved_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_service_geocodes_customer ON customer_service_address_geocodes(customer_id,updated_at DESC)").run();
}
function completeAddress(row:Row,pincode:string){return[String(row.line1||"").trim(),String(row.line2||"").trim(),String(row.area||"").trim(),String(row.city||"").trim(),pincode,"India"].filter(Boolean).join(", ");}
function addressId(customerId:string,pincode:string,address:string){let h=2166136261;for(const ch of `${customerId}|${pincode}|${address}`){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return`SD-${customerId.replace(/[^A-Za-z0-9]/g,"").slice(-20)}-${(h>>>0).toString(36)}`;}
function truthy(value:unknown){return["1","true","on","yes"].includes(String(value??"").trim().toLowerCase());}
async function testFixtureEnabled(){const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>,processEnv=typeof process!=="undefined"?process.env:{};const read=(key:string)=>runtime[key]??processEnv[key];return truthy(read("PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE"))&&String(read("PAWSPACE_PAYMENT_ENV")||"").toLowerCase()==="sandbox"&&(String(read("NODE_ENV")||"").toLowerCase()==="test"||String(read("PAWSPACE_SCHEDULING_ENV")||"").toLowerCase()==="uat");}
async function ensureTestProviderHomeBases(db:Db){
  await db.prepare("CREATE TABLE IF NOT EXISTS provider_home_base (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,effective_from INTEGER NOT NULL,effective_until INTEGER,reason TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from)").run();
  const providers=["groom_arun","groom_kiran","groom_sanjay","train_kiran","train_ramesh","train_meera"],now=Date.now();
  await db.batch(providers.map((providerId,index)=>db.prepare("INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT ?,?,?,?,?,0,NULL,'Explicit sandbox service-discovery fixture','test_fixture',? WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id=?)").bind(`TST-PHB-${providerId}`,providerId,"PawSpace sandbox provider base",12.9716+(index*0.002),77.5946+(index*0.002),now,providerId)));
}

/** Resolve the address authority used by scheduling.
 * Clients may identify the address and PIN the customer selected, but city, zone, coordinates and
 * radius are always derived here. If a new address is supplied, it becomes a governed customer address
 * only after strict PIN validation, coverage validation and server-side geocoding succeed.
 *
 * Legacy executable suites can opt into one explicit server-owned sandbox fixture with
 * PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE=on. The fixture is impossible to activate unless the runtime
 * is sandbox plus test/UAT, and it never trusts browser city/zone/coordinates. */
export async function resolveGovernedServiceAddress(db:Db,input:{customerId:string;serviceCode:string;serviceAddress?:string;servicePincode?:string}) : Promise<GovernedServiceAddress>{
  await ensureAddressTables(db);const fixture=await testFixtureEnabled();if(fixture)await ensureTestProviderHomeBases(db);
  const suppliedAddress=String(input.serviceAddress||"").trim(),suppliedPincode=String(input.servicePincode||"").trim();
  let row:Row|null=null;
  if(suppliedAddress||suppliedPincode){
    const pin=validateIndianPincode(suppliedPincode);if(!pin.ok)throw new Response("A valid 6-digit service PIN code is required",{status:400});
    if(suppliedAddress.length<8)throw new Response("A complete service address is required",{status:400});
    row={id:addressId(input.customerId,pin.pincode,suppliedAddress),line1:suppliedAddress,line2:null,area:null,city:"",postal_code:pin.pincode};
  }else{
    row=await db.prepare("SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,updated_at DESC,created_at DESC LIMIT 1").bind(input.customerId).first<Row>();
    if(!row&&fixture){const address="PawSpace sandbox service-discovery fixture, Indiranagar",pincode="560038";row={id:addressId(input.customerId,pincode,address),line1:address,line2:null,area:"Indiranagar",city:"Bengaluru",postal_code:pincode};}
    if(!row)throw new Response("Save a service address before booking",{status:409});
  }
  const validated=validateIndianPincode(String(row.postal_code||""));if(!validated.ok)throw new Response("The saved service address has an invalid PIN code",{status:409});
  const resolved=await resolveZoneByPincode(db,validated.pincode);if(!resolved||!resolved.zone.serviceAvailable)throw new Response("PawSpace is not currently serving this service address",{status:409});
  const cityId=String(resolved.assignment.cityId||"").trim().toLowerCase();if(!cityId)throw new Response("The service address has no governed city",{status:409});
  const cityVerdict=await cityFulfilmentVerdict(db,cityId,validated.pincode);if(!cityVerdict.open)throw new Response("PawSpace is not currently serving this address",{status:409});
  const address=suppliedAddress?`${suppliedAddress}, ${validated.pincode}, India`:completeAddress(row,validated.pincode);
  let geo=await db.prepare("SELECT latitude,longitude,address_text FROM customer_service_address_geocodes WHERE address_id=? AND customer_id=? AND pincode=? AND city_id=? AND zone_id=?").bind(String(row.id),input.customerId,validated.pincode,cityId,resolved.assignment.zoneId).first<Row>();
  if(!geo){
    const geocoded=fixture?{status:"configured"as const,address,latitude:12.9716,longitude:77.5946}:await geocodeAddress({address});
    if(geocoded.status!=="configured"||!Number.isFinite(geocoded.latitude)||!Number.isFinite(geocoded.longitude))throw new Response(geocoded.error||"The service address could not be geocoded for provider matching",{status:409});
    const now=Date.now(),id=String(row.id);
    if(suppliedAddress||fixture){
      await db.prepare("UPDATE customer_addresses SET is_default=0,updated_at=? WHERE customer_id=?").bind(now,input.customerId).run();
      await db.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET line1=excluded.line1,city=excluded.city,postal_code=excluded.postal_code,is_default=1,updated_at=excluded.updated_at WHERE customer_addresses.customer_id=excluded.customer_id").bind(id,input.customerId,fixture&&!suppliedAddress?String(row.line1):suppliedAddress,null,resolved.assignment.area,resolved.assignment.city,validated.pincode,now,now).run();
    }
    await db.prepare("INSERT INTO customer_service_address_geocodes (address_id,customer_id,pincode,city_id,zone_id,address_text,latitude,longitude,resolved_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET customer_id=excluded.customer_id,pincode=excluded.pincode,city_id=excluded.city_id,zone_id=excluded.zone_id,address_text=excluded.address_text,latitude=excluded.latitude,longitude=excluded.longitude,resolved_at=excluded.resolved_at,updated_at=excluded.updated_at").bind(id,input.customerId,validated.pincode,cityId,resolved.assignment.zoneId,geocoded.address||address,Number(geocoded.latitude),Number(geocoded.longitude),now,now).run();
    geo={latitude:Number(geocoded.latitude),longitude:Number(geocoded.longitude),address_text:geocoded.address||address};
  }
  const radius=input.serviceCode==="grooming"||input.serviceCode==="dog_training"?SERVICE_DISCOVERY_RADIUS_KM:undefined;
  return{addressId:String(row.id),address:String(geo.address_text||address),pincode:validated.pincode,cityId,zoneId:resolved.assignment.zoneId,latitude:Number(geo.latitude),longitude:Number(geo.longitude),serviceRadiusKm:radius};
}