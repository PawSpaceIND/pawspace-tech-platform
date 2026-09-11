import { resolveCommercialTerm } from "./provider-commercial-terms";

type Db = D1Database;
type Row = Record<string, unknown>;
const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;

export async function ensureProviderServicePricingTables(db:Db){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS provider_service_rates (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,rate REAL NOT NULL,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(provider_id,service_code,package_code,city_id,zone_id,version))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_service_rate_lookup ON provider_service_rates(provider_id,service_code,package_code,city_id,zone_id,status,effective_from,version)"),
  ]);
}

export async function resolveProviderServiceRate(db:Db,input:{providerId?:string|null;serviceCode:string;packageCode:string;cityId:string;zoneId:string;floorPrice:number;at?:string}){
  const floor=money(input.floorPrice),providerId=text(input.providerId);
  if(!providerId)return{price:floor,source:"pawspace_floor" as const,providerRate:false};
  await ensureProviderServicePricingTables(db);
  const term=await resolveCommercialTerm(db,{serviceCode:input.serviceCode,providerId,atDate:text(input.at)?.slice(0,10)||undefined});
  if(!term||text(term.engagement_model)!=="commission_standard")return{price:floor,source:"pawspace_floor" as const,providerRate:false};
  const at=text(input.at)?.slice(0,10)||new Date().toISOString().slice(0,10);
  const row=await db.prepare("SELECT rate,version FROM provider_service_rates WHERE provider_id=? AND service_code=? AND package_code=? AND city_id=? AND zone_id=? AND status='active' AND effective_from<=? ORDER BY effective_from DESC,version DESC LIMIT 1")
    .bind(providerId,input.serviceCode,input.packageCode,input.cityId,input.zoneId,at).first<Row>();
  if(!row)return{price:floor,source:"pawspace_floor" as const,providerRate:false};
  const rate=money(row.rate);
  if(rate<floor)return{price:floor,source:"pawspace_floor_guard" as const,providerRate:false};
  return{price:rate,source:"provider_rate" as const,providerRate:true,version:Number(row.version||1)};
}

export async function saveProviderServiceRate(db:Db,input:{providerId:string;serviceCode:string;packageCode:string;cityId:string;zoneId:string;rate:number;floorPrice:number;effectiveFrom?:string;actorId:string}){
  await ensureProviderServicePricingTables(db);
  const providerId=text(input.providerId),serviceCode=text(input.serviceCode),packageCode=text(input.packageCode),cityId=text(input.cityId).toLowerCase(),zoneId=text(input.zoneId).toLowerCase();
  if(!providerId||!serviceCode||!packageCode||!cityId||!zoneId)throw new Error("Provider, service, package, city and zone are required");
  if(!["boarding","pet_sitting"].includes(serviceCode))throw new Error("Self-pricing is enabled only for Boarding and Pet Sitting");
  const term=await resolveCommercialTerm(db,{serviceCode,providerId});
  if(!term||text(term.engagement_model)!=="commission_standard")throw new Error("Only an active commission Boarding/Sitting partner can set a service rate");
  const rate=money(input.rate),floor=money(input.floorPrice);
  if(!(rate>0)||rate<floor)throw new Error(`Provider rate cannot be below the PawSpace minimum of ${floor}`);
  const prior=await db.prepare("SELECT COALESCE(MAX(version),0) v FROM provider_service_rates WHERE provider_id=? AND service_code=? AND package_code=? AND city_id=? AND zone_id=?")
    .bind(providerId,serviceCode,packageCode,cityId,zoneId).first<Row>();
  const version=Number(prior?.v||0)+1,now=Date.now(),effectiveFrom=text(input.effectiveFrom)||new Date().toISOString().slice(0,10),id=`PSR-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  await db.batch([
    db.prepare("UPDATE provider_service_rates SET status='superseded',updated_at=? WHERE provider_id=? AND service_code=? AND package_code=? AND city_id=? AND zone_id=? AND status='active'").bind(now,providerId,serviceCode,packageCode,cityId,zoneId),
    db.prepare("INSERT INTO provider_service_rates (id,provider_id,service_code,package_code,city_id,zone_id,rate,status,version,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)").bind(id,providerId,serviceCode,packageCode,cityId,zoneId,rate,version,effectiveFrom,input.actorId,now),
  ]);
  return{id,providerId,serviceCode,packageCode,cityId,zoneId,rate,floorPrice:floor,version,status:"active"};
}

export async function listProviderServiceRates(db:Db,providerId:string){
  await ensureProviderServicePricingTables(db);
  const rows=await db.prepare("SELECT provider_id,service_code,package_code,city_id,zone_id,rate,version,effective_from FROM provider_service_rates WHERE provider_id=? AND status='active' ORDER BY service_code,package_code").bind(providerId).all<Row>();
  return rows.results.map(r=>({providerId:String(r.provider_id),serviceCode:String(r.service_code),packageCode:String(r.package_code),cityId:String(r.city_id),zoneId:String(r.zone_id),rate:Number(r.rate),version:Number(r.version),effectiveFrom:String(r.effective_from)}));
}
