/**
 * How funeral / memorial is treated for GST. The owner keeps its GST at 0 (decision A, 27 Sept 2026); the round-3 GST research
 * says the default legal reading is CGST Act Schedule III para 4 ("services of funeral, burial, crematorium or mortuary"):
 * neither a supply of goods nor of services. So by default ("schedule_iii") it gets a bill of supply with no tax, is filed as
 * non-GST (GSTR-3B 3.1(e), GSTR-1 Table 8 non-GST) and is left out of the Rule 42 exempt turnover. Whether para 4 covers
 * animals is unsettled, so Finance can switch, without code, to "exempt" (3.1(c)) or to "taxable_18" (taxed like every other
 * service: the GST setting on the amount PawSpace makes) when the CA says so.
 *
 * One effective-dated, append-only setting for all cities: a date resolves to the latest version effective on it, so a supply
 * keeps the treatment of its own date. A change needs finance.manage (the GST route checks), a reason and an effective date
 * that is not in or before a closed month; it is audited, and repeating the same change is a no-op. Other modules read it
 * through resolveFuneralGstTreatment: the payout engine (taxable_18 only), the supply register and invoices, credit notes (no
 * GST unless taxable) and Rule 42 (Schedule III is not exempt turnover). Cold-DB safe: with no table the default applies, and
 * a read never creates one. Imports nothing that reaches the GST modules, so any of them can read it.
 */
import{governedJsonError}from"./governed-http-error";

type Db=D1Database;type Row=Record<string,unknown>;
export type FuneralGstTreatment="schedule_iii"|"exempt"|"taxable_18";
export const FUNERAL_GST_TREATMENTS:readonly FuneralGstTreatment[]=["schedule_iii","exempt","taxable_18"];
export const DEFAULT_FUNERAL_GST_TREATMENT:FuneralGstTreatment="schedule_iii";
export const FUNERAL_GST_TREATMENT_LABELS:Readonly<Record<FuneralGstTreatment,string>>={
 schedule_iii:"Outside GST (Schedule III, para 4): bill of supply, no GST, GSTR-3B 3.1(e)",
 exempt:"Exempt: bill of supply, no GST, GSTR-3B 3.1(c)",
 taxable_18:"Taxable: GST at the GST setting on the amount PawSpace makes, GSTR-3B 3.1(a)",
};
export type FuneralGstTreatmentVersion={id:string;treatment:FuneralGstTreatment;effectiveFrom:string;version:number;reason:string;createdBy:string;createdAt:number};
export type ResolvedFuneralGstTreatment={treatment:FuneralGstTreatment;settingId:string|null;effectiveFrom:string|null;version:number;source:"setting"|"default"};
const text=(v:unknown)=>String(v??"").trim();
const isDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const istToday=()=>new Date(Date.now()+330*60_000).toISOString().slice(0,10);
export const isFuneralGstTreatment=(value:unknown):value is FuneralGstTreatment=>typeof value==="string"&&(FUNERAL_GST_TREATMENTS as readonly string[]).includes(value);
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export async function ensureFuneralGstTreatmentTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS funeral_gst_treatment_versions (id TEXT PRIMARY KEY,treatment TEXT NOT NULL,effective_from TEXT NOT NULL,version INTEGER NOT NULL UNIQUE,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 // The GST audit trail every Finance tax decision writes to; same shape as lib/gst-accounting.ts, which owns it.
 db.prepare("CREATE TABLE IF NOT EXISTS gst_accounting_audit_events (id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

/** Every version, newest first. Empty on a database that never had one. */
export async function funeralGstTreatmentVersions(db:Db):Promise<FuneralGstTreatmentVersion[]>{
 if(!await tableExists(db,"funeral_gst_treatment_versions"))return[];
 return(await db.prepare("SELECT * FROM funeral_gst_treatment_versions ORDER BY effective_from DESC,version DESC").all<Row>()).results.filter(r=>isFuneralGstTreatment(r.treatment)).map(r=>({id:text(r.id),treatment:text(r.treatment) as FuneralGstTreatment,effectiveFrom:text(r.effective_from),version:Number(r.version),reason:text(r.reason),createdBy:text(r.created_by),createdAt:Number(r.created_at)}));
}
/** The treatment in force on a date (YYYY-MM-DD) among loaded versions: the latest effective on or before it, else the default. */
export function funeralGstTreatmentOn(versions:readonly FuneralGstTreatmentVersion[],date:string):ResolvedFuneralGstTreatment{
 const hit=versions.filter(v=>v.effectiveFrom<=date).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom)||b.version-a.version)[0];
 return hit?{treatment:hit.treatment,settingId:hit.id,effectiveFrom:hit.effectiveFrom,version:hit.version,source:"setting"}:{treatment:DEFAULT_FUNERAL_GST_TREATMENT,settingId:null,effectiveFrom:null,version:0,source:"default"};
}
/** THE getter: the funeral / memorial GST treatment in force on a date (YYYY-MM-DD; today in India when omitted). */
export async function resolveFuneralGstTreatment(db:Db,atDate?:string|null):Promise<ResolvedFuneralGstTreatment>{
 const date=isDate(text(atDate))?text(atDate):istToday();
 return funeralGstTreatmentOn(await funeralGstTreatmentVersions(db),date);
}

/** Record a new funeral GST treatment from a date. Finance only (the caller authorises); audited; idempotent. */
export async function saveFuneralGstTreatment(db:Db,input:{treatment:string;effectiveFrom:string;reason:string;actorId:string}){
 const treatment=text(input.treatment),effectiveFrom=text(input.effectiveFrom),reason=text(input.reason);
 if(!isFuneralGstTreatment(treatment))throw governedJsonError({error:"Choose outside GST (Schedule III), exempt or taxable"},400);
 if(!isDate(effectiveFrom))throw governedJsonError({error:"A real effective-from date is required"},400);
 if(reason.length<8)throw governedJsonError({error:"A clear reason of at least 8 characters is required"},400);
 // A closed month's figures are final: a change may not start in, or before, a month that is closed and locked.
 if(await tableExists(db,"finance_close_periods")){const closed=await db.prepare("SELECT period_code FROM finance_close_periods WHERE status='locked' AND period_code>=? ORDER BY period_code LIMIT 1").bind(effectiveFrom.slice(0,7)).first<Row>();if(closed)throw governedJsonError({error:`${text(closed.period_code)} is closed and locked; the new treatment must start after it`},409);}
 await ensureFuneralGstTreatmentTables(db);
 const versions=await funeralGstTreatmentVersions(db),latest=[...versions].sort((a,b)=>b.version-a.version)[0];
 if(latest&&latest.treatment===treatment&&latest.effectiveFrom===effectiveFrom)return{...latest,label:FUNERAL_GST_TREATMENT_LABELS[treatment],duplicatePrevented:true};
 const before=funeralGstTreatmentOn(versions,effectiveFrom),version=(latest?.version??0)+1,id=`FUNGST-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now();
 await db.batch([
  db.prepare("INSERT INTO funeral_gst_treatment_versions (id,treatment,effective_from,version,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)").bind(id,treatment,effectiveFrom,version,reason,input.actorId,now),
  db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"funeral_gst_treatment",id,"saved",JSON.stringify({treatment:before.treatment,effectiveFrom:before.effectiveFrom,source:before.source}),JSON.stringify({treatment,effectiveFrom,version}),input.actorId,reason,now),
 ]);
 return{id,treatment,effectiveFrom,version,reason,createdBy:input.actorId,createdAt:now,label:FUNERAL_GST_TREATMENT_LABELS[treatment as FuneralGstTreatment],duplicatePrevented:false};
}
