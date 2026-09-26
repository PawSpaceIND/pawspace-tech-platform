/**
 * THE one GST setting (owner decision 1, 26 Sept 2026): a rate and a method, effective-dated, audited, per
 * city with a platform-wide default ("*" = all cities). Every service GST calculation reads it through
 * resolveGstPolicy() and computes with gstOn() from lib/gst-method.ts. With nothing configured the owner's
 * default applies: 18% of the base ("percent_of_base"). Finance can switch a city, or every city, to
 * "extract_inclusive" (GST taken out of a GST-inclusive amount) if the CA says so - no code change.
 *
 * Rows are append-only versions: publishing never edits an earlier row, so a booking dated before a change
 * keeps the rule that applied on its date, and every change carries its author, reason and an audit event.
 * A city row beats the all-cities row; within a scope the latest effective date, then version, wins.
 *
 * Not governed here (owner decision 9, not decided yet): the GST shown to customers on quotes and the tax
 * printed on per-service customer invoices. Those keep their own city policies; publishing a setting that is
 * already in force keeps the grooming quote rate in step (see publishGstSetting) so assisted booking works.
 */
import{DEFAULT_GST_POLICY,gstPolicyProblem,type GstMethod,type GstPolicy}from"./gst-method";
import{saveGroomingTaxPolicy}from"./grooming-invoice";
import{governedJsonError}from"./governed-http-error";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const today=()=>new Date().toISOString().slice(0,10);
const isDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export const GST_SETTING_ALL_CITIES="*";
export type ResolvedGstPolicy=GstPolicy&{settingId:string|null;cityId:string;scope:"city"|"all_cities"|"built_in_default";effectiveFrom:string|null;version:number};
const tablesReady=new WeakSet<Db>();
export async function ensureGstSettingTables(db:Db){if(tablesReady.has(db))return;await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS gst_setting_versions (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,rate_percent REAL NOT NULL,method TEXT NOT NULL,effective_from TEXT NOT NULL,version INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(city_id,version))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_gst_setting_lookup ON gst_setting_versions(city_id,effective_from,version)"),
 db.prepare("CREATE TABLE IF NOT EXISTS gst_setting_audit (id TEXT PRIMARY KEY,setting_id TEXT NOT NULL,city_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);tablesReady.add(db);}
const scopeOf=(cityId:unknown)=>{const city=text(cityId).toLowerCase();return!city||city===GST_SETTING_ALL_CITIES?GST_SETTING_ALL_CITIES:city;};
function recordOf(row:Row,cityId:string):ResolvedGstPolicy{const policy={ratePercent:Number(row.rate_percent),method:text(row.method) as GstMethod},problem=gstPolicyProblem(policy);if(problem)throw new Error(`configuration_required: GST setting ${text(row.id)} is invalid: ${problem}`);return{...policy,settingId:text(row.id),cityId,scope:text(row.city_id)===GST_SETTING_ALL_CITIES?"all_cities":"city",effectiveFrom:text(row.effective_from),version:Number(row.version||1)};}
/** The GST rule in force for a city on a date (YYYY-MM-DD, default today). Never throws for "not configured":
 * that is the owner's default, 18% of the base. */
export async function resolveGstPolicy(db:Db,input:{cityId?:string|null;atDate?:string|null}={}):Promise<ResolvedGstPolicy>{
 await ensureGstSettingTables(db);
 const cityId=scopeOf(input.cityId),date=isDate(text(input.atDate))?text(input.atDate):today();
 const row=await db.prepare("SELECT * FROM gst_setting_versions WHERE (city_id=? OR city_id='*') AND effective_from<=? ORDER BY CASE WHEN city_id=? THEN 0 ELSE 1 END,effective_from DESC,version DESC LIMIT 1").bind(cityId,date,cityId).first<Row>();
 return row?recordOf(row,cityId):{...DEFAULT_GST_POLICY,settingId:null,cityId,scope:"built_in_default",effectiveFrom:null,version:0};
}
/** Publish a new version of the setting for one city or for all cities ("*"). Finance only (the caller
 * authorises); a reason and an effective date are required, and the change is audited. Input problems are
 * governed 400s, so the Finance screen shows the reason instead of a generic failure. */
export async function saveGstSetting(db:Db,input:{cityId?:string|null;ratePercent:number;method:GstMethod|string;effectiveFrom:string;reason:string;actorId:string}){
 await ensureGstSettingTables(db);
 const cityId=scopeOf(input.cityId),effectiveFrom=text(input.effectiveFrom),reason=text(input.reason),policy={ratePercent:Number(input.ratePercent),method:text(input.method)};
 if(cityId!==GST_SETTING_ALL_CITIES&&!/^[a-z0-9_-]{2,40}$/.test(cityId))throw governedJsonError({error:"Choose all cities or a real city code"},400);
 const problem=gstPolicyProblem(policy);if(problem)throw governedJsonError({error:problem},400);
 if(!isDate(effectiveFrom))throw governedJsonError({error:"A real effective-from date is required"},400);
 if(reason.length<8)throw governedJsonError({error:"A clear reason of at least 8 characters is required"},400);
 const prior=await db.prepare("SELECT MAX(version) v FROM gst_setting_versions WHERE city_id=?").bind(cityId).first<Row>(),version=Number(prior?.v||0)+1,id=`GSTSET-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now(),method=policy.method as GstMethod;
 await db.batch([
  db.prepare("INSERT INTO gst_setting_versions (id,city_id,rate_percent,method,effective_from,version,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,cityId,policy.ratePercent,method,effectiveFrom,version,reason,input.actorId,now),
  db.prepare("INSERT INTO gst_setting_audit (id,setting_id,city_id,action,actor_id,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,cityId,"published",input.actorId,reason,JSON.stringify({ratePercent:policy.ratePercent,method,effectiveFrom,version}),now),
 ]);
 return{settingId:id,cityId,ratePercent:policy.ratePercent,method,effectiveFrom,version,status:"published" as const};
}
/** Publish the setting and, when it is already in force, keep the grooming quote rate in step: customer
 * quotes still show GST as included in the price (owner decision 9 leaves that display as it is), but at
 * the one rate Finance set. A future-dated setting leaves quotes alone until it is republished. */
export async function publishGstSetting(db:Db,input:Parameters<typeof saveGstSetting>[1]){
 const saved=await saveGstSetting(db,input),quoteCities:string[]=[];
 if(saved.effectiveFrom<=today()){
  let cities=[saved.cityId];
  if(saved.cityId===GST_SETTING_ALL_CITIES){const quoted=await db.prepare("SELECT city_id FROM grooming_tax_policies").all<Row>().catch(()=>({results:[] as Row[]})),own=await db.prepare("SELECT DISTINCT city_id FROM gst_setting_versions WHERE city_id!='*'").all<Row>();const skip=new Set(own.results.map(r=>text(r.city_id)));cities=[...new Set(["blr",...quoted.results.map(r=>text(r.city_id))])].filter(city=>city&&!skip.has(city));}
  for(const city of cities){await saveGroomingTaxPolicy(db,{cityId:city,taxMode:"inclusive",taxRate:saved.ratePercent,effectiveFrom:saved.effectiveFrom,actorId:input.actorId,reason:`Kept in step with the GST setting ${saved.settingId}: ${text(input.reason)}`});quoteCities.push(city);}
 }
 return{...saved,groomingQuoteCitiesUpdated:quoteCities};
}
/** What the Finance screen shows: the rule in force for all cities, each city's own rule, history, and the cities a
 * setting can be published for (launched cities, cities with a grooming quote policy, cities with their own setting). */
export async function gstSettingDirectory(db:Db){
 await ensureGstSettingTables(db);
 const empty={results:[] as Row[]};
 const[platform,rows,audit,launched,quoted]=await Promise.all([resolveGstPolicy(db,{cityId:GST_SETTING_ALL_CITIES}),db.prepare("SELECT id,city_id,rate_percent,method,effective_from,version,reason,created_by,created_at FROM gst_setting_versions ORDER BY created_at DESC LIMIT 100").all<Row>(),db.prepare("SELECT id,setting_id,city_id,action,actor_id,reason,detail_json,created_at FROM gst_setting_audit ORDER BY created_at DESC LIMIT 50").all<Row>(),db.prepare("SELECT city_code,city FROM city_launch_configs ORDER BY city").all<Row>().catch(()=>empty),db.prepare("SELECT city_id FROM grooming_tax_policies").all<Row>().catch(()=>empty)]);
 const cityIds=[...new Set(rows.results.map(r=>text(r.city_id)).filter(city=>city!==GST_SETTING_ALL_CITIES))].sort(),cities=await Promise.all(cityIds.map(city=>resolveGstPolicy(db,{cityId:city})));
 const names=new Map<string,string>([["blr","Bengaluru"]]);for(const r of launched.results){const code=scopeOf(r.city_code);if(code!==GST_SETTING_ALL_CITIES)names.set(code,text(r.city)||code.toUpperCase());}for(const city of[...quoted.results.map(r=>scopeOf(r.city_id)),...cityIds])if(city!==GST_SETTING_ALL_CITIES&&!names.has(city))names.set(city,city.toUpperCase());
 return{platform,cities:cities.filter(c=>c.scope==="city"),knownCities:[...names].map(([cityId,name])=>({cityId,name})).sort((a,b)=>a.name.localeCompare(b.name)),history:rows.results,audit:audit.results,defaultPolicy:DEFAULT_GST_POLICY};
}
