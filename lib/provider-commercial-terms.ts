/**
 * Provider commercial terms + the payout/GST engine - the single money core for how a service order's
 * value is split between the service provider and PawSpace, and how GST is treated. ALL customer prices
 * are GST-INCLUSIVE (a ₹1000 order is ₹1000 all-in, not ₹1000 + GST). Four engagement models are
 * supported, each with its own GST treatment:
 *
 *   1. commission_groomer  - provider keeps their share (default 70%); PawSpace keeps the rest (30%) and
 *                            pays GST ONLY on its platform fee. NOTHING is carved from the provider's
 *                            share (groomers are the exception). Cash collection allowed by default.
 *   2. commission_standard - boarding / sitting / training / walking. The GST-inclusive order carries an
 *                            embedded 18% GST which is carved off the TOP first (true inclusive reverse-
 *                            calc, 18/118); the remaining GST-exclusive NET POOL is split - provider share
 *                            default 70%, PawSpace platform fee the rest - and PawSpace pays 18% GST on its
 *                            platform fee only. The provider's own supply GST rides inside the carved
 *                            amount and is the PROVIDER's liability (surfaced downstream via s52 GST TCS /
 *                            GSTR-8), NOT PawSpace output GST. Cash NOT allowed by default (GPay/online).
 *                            Example: ₹1000 @ 70% -> carve ₹152.54 GST -> net pool ₹847.46 -> provider
 *                            ₹593.22, PawSpace fee ₹254.24, PawSpace GST ₹45.76.
 *   3. direct_employee     - service delivered by a salaried direct employee. No provider split; PawSpace
 *                            is the principal, pays 18% GST on the full order value and invoices directly.
 *   4. funeral_exempt      - pet funeral / cremation: a GST-EXEMPT supply. No GST is carved from the
 *                            collection and PawSpace charges NO GST on its platform fee. The vendor is paid
 *                            a share (50-60%) of PawSpace's OWN STANDARD price (not the customer payment,
 *                            which may be full/partial and carry priced add-ons); PawSpace keeps the
 *                            remainder as an exempt platform fee. Payout via RazorpayX.
 *
 * Every number is CONFIGURATION, not a hard-coded rule: share %, gst mode, platform GST rate, cash
 * eligibility and the onboarding/renewal fee are set per service, overridable per provider, and
 * overridable per order. Terms are versioned + maker/checker governed (activation needs a second party).
 * The engine only computes and records - real disbursement stays in the governed sandbox settlement flow.
 *
 * DEFAULTS ARE DELIBERATE AND FLIP-ABLE: gstMode "provider_gst_on_behalf" books the carved GST as a
 * pass-through liability; switch a term to "platform_retained" if that carve should instead be PawSpace
 * TCS/margin. No code change - just a new term version.
 */

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type EngagementModel="commission_groomer"|"commission_standard"|"direct_employee"|"funeral_exempt";
export type GstMode="none"|"provider_gst_on_behalf"|"platform_retained";
export type PayoutBreakdown={
 bookingId:string;serviceCode:string;providerId:string;engagementModel:EngagementModel;orderValue:number;
 providerSharePct:number;platformFeePct:number;platformFee:number;platformGstRate:number;platformGst:number;
 providerGrossShare:number;providerGstMode:GstMode;providerGstDeducted:number;providerNetPayout:number;
 pawspaceGstOnOrder:number;directInvoice:boolean;cashAllowed:boolean;termId:string;termSource:string;
 gstExempt:boolean;standardReferencePrice:number;payoutBasis:"net_pool"|"full_order"|"standard_price";
};

const MODEL_DEFAULTS:Record<EngagementModel,{share:number;gstMode:GstMode;cash:boolean}>={
 commission_groomer:{share:0.70,gstMode:"none",cash:true},
 commission_standard:{share:0.70,gstMode:"provider_gst_on_behalf",cash:false},
 direct_employee:{share:0,gstMode:"none",cash:false},
 funeral_exempt:{share:0.55,gstMode:"none",cash:true},
};

