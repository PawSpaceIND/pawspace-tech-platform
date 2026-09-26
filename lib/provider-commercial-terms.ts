/**
 * Provider commercial terms + the payout/GST engine - the single money core for how a service order's
 * value is split between the service provider and PawSpace, and how GST is treated. Owner decisions of
 * 26 Sept 2026 (they replace the earlier "carve GST off the top" model):
 *
 *   Commission (every service except funeral; engagement models commission_groomer and
 *   commission_standard, which now behave identically): the provider's share and PawSpace's commission
 *   are percentages of the amount the customer PAID. No GST is taken off before the split. PawSpace's GST
 *   is the ONE GST setting (lib/gst-setting.ts, computed by gstOn() in lib/gst-method.ts) applied to its
 *   commission. Rs 1,000 at 70/30 -> provider 700, commission 300, GST 54 (18% of 300), PawSpace keeps 246.
 *   s.52 TCS (0.5%) is withheld from the provider only when they hold an active GSTIN tax profile
 *   (lib/provider-tcs.ts); that happens at completion, not here.
 *
 *   Own supply (direct_employee - PawSpace delivers with a full-time/contract provider or its own vehicle):
 *   PawSpace's GST is the setting applied to the full paid amount. Rs 1,000 -> GST 180, PawSpace keeps 820.
 *   A provider whose capacity profile says provider_model='full_time' is ALWAYS own supply, whatever
 *   commission term the service default, the provider or an order override would give them - full-time
 *   providers are never paid commission.
 *
 *   Funeral / memorial (funeral_exempt, or any funeral service code): GST exempt - 0 on the commission and
 *   0 on own supply, and no s.52 TCS (an exempt supply is not a taxable supply). The provider's share is a
 *   percentage of the paid amount; a caller may still pass an explicit standardReferencePrice to base the
 *   share on PawSpace's own standard price instead.
 *
 * With extract_inclusive selected in the setting (if the CA says prices include GST) the same rules give
 * 45.76 on a 300 commission and 152.54 on a 1,000 own supply. Who is the supplier of record on the customer
 * invoice is NOT decided (owner decision 9) and nothing here assumes an answer.
 *
 * Every number except the GST rule is CONFIGURATION: share %, cash eligibility and the onboarding/renewal
 * fee are set per service, overridable per provider, and overridable per order. Terms are versioned +
 * maker/checker governed (activation needs a second party). The engine only computes and records - real
 * disbursement stays in the governed sandbox settlement flow.
 *
 * RETIRED: gst_mode "provider_gst_on_behalf" and "platform_retained" (the old 18/118 carve). Stored terms that
 * carry them still resolve, and behave exactly like "none"; provider_gst_deducted is always 0 on new rows.
 * A completed booking's row is final (see finalizedPayout): rows completed under the retired carve keep the
 * figures their completion journal was posted from.
 */

import{gstBreakdown,type GstMethod,type GstPolicy}from"./gst-method";
import{resolveGstPolicy}from"./gst-setting";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type EngagementModel="commission_groomer"|"commission_standard"|"direct_employee"|"funeral_exempt";
/** "none" is the only live treatment; the other two are the retired carve modes, still readable on old rows. */
export type GstMode="none"|"provider_gst_on_behalf"|"platform_retained";
export type SupplyModel="commission"|"own_supply";
export type PayoutBreakdown={
 bookingId:string;serviceCode:string;providerId:string;engagementModel:EngagementModel;orderValue:number;
 providerSharePct:number;platformFeePct:number;platformFee:number;platformGstRate:number;platformGst:number;
 providerGrossShare:number;providerGstMode:GstMode;providerGstDeducted:number;providerNetPayout:number;
 pawspaceGstOnOrder:number;directInvoice:boolean;cashAllowed:boolean;termId:string;termSource:string;
 gstExempt:boolean;standardReferencePrice:number;payoutBasis:"net_pool"|"full_order"|"standard_price";
 supplyModel:SupplyModel;engagementSource:"term"|"order_override"|"provider_full_time";gstMethod:GstMethod;gstRatePercent:number;
 gstSettingId:string|null;gstSettingScope:string;taxableCommission:number;ownSupplyTaxableValue:number;retiredGstMode:GstMode|null;
};
/** Funeral / memorial is GST exempt everywhere (owner decision 4), whatever engagement model a term names. */
export const FUNERAL_SERVICE_CODES:ReadonlySet<string>=new Set(["funeral","funeral_memorial"]);
/** The commission (marketplace) models: the provider supplies through PawSpace, so s.52 TCS can apply. */
export const COMMISSION_ENGAGEMENT_MODELS:ReadonlySet<string>=new Set(["commission_groomer","commission_standard"]);