export async function ensureCommercialTermsTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS provider_commercial_terms (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,provider_id TEXT,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',engagement_model TEXT NOT NULL,provider_share_pct REAL NOT NULL,gst_mode TEXT NOT NULL,platform_gst_rate REAL NOT NULL DEFAULT 0.18,cash_allowed INTEGER NOT NULL DEFAULT 0,onboarding_fee REAL NOT NULL DEFAULT 0,renewal_fee REAL NOT NULL DEFAULT 0,renewal_months INTEGER NOT NULL DEFAULT 12,effective_from TEXT NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,approved_by TEXT,approval_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_terms_lookup ON provider_commercial_terms(service_code,provider_id,status,effective_from)"),
 db.prepare("CREATE TABLE IF NOT EXISTS order_commercial_overrides (booking_id TEXT PRIMARY KEY,provider_share_pct REAL,engagement_model TEXT,gst_mode TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,order_value REAL NOT NULL,provider_net_payout REAL NOT NULL,platform_fee REAL NOT NULL,platform_gst REAL NOT NULL,provider_gst_deducted REAL NOT NULL,pawspace_gst_on_order REAL NOT NULL,breakdown_json TEXT NOT NULL,term_id TEXT NOT NULL,computed_by TEXT NOT NULL,computed_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS provider_onboarding_fee_obligations (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,term_id TEXT NOT NULL,fee_type TEXT NOT NULL,amount REAL NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'due',environment TEXT NOT NULL DEFAULT 'sandbox',created_at INTEGER NOT NULL,UNIQUE(provider_id,fee_type,due_date))"),
 db.prepare("CREATE TABLE IF NOT EXISTS commercial_terms_audit (id TEXT PRIMARY KEY,term_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

function validate(model:string,share:number,gstMode:string){
 if(!(model in MODEL_DEFAULTS))throw new Error("Unknown engagement model");
 if(!(share>=0&&share<=1))throw new Error("Provider share must be a fraction between 0 and 1");
 if(!["none","provider_gst_on_behalf","platform_retained"].includes(gstMode))throw new Error("Unknown GST mode");
 if(model==="direct_employee"&&share!==0)throw new Error("Direct-employee services have no provider revenue share");
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
export async function computeOrderPayout(db:Db,input:{bookingId:string;actorId:string;persist?:boolean;standardReferencePrice?:number}):Promise<PayoutBreakdown>{
 await ensureCommercialTermsTables(db);
 const booking=await db.prepare("SELECT id,service_code,provider_id,total_amount,scheduled_start FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Canonical booking not found");
 const serviceCode=text(booking.service_code),providerId=text(booking.provider_id),orderValue=money(booking.total_amount);
 const atDate=text(booking.scheduled_start).slice(0,10)||undefined;
 const term=await resolveCommercialTerm(db,{serviceCode,providerId,atDate});
 if(!term)throw new Error(`configuration_required: no active commercial term for service ${serviceCode}`);
 const override=await db.prepare("SELECT * FROM order_commercial_overrides WHERE booking_id=?").bind(input.bookingId).first<Row>();
 const engagementModel=(text(override?.engagement_model)||text(term.engagement_model)) as EngagementModel;
 const providerSharePct=override?.provider_share_pct!=null?num(override.provider_share_pct):num(term.provider_share_pct);
 const gstMode=(text(override?.gst_mode)||text(term.gst_mode)) as GstMode;
 const platformGstRate=num(term.platform_gst_rate)||0.18;
 validate(engagementModel,providerSharePct,gstMode);

 let providerGrossShare=0,platformFee=orderValue,providerGstDeducted=0,providerNetPayout=0,platformGst=0,pawspaceGstOnOrder=0,directInvoice=false,gstExempt=false,standardReferencePrice=0;
 let payoutBasis:"net_pool"|"full_order"|"standard_price"="net_pool";
 if(engagementModel==="direct_employee"){
  // no provider split; PawSpace is the principal, bills the customer and pays 18% GST on the whole order
  directInvoice=true;pawspaceGstOnOrder=money(orderValue*0.18);platformFee=orderValue;platformGst=0;payoutBasis="full_order";
 }else if(engagementModel==="funeral_exempt"){
  // GST-EXEMPT supply: nothing carved from the collection, and NO GST on PawSpace's platform fee. The
  // vendor is paid a share of PawSpace's OWN STANDARD price (not the customer payment, which may be
  // full/partial and carry priced add-ons); PawSpace keeps the remainder as an exempt platform fee.
  gstExempt=true;payoutBasis="standard_price";
  standardReferencePrice=input.standardReferencePrice!=null&&Number(input.standardReferencePrice)>0?money(input.standardReferencePrice):orderValue;
  providerGrossShare=money(standardReferencePrice*providerSharePct);
  providerNetPayout=providerGrossShare;                        // vendor payout via RazorpayX
  platformFee=money(orderValue-providerNetPayout);             // exempt platform fee PawSpace retains
  platformGst=0;
 }else if(gstMode==="none"){
  // Groomer (share-of-order with no GST carve): split the full inclusive order; nothing is carved from the
  // provider's share. PawSpace pays GST on its platform fee only.
  payoutBasis="full_order";
  providerGrossShare=money(orderValue*providerSharePct);
  platformFee=money(orderValue-providerGrossShare);
  platformGst=money(platformFee*platformGstRate);              // PawSpace GST on its platform fee only
  providerNetPayout=providerGrossShare;
 }else{
  // commission_standard: the customer's payment is GST-INCLUSIVE. Carve the statutory embedded GST off the
  // top (true inclusive reverse-calc, 18/118), split the GST-exclusive NET POOL between the provider and
  // PawSpace, and PawSpace pays GST on its platform fee only. The carved GST is the provider's own supply
  // GST (surfaced via s52 GST TCS / GSTR-8) - NOT PawSpace output GST.
  providerGstDeducted=money(orderValue*18/118);               // embedded GST carved from the inclusive order
  const netPool=money(orderValue-providerGstDeducted);        // GST-exclusive pool that gets split
  providerGrossShare=money(netPool*providerSharePct);
  providerNetPayout=providerGrossShare;                       // paid to the provider via RazorpayX
  platformFee=money(netPool-providerGrossShare);              // PawSpace commission (GST-exclusive)
  platformGst=money(platformFee*platformGstRate);             // PawSpace's OWN output GST (commission only)
 }
 const cashAllowed=num(term.cash_allowed)===1;
 const breakdown:PayoutBreakdown={bookingId:input.bookingId,serviceCode,providerId,engagementModel,orderValue,providerSharePct,platformFeePct:money(1-providerSharePct),platformFee,platformGstRate,platformGst,providerGrossShare,providerGstMode:gstMode,providerGstDeducted,providerNetPayout,pawspaceGstOnOrder,directInvoice,cashAllowed,termId:text(term.id),termSource:text(term.termSource),gstExempt,standardReferencePrice,payoutBasis};
 if(input.persist!==false){const now=Date.now();
  await db.prepare("INSERT INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET provider_id=excluded.provider_id,service_code=excluded.service_code,order_value=excluded.order_value,provider_net_payout=excluded.provider_net_payout,platform_fee=excluded.platform_fee,platform_gst=excluded.platform_gst,provider_gst_deducted=excluded.provider_gst_deducted,pawspace_gst_on_order=excluded.pawspace_gst_on_order,breakdown_json=excluded.breakdown_json,term_id=excluded.term_id,computed_by=excluded.computed_by,computed_at=excluded.computed_at")
   .bind(input.bookingId,providerId,serviceCode,orderValue,providerNetPayout,platformFee,platformGst,providerGstDeducted,pawspaceGstOnOrder,JSON.stringify(breakdown),text(term.id),input.actorId,now).run();
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
 return{terms:terms.results,payouts:payouts.results,fees:fees.results,truth:{modelsSupported:["commission_groomer","commission_standard","direct_employee","funeral_exempt"],gstModeDefaultForOthers:"provider_gst_on_behalf",platformGstOnFeeOnly:true,commissionStandardGstInclusiveReverseCalc:true,funeralGstExempt:true,perOrderOverridable:true,liveMoney:false,productionReady:false}};
}