const MODEL_DEFAULTS:Record<EngagementModel,{share:number;gstMode:GstMode;cash:boolean}>={
 commission_groomer:{share:0.70,gstMode:"none",cash:true},
 commission_standard:{share:0.70,gstMode:"none",cash:false},
 direct_employee:{share:0,gstMode:"none",cash:false},
 funeral_exempt:{share:0.70,gstMode:"none",cash:true},
};

/* Columns filing, TCS and settlement need, added in place to tables created before they existed.
 * computed_at is the statutory period (TCS, TDS, settlement): completion pins it and it never moves after. */
const PAYOUT_COMPUTATION_COLUMNS:ReadonlyArray<readonly[string,string]>=[["engagement_model","TEXT"],["supply_model","TEXT"],["gst_method","TEXT"],["gst_rate","REAL"],["gst_setting_id","TEXT"],["taxable_commission","REAL NOT NULL DEFAULT 0"],["own_supply_taxable_value","REAL NOT NULL DEFAULT 0"],["gst_exempt","INTEGER NOT NULL DEFAULT 0"],["provider_gst_registered","INTEGER"],["supplier_gstin","TEXT"],["tcs_base","REAL"],["tcs_withheld","REAL"],["tcs_rate_version","TEXT"],["finalized_at","INTEGER"],["recomputed_at","INTEGER"]];
const payoutColumnsReady=new WeakSet<Db>();
export async function ensureCommercialTermsTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS provider_commercial_terms (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,provider_id TEXT,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',engagement_model TEXT NOT NULL,provider_share_pct REAL NOT NULL,gst_mode TEXT NOT NULL,platform_gst_rate REAL NOT NULL DEFAULT 0.18,cash_allowed INTEGER NOT NULL DEFAULT 0,onboarding_fee REAL NOT NULL DEFAULT 0,renewal_fee REAL NOT NULL DEFAULT 0,renewal_months INTEGER NOT NULL DEFAULT 12,effective_from TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,approved_by TEXT,approval_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_terms_lookup ON provider_commercial_terms(service_code,provider_id,status,effective_from)"),
 db.prepare("CREATE TABLE IF NOT EXISTS order_commercial_overrides (booking_id TEXT PRIMARY KEY,provider_share_pct REAL,engagement_model TEXT,gst_mode TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,order_value REAL NOT NULL,provider_net_payout REAL NOT NULL,platform_fee REAL NOT NULL,platform_gst REAL NOT NULL,provider_gst_deducted REAL NOT NULL,pawspace_gst_on_order REAL NOT NULL,breakdown_json TEXT NOT NULL,term_id TEXT NOT NULL,computed_by TEXT NOT NULL,computed_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_onboarding_fee_obligations (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,term_id TEXT NOT NULL,fee_type TEXT NOT NULL,amount REAL NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'due',environment TEXT NOT NULL DEFAULT 'sandbox',created_at INTEGER NOT NULL,UNIQUE(provider_id,fee_type,due_date))"),
 db.prepare("CREATE TABLE IF NOT EXISTS commercial_terms_audit (id TEXT PRIMARY KEY,term_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);if(payoutColumnsReady.has(db))return;const have=new Set((await db.prepare("PRAGMA table_info(provider_payout_computations)").all<Row>()).results.map(r=>text(r.name)));for(const[column,definition]of PAYOUT_COMPUTATION_COLUMNS)if(!have.has(column))await db.prepare(`ALTER TABLE provider_payout_computations ADD COLUMN ${column} ${definition}`).run().catch((error:unknown)=>{/* a concurrent request added it first */if(!/duplicate column name/i.test(error instanceof Error?error.message:String(error)))throw error;});payoutColumnsReady.add(db);}

function validate(model:string,share:number,gstMode:string){
 if(!(model in MODEL_DEFAULTS))throw new Error("Unknown engagement model");
 if(!(share>=0&&share<=1))throw new Error("Provider share must be a fraction between 0 and 1");
 if(!["none","provider_gst_on_behalf","platform_retained"].includes(gstMode))throw new Error("Unknown GST mode");
 if(model==="direct_employee"&&share!==0)throw new Error("Direct-employee services have no provider revenue share");
}

/**
 * THE split (owner decisions 2-4), pure so the engine and the taxi fleet share it.
 * Commission: provider = share x paid (or x an explicit standard price for funeral); commission = paid -
 * provider; GST = the setting on the commission. Own supply: GST = the setting on the paid amount. Exempt: 0.
 */
export function splitServiceOrder(input:{paidAmount:number;providerSharePct:number;ownSupply:boolean;gstExempt:boolean;gstPolicy:GstPolicy;standardReferencePrice?:number|null}){
 const paid=money(input.paidAmount),exempt=(base:number)=>({gst:0,taxableValue:money(base)});
 if(input.ownSupply){const g=input.gstExempt?exempt(paid):gstBreakdown(paid,input.gstPolicy);return{supplyModel:"own_supply" as SupplyModel,providerGrossShare:0,platformFee:money(paid-g.gst),platformGst:0,pawspaceGstOnOrder:g.gst,taxableCommission:0,ownSupplyTaxableValue:g.taxableValue,payoutBasis:"full_order" as const,standardReferencePrice:0};}
 const reference=input.standardReferencePrice!=null&&Number(input.standardReferencePrice)>0?money(input.standardReferencePrice):0,providerGrossShare=money((reference||paid)*input.providerSharePct),platformFee=money(paid-providerGrossShare),g=input.gstExempt?exempt(platformFee):gstBreakdown(platformFee,input.gstPolicy);
 return{supplyModel:"commission" as SupplyModel,providerGrossShare,platformFee,platformGst:g.gst,pawspaceGstOnOrder:0,taxableCommission:g.taxableValue,ownSupplyTaxableValue:0,payoutBasis:reference?"standard_price" as const:"full_order" as const,standardReferencePrice:reference};
}

/** Create (maker) a draft commercial term for a service (provider_id null = the service default) or a specific provider. */
export async function saveCommercialTerm(db:Db,input:{serviceCode:string;providerId?:string|null;engagementModel:EngagementModel;providerSharePct?:number;gstMode?:GstMode;platformGstRate?:number;cashAllowed?:boolean;onboardingFee?:number;renewalFee?:number;renewalMonths?:number;effectiveFrom:string;reason:string;actorId:string}){
 await ensureCommercialTermsTables(db);
 if(!text(input.serviceCode))throw new Error("Service code is required");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(text(input.effectiveFrom)))throw new Error("A real effective-from date is required");
 if(text(input.reason).length<8)throw new Error("A clear reason is required");
 const d=MODEL_DEFAULTS[input.engagementModel];if(!d)throw new Error("Unknown engagement model");
 const share=input.providerSharePct==null?d.share:Number(input.providerSharePct);
 const gstMode=input.gstMode||d.gstMode;
 validate(input.engagementModel,share,gstMode);
 const providerId=text(input.providerId)||null;
 const prior=await db.prepare("SELECT MAX(version) v FROM provider_commercial_terms WHERE service_code=? AND (provider_id IS ? OR provider_id=?)").bind(input.serviceCode,providerId,providerId).first<Row>();
 const version=num(prior?.v)+1,id=uid("PCT"),now=Date.now();
 await db.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(id,input.serviceCode,providerId,version,input.engagementModel,share,gstMode,input.platformGstRate==null?0.18:Number(input.platformGstRate),input.cashAllowed==null?(d.cash?1:0):(input.cashAllowed?1:0),money(input.onboardingFee),money(input.renewalFee),input.renewalMonths==null?12:Math.floor(Number(input.renewalMonths)),text(input.effectiveFrom),text(input.reason),input.actorId,now,now).run();
 await db.prepare("INSERT INTO commercial_terms_audit (id,term_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("CTA"),id,"drafted",input.actorId,JSON.stringify({serviceCode:input.serviceCode,providerId,engagementModel:input.engagementModel,share,gstMode}),now).run();
 return{id,serviceCode:input.serviceCode,providerId,version,engagementModel:input.engagementModel,providerSharePct:share,gstMode,status:"draft"};
}

/** Activate (checker) a drafted term. The activator must differ from the drafter. Supersedes the prior active term for the same scope. */
export async function activateCommercialTerm(db:Db,input:{termId:string;approvalReference:string;actorId:string}){
 await ensureCommercialTermsTables(db);
 if(text(input.approvalReference).length<4)throw new Error("An approval reference is required to activate commercial terms");
 const term=await db.prepare("SELECT * FROM provider_commercial_terms WHERE id=?").bind(input.termId).first<Row>();
 if(!term||text(term.status)!=="draft")throw new Error("Only a draft commercial term can be activated");
 if(text(term.created_by)===text(input.actorId))throw new Error("Maker/checker: the drafter cannot activate their own commercial term");
 const now=Date.now();
 await db.batch([
  db.prepare("UPDATE provider_commercial_terms SET status='superseded',updated_at=? WHERE service_code=? AND (provider_id IS ? OR provider_id=?) AND status='active'").bind(now,term.service_code,term.provider_id,term.provider_id),
  db.prepare("UPDATE provider_commercial_terms SET status='active',approved_by=?,approval_reference=?,updated_at=? WHERE id=?").bind(input.actorId,text(input.approvalReference),now,input.termId),
  db.prepare("INSERT INTO commercial_terms_audit (id,term_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("CTA"),input.termId,"activated",input.actorId,JSON.stringify({approvalReference:text(input.approvalReference)}),now),
 ]);
 // record onboarding + first renewal fee obligations (sandbox) if configured
 if(num(term.onboarding_fee)>0||num(term.renewal_fee)>0){
  const providerId=text(term.provider_id);
  if(providerId){
   if(num(term.onboarding_fee)>0)await db.prepare("INSERT OR IGNORE INTO provider_onboarding_fee_obligations (id,provider_id,term_id,fee_type,amount,due_date,status,environment,created_at) VALUES (?,?,?,?,?,?,'due','sandbox',?)").bind(uid("FEE"),providerId,input.termId,"onboarding",money(term.onboarding_fee),text(term.effective_from),now).run();
   if(num(term.renewal_fee)>0){const ef=text(term.effective_from),months=num(term.renewal_months)||12;const d=new Date(`${ef}T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+months);const dueDate=d.toISOString().slice(0,10);
    await db.prepare("INSERT OR IGNORE INTO provider_onboarding_fee_obligations (id,provider_id,term_id,fee_type,amount,due_date,status,environment,created_at) VALUES (?,?,?,?,?,?,'due','sandbox',?)").bind(uid("FEE"),providerId,input.termId,"renewal",money(term.renewal_fee),dueDate,now).run();}
  }
 }
 return{termId:input.termId,status:"active"};
}

/** Order-wise override (change the split/model for one booking, reasoned + audited). */
export async function setOrderCommercialOverride(db:Db,input:{bookingId:string;providerSharePct?:number|null;engagementModel?:EngagementModel|null;gstMode?:GstMode|null;reason:string;actorId:string}){
 await ensureCommercialTermsTables(db);
 if(text(input.reason).length<8)throw new Error("A clear reason is required for an order-wise commercial override");
 if(input.providerSharePct!=null&&!(input.providerSharePct>=0&&input.providerSharePct<=1))throw new Error("Override share must be a fraction between 0 and 1");
 const now=Date.now();
 await db.prepare("INSERT INTO order_commercial_overrides (booking_id,provider_share_pct,engagement_model,gst_mode,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET provider_share_pct=excluded.provider_share_pct,engagement_model=excluded.engagement_model,gst_mode=excluded.gst_mode,reason=excluded.reason,actor_id=excluded.actor_id,created_at=excluded.created_at")
  .bind(input.bookingId,input.providerSharePct??null,input.engagementModel??null,input.gstMode??null,text(input.reason),input.actorId,now).run();
 return{bookingId:input.bookingId,override:true};
}

/** Resolve the active term for a (service, provider) at a date: provider-specific active wins over the service default. */
export async function resolveCommercialTerm(db:Db,input:{serviceCode:string;providerId?:string|null;atDate?:string}){
 await ensureCommercialTermsTables(db);
 const atDate=text(input.atDate)||new Date().toISOString().slice(0,10);
 const providerId=text(input.providerId)||null;
 if(providerId){
  const own=await db.prepare("SELECT * FROM provider_commercial_terms WHERE service_code=? AND provider_id=? AND status='active' AND effective_from<=? ORDER BY effective_from DESC,version DESC LIMIT 1").bind(input.serviceCode,providerId,atDate).first<Row>();
  if(own)return{...own,termSource:"provider"} as Row;
 }
 const def=await db.prepare("SELECT * FROM provider_commercial_terms WHERE service_code=? AND provider_id IS NULL AND status='active' AND effective_from<=? ORDER BY effective_from DESC,version DESC LIMIT 1").bind(input.serviceCode,atDate).first<Row>();
 return def?{...def,termSource:"service_default"} as Row:null;
}

/** THE PAYOUT ENGINE. Compute the full split + GST breakdown for one booking. Fail-closed: no active term → throws. */
/** Mirrors ConfigurationRequired in lib/gst-accounting.ts: the settled shape for "a governed value
 * cannot be computed because the platform was never configured for it". */
export class CommercialTermConfigurationRequired extends Error{
 key:string;
 constructor(serviceCode:string){super(`configuration_required: no active commercial term for service ${serviceCode}`);this.key=`commercial_term:${serviceCode}`;this.name="CommercialTermConfigurationRequired";}
}

/** A completed booking's payout record is final: completion posted its journal from it and the statutory
 * period (TCS, TDS, settlement) keys on its computed_at. A later PERSISTING recompute returns that record
 * instead of rewriting the tax figures or moving the booking into a later month; persist:false still gives
 * a fresh preview under the current terms and GST setting. */
async function finalizedPayout(db:Db,bookingId:string):Promise<PayoutBreakdown|null>{const row=await db.prepare("SELECT * FROM provider_payout_computations WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);if(!row||!(num(row.finalized_at)>0))return null;let stored:Partial<PayoutBreakdown>={};try{stored=JSON.parse(text(row.breakdown_json)) as Partial<PayoutBreakdown>;}catch{stored={};}
 // The row's own columns are the record (a Pet Taxi fleet row or a pre-26-Sept row keeps a different breakdown_json shape); the JSON adds the detail.
 return{...stored,bookingId,serviceCode:text(row.service_code),providerId:text(row.provider_id),engagementModel:(text(row.engagement_model)||text(stored.engagementModel)) as EngagementModel,orderValue:money(row.order_value),providerNetPayout:money(row.provider_net_payout),providerGrossShare:stored.providerGrossShare??money(row.provider_net_payout),platformFee:money(row.platform_fee),platformGst:money(row.platform_gst),providerGstDeducted:money(row.provider_gst_deducted),pawspaceGstOnOrder:money(row.pawspace_gst_on_order),termId:text(row.term_id),gstExempt:Boolean(stored.gstExempt)||num(row.gst_exempt)===1} as PayoutBreakdown;}

export async function computeOrderPayout(db:Db,input:{bookingId:string;actorId:string;persist?:boolean;standardReferencePrice?:number}):Promise<PayoutBreakdown>{
 await ensureCommercialTermsTables(db);
 const booking=await db.prepare("SELECT id,service_code,provider_id,total_amount,scheduled_start FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Canonical booking not found");
 if(input.persist!==false){const final=await finalizedPayout(db,input.bookingId);if(final)return final;}
 const serviceCode=text(booking.service_code),providerId=text(booking.provider_id),orderValue=money(booking.total_amount);
 const atDate=text(booking.scheduled_start).slice(0,10)||undefined;
 const term=await resolveCommercialTerm(db,{serviceCode,providerId,atDate});
 /* Typed so a caller can tell "this platform is not configured for this service" apart from "this
  * crashed". It was a bare Error, so authError could not classify it and every missing commercial
  * term surfaced as an opaque 500 - taking the completion, and the subscription-session write that
  * follows it, down with no way for operations to see why. Still extends Error, so existing callers
  * that catch broadly are unaffected. */
 if(!term)throw new CommercialTermConfigurationRequired(serviceCode);
 const override=await db.prepare("SELECT * FROM order_commercial_overrides WHERE booking_id=?").bind(input.bookingId).first<Row>();
 // Full-time providers are own supply in production exactly as in UAT (owner decision 7: never commission).
 const[place,capacity]=await Promise.all([db.prepare("SELECT city_id FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null),db.prepare("SELECT provider_model FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>().catch(()=>null)]);
 const fullTime=text(capacity?.provider_model).toLowerCase()==="full_time";
 const engagementModel=(fullTime?"direct_employee":text(override?.engagement_model)||text(term.engagement_model)) as EngagementModel;
 const engagementSource=fullTime?"provider_full_time" as const:text(override?.engagement_model)?"order_override" as const:"term" as const;
 const providerSharePct=engagementModel==="direct_employee"?0:override?.provider_share_pct!=null?num(override.provider_share_pct):num(term.provider_share_pct);
 const storedGstMode=(text(override?.gst_mode)||text(term.gst_mode)||"none") as GstMode;
 validate(engagementModel,providerSharePct,storedGstMode);
 const gstExempt=engagementModel==="funeral_exempt"||FUNERAL_SERVICE_CODES.has(serviceCode);
 const gst=await resolveGstPolicy(db,{cityId:text(place?.city_id),atDate});
 const split=splitServiceOrder({paidAmount:orderValue,providerSharePct,ownSupply:engagementModel==="direct_employee",gstExempt,gstPolicy:gst,standardReferencePrice:gstExempt?input.standardReferencePrice:null});
 const cashAllowed=num(term.cash_allowed)===1,gstRatePercent=gstExempt?0:gst.ratePercent;
 const breakdown:PayoutBreakdown={bookingId:input.bookingId,serviceCode,providerId,engagementModel,orderValue,providerSharePct,platformFeePct:money(1-providerSharePct),platformFee:split.platformFee,platformGstRate:gstRatePercent/100,platformGst:split.platformGst,providerGrossShare:split.providerGrossShare,providerGstMode:"none",providerGstDeducted:0,providerNetPayout:split.providerGrossShare,pawspaceGstOnOrder:split.pawspaceGstOnOrder,directInvoice:split.supplyModel==="own_supply",cashAllowed,termId:text(term.id),termSource:text(term.termSource),gstExempt,standardReferencePrice:gstExempt&&split.supplyModel==="commission"?split.standardReferencePrice||orderValue:0,payoutBasis:split.payoutBasis,supplyModel:split.supplyModel,engagementSource,gstMethod:gst.method,gstRatePercent,gstSettingId:gst.settingId,gstSettingScope:gst.scope,taxableCommission:split.taxableCommission,ownSupplyTaxableValue:split.ownSupplyTaxableValue,retiredGstMode:storedGstMode==="none"?null:storedGstMode};
 if(input.persist!==false){const now=Date.now();
  // computed_at is written once: a recompute records recomputed_at and never moves the booking's period.
  await db.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at,engagement_model,supply_model,gst_method,gst_rate,gst_setting_id,taxable_commission,own_supply_taxable_value,gst_exempt) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET provider_id=excluded.provider_id,service_code=excluded.service_code,order_value=excluded.order_value,provider_net_payout=excluded.provider_net_payout,platform_fee=excluded.platform_fee,platform_gst=excluded.platform_gst,provider_gst_deducted=0,pawspace_gst_on_order=excluded.pawspace_gst_on_order,breakdown_json=excluded.breakdown_json,term_id=excluded.term_id,computed_by=excluded.computed_by,engagement_model=excluded.engagement_model,supply_model=excluded.supply_model,gst_method=excluded.gst_method,gst_rate=excluded.gst_rate,gst_setting_id=excluded.gst_setting_id,taxable_commission=excluded.taxable_commission,own_supply_taxable_value=excluded.own_supply_taxable_value,gst_exempt=excluded.gst_exempt,recomputed_at=excluded.computed_at WHERE provider_payout_computations.finalized_at IS NULL")
   .bind(input.bookingId,providerId,serviceCode,orderValue,breakdown.providerNetPayout,breakdown.platformFee,breakdown.platformGst,breakdown.pawspaceGstOnOrder,JSON.stringify(breakdown),text(term.id),input.actorId,now,engagementModel,split.supplyModel,gst.method,gstRatePercent,gst.settingId,split.taxableCommission,split.ownSupplyTaxableValue,gstExempt?1:0).run();
 }
 return breakdown;
}

/** Whether a provider may collect CASH for a service (else GPay/online only). Groomers yes by default; trainers/others no. */
export async function cashCollectionAllowed(db:Db,input:{serviceCode:string;providerId?:string|null;atDate?:string}){
 const term=await resolveCommercialTerm(db,input);
 return{serviceCode:input.serviceCode,allowed:term?num(term.cash_allowed)===1:false,configured:Boolean(term)};
}

/** Directory of active terms + recent payout computations for the admin/finance surface. Cold-DB safe. */
export async function commercialTermsDirectory(db:Db){
 await ensureCommercialTermsTables(db);
 const[terms,payouts,fees]=await Promise.all([
  db.prepare("SELECT * FROM provider_commercial_terms ORDER BY service_code,provider_id,version DESC LIMIT 200").all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT * FROM provider_payout_computations ORDER BY computed_at DESC LIMIT 100").all<Row>().catch(()=>({results:[] as Row[]})),
  db.prepare("SELECT * FROM provider_onboarding_fee_obligations ORDER BY due_date DESC LIMIT 100").all<Row>().catch(()=>({results:[] as Row[]})),
 ]);
 return{terms:terms.results,payouts:payouts.results,fees:fees.results,truth:{modelsSupported:["commission_groomer","commission_standard","direct_employee","funeral_exempt"],gstModeDefaultForOthers:"none",retiredGstModes:["provider_gst_on_behalf","platform_retained"],commissionSplitOnPaidAmount:true,platformGstOnCommissionOnly:true,ownSupplyGstOnPaidAmount:true,gstFromOneSetting:"lib/gst-setting.ts",fullTimeProvidersAreOwnSupply:true,funeralGstExempt:true,perOrderOverridable:true,liveMoney:false,productionReady:false}};
}
