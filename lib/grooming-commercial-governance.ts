import {quoteGroomingBookingWithLiveMultiPet} from "./live-grooming-governance";
import {groomingAddOnsForSpecies,groomingAddOnsValid} from "./grooming-add-ons";
import {policyVersion,resolveGroomingPolicy} from "./grooming-policy-governance";
import type {GroomingGovernanceResult, GroomingPetType} from "./grooming-governance";

/**
 * Governed Grooming commercial quote and its acceptance link, on the same pattern as training/boarding/sitting
 * (`*_commercial_quotes` + `*_booking_quote_links`).
 *
 * The price authority is NOT this module. A quote is priced by the existing `quoteGroomingBookingWithLiveMultiPet`
 * (catalogue + live Pricing Control + city tax policy), the existing add-on catalogue, and the customer's own open coupon
 * quote; it pins the FINAL customer-agreed terms: base package amount, selected add-ons and their total, coupon discount and
 * final payable, amount due now, payment mode, declared owned pets (source id + species), catalogue version, tax breakdown
 * and the commercial policy version in force. Acceptance is the customer's authenticated canonical booking POST naming the
 * quote: the booking route re-governs the live price and this module requires every pinned term to equal the freshly
 * governed FINAL terms in exact minor units (paise). Link + consumption are statements the booking batch commits atomically
 * with the booking; the link's primary key makes concurrent acceptance of one quote fail as a whole batch.
 */
type Row=Record<string,unknown>;
export const GROOMING_QUOTE_TTL_MS=15*60_000;
/** Exact currency comparison in minor units. 1349 and 1349.49 are different amounts. */
export const toMinor=(amount:number)=>{if(!Number.isFinite(amount))throw reject("Amount is not finite",409);return Math.round(amount*100);};
export const sameMinor=(a:number,b:number)=>toMinor(a)===toMinor(b);
export type DeclaredPet={sourceId:string;species:GroomingPetType};
export type GroomingCommercialQuote={quoteId:string;customerId:string;packageCode:string;packageName:string;catalogueVersion:string;offerType:string;petCount:number;pets:DeclaredPet[];cityId:string;zoneId:string|null;scheduledStart:string;paymentMode:string;baseAmount:number;addOns:string[];addOnTotal:number;couponQuoteId:string|null;couponDiscount:number;finalPayable:number;amountDueNow:number;pricingBreakdown:GroomingGovernanceResult["pricingBreakdown"]|null;commercialPolicyVersion:string|null;priceSource:"canonical_live_grooming_governance";status:"open"|"used"|"expired";expiresAt:number;createdAt:number};

export async function ensureGroomingCommercialTables(db:D1Database){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_commercial_quotes (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,catalogue_version TEXT NOT NULL,offer_type TEXT NOT NULL,pet_count INTEGER NOT NULL,pets_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,base_amount_minor INTEGER NOT NULL,add_ons_json TEXT NOT NULL,add_on_total_minor INTEGER NOT NULL,coupon_quote_id TEXT,coupon_discount_minor INTEGER NOT NULL,final_payable_minor INTEGER NOT NULL,amount_due_now_minor INTEGER NOT NULL,pricing_breakdown_json TEXT,commercial_policy_version TEXT,price_source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT UNIQUE)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_commercial_quotes_customer ON grooming_commercial_quotes(customer_id,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_booking_quote_links (quote_id TEXT PRIMARY KEY NOT NULL CHECK(quote_id IS NOT NULL AND quote_id<>''),booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
]);}

const text=(v:unknown)=>String(v??"").trim();
function reject(message:string,status=409){return new Response(message,{status});}
const canonicalPets=(pets:DeclaredPet[])=>JSON.stringify([...pets].map(p=>({sourceId:text(p.sourceId),species:p.species})).sort((a,b)=>a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0));
const canonicalAddOns=(addOns:string[])=>JSON.stringify([...addOns].map(text).sort());
const canonicalBreakdown=(b:unknown)=>b?JSON.stringify(b):null;

export type CreateGroomingQuoteInput={customerId:string;packageCode:string;packageName?:string;pets:Array<{sourceId:string;species?:GroomingPetType}>;addOns?:string[];cityId:string;zoneId?:string|null;scheduledStart:string;paymentMode:string;couponQuoteId?:string|null;now?:number};

/** Price through the canonical authorities and pin the FINAL terms. Never computes a price, discount or fee of its own. */
export async function createGroomingQuote(db:D1Database,input:CreateGroomingQuoteInput):Promise<GroomingCommercialQuote>{
  await ensureGroomingCommercialTables(db);
  const customerId=text(input.customerId),packageCode=text(input.packageCode),cityId=text(input.cityId),zoneId=text(input.zoneId)||null,scheduledStart=text(input.scheduledStart),paymentMode=text(input.paymentMode),now=input.now??Date.now();
  if(!customerId)throw reject("Customer is required",400);
  if(!packageCode||!cityId||!scheduledStart)throw reject("Package, city and scheduled start are required",400);
  if(!Number.isFinite(Date.parse(scheduledStart)))throw reject("Scheduled start must be a valid instant",400);
  if(!["prepaid","pay_after_service","split"].includes(paymentMode))throw reject("Unsupported payment mode",400);
  if(!Array.isArray(input.pets)||input.pets.length<1)throw reject("At least one declared pet is required",400);
  // Declared pets must be the customer's own saved pets; species comes from the saved row, not the client.
  const pets:DeclaredPet[]=[];
  for(const declared of input.pets){
    const sourceId=text(declared.sourceId);if(!sourceId)throw reject("Each declared pet needs its saved source id",400);
    const saved=await db.prepare("SELECT species FROM canonical_pets WHERE customer_id=? AND (source_pet_id=? OR id=?) ORDER BY created_at ASC LIMIT 1").bind(customerId,sourceId,sourceId).first<Row>().catch(()=>null);
    if(!saved)throw reject("Declared pet is not a saved pet of this customer",409);
    const species=(["dog","cat"].includes(text(saved.species))?text(saved.species):"other") as GroomingPetType;
    if(declared.species&&declared.species!==species)throw reject("Declared pet species does not match the saved pet",409);
    pets.push({sourceId,species});
  }
  if(new Set(pets.map(p=>p.sourceId)).size!==pets.length)throw reject("A pet cannot be declared twice",409);
  // Add-ons: the existing catalogue decides eligibility and price per saved species.
  const addOns=(input.addOns??[]).map(text).filter(Boolean);
  if(new Set(addOns).size!==addOns.length)throw reject("The Grooming add-on selection is invalid",409);
  for(const pet of pets)if(!groomingAddOnsValid(addOns,pet.species))throw reject("The selected add-on is not available for the saved pet species",409);
  const catalogueAddOns=pets.length?groomingAddOnsForSpecies(pets[0].species):[];
  const addOnTotal=addOns.reduce((sum,label)=>{const item=catalogueAddOns.find(row=>row.label===label);if(!item)throw reject("The Grooming add-on selection is invalid",409);return sum+item.price;},0);
  let governed:GroomingGovernanceResult;
  try{governed=await quoteGroomingBookingWithLiveMultiPet(db,{packageCode,packageName:input.packageName,pets:pets.map(p=>({species:p.species})),paymentMode,cityId,zoneId:zoneId??undefined,scheduledStart});}
  catch(error){throw reject(error instanceof Error?error.message:"Invalid Grooming package",409);}
  const baseAmount=governed.totalAmount,gross=baseAmount+addOnTotal;
  let couponDiscount=0,finalPayable=gross;
  const couponQuoteId=text(input.couponQuoteId)||null;
  if(couponQuoteId){
    // The coupon quote must be the customer's own, open, UNEXPIRED Grooming quote priced on exactly this gross (base + add-ons).
    const coupon=await db.prepare("SELECT customer_id,service_code,status,expires_at,order_value,discount_amount,final_amount FROM coupon_quotes WHERE id=?").bind(couponQuoteId).first<Row>().catch(()=>null);
    if(!coupon)throw reject("Coupon quote not found",409);
    if(text(coupon.customer_id)!==customerId||text(coupon.service_code)!=="grooming")throw reject("Coupon quote does not belong to this Grooming quote",409);
    if(text(coupon.status)!=="open")throw reject("Coupon quote is no longer open",409);
    if(Number(coupon.expires_at)<now)throw reject("Coupon quote has expired",409);
    if(!sameMinor(Number(coupon.order_value),gross))throw reject("Coupon quote was priced on a different governed total",409);
    couponDiscount=Number(coupon.discount_amount);finalPayable=Number(coupon.final_amount);
    if(!sameMinor(gross-couponDiscount,finalPayable))throw reject("Coupon quote amounts are inconsistent",409);
  }
  const amountDueNow=paymentMode==="prepaid"?finalPayable:0;
  const policy=await resolveGroomingPolicy(db,cityId,zoneId??undefined).catch(()=>null);
  const commercialPolicyVersion=policy?policyVersion(policy):null;
  const expiresAt=now+GROOMING_QUOTE_TTL_MS,quoteId=`GQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
  await db.prepare("INSERT INTO grooming_commercial_quotes (id,customer_id,package_code,package_name,catalogue_version,offer_type,pet_count,pets_json,city_id,zone_id,scheduled_start,payment_mode,base_amount_minor,add_ons_json,add_on_total_minor,coupon_quote_id,coupon_discount_minor,final_payable_minor,amount_due_now_minor,pricing_breakdown_json,commercial_policy_version,price_source,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)")
    .bind(quoteId,customerId,governed.packageCode,governed.packageName,governed.catalogueVersion,governed.offerType,pets.length,canonicalPets(pets),cityId,zoneId,scheduledStart,paymentMode,toMinor(baseAmount),canonicalAddOns(addOns),toMinor(addOnTotal),couponQuoteId,toMinor(couponDiscount),toMinor(finalPayable),toMinor(amountDueNow),canonicalBreakdown(governed.pricingBreakdown),commercialPolicyVersion,"canonical_live_grooming_governance",expiresAt,now).run();
  return{quoteId,customerId,packageCode:governed.packageCode,packageName:governed.packageName,catalogueVersion:governed.catalogueVersion,offerType:governed.offerType,petCount:pets.length,pets,cityId,zoneId,scheduledStart,paymentMode,baseAmount,addOns,addOnTotal,couponQuoteId,couponDiscount,finalPayable,amountDueNow,pricingBreakdown:governed.pricingBreakdown??null,commercialPolicyVersion,priceSource:"canonical_live_grooming_governance",status:"open",expiresAt,createdAt:now};
}

export type GroomingQuoteAcceptanceInput={quoteId:string;customerId:string;packageCode:string;pets:Array<{sourceId:string;species?:string}>;addOns:string[];cityId:string;zoneId?:string|null;scheduledStart:string;paymentMode:string;couponQuoteId?:string|null;governed:{baseAmount:number;addOnTotal:number;couponDiscount:number;finalPayable:number;amountDueNow:number;catalogueVersion?:string;pricingBreakdown?:unknown;commercialPolicyVersion?:string|null};now?:number};

/**
 * Acceptance check inside the customer-authenticated canonical booking POST, AFTER the route has governed the final terms
 * (live base, add-ons, coupon final, payment mode). Refuses (409/403) unless the quote is the customer's own, open,
 * unexpired, unlinked, and every pinned term equals the governed final term exactly in minor units: base, add-ons and total,
 * coupon id and discount, final payable, amount due now, payment mode, declared pets (source id + species), catalogue
 * version, tax breakdown and commercial policy version. Read-only: linking/consumption are batch statements below.
 */
export async function governGroomingQuoteAcceptance(db:D1Database,input:GroomingQuoteAcceptanceInput){
  await ensureGroomingCommercialTables(db);
  const quoteId=text(input.quoteId);if(!quoteId)throw reject("A Grooming quote is required",409);
  const linked=await db.prepare("SELECT booking_id FROM grooming_booking_quote_links WHERE quote_id=?").bind(quoteId).first<Row>();
  if(linked)throw reject("Grooming quote is already linked to a booking",409);
  const quote=await db.prepare("SELECT * FROM grooming_commercial_quotes WHERE id=?").bind(quoteId).first<Row>();
  if(!quote)throw reject("A valid server Grooming quote is required",409);
  if(text(quote.customer_id)!==text(input.customerId))throw reject("Grooming quote belongs to a different customer",403);
  if(text(quote.status)!=="open")throw reject("Grooming quote is no longer open",409);
  const now=input.now??Date.now();if(Number(quote.expires_at)<=now)throw reject("Grooming quote has expired; request a fresh quote",409);
  const g=input.governed;
  if(text(quote.package_code)!==text(input.packageCode)||Number(quote.pet_count)!==input.pets.length||text(quote.city_id)!==text(input.cityId)||(text(quote.zone_id)||null)!==(text(input.zoneId)||null)||text(quote.scheduled_start)!==text(input.scheduledStart)||text(quote.payment_mode)!==text(input.paymentMode))throw reject("Booking does not match the accepted Grooming quote",409);
  const declared=canonicalPets(input.pets.map(p=>({sourceId:p.sourceId,species:(["dog","cat"].includes(text(p.species))?text(p.species):"other") as GroomingPetType})));
  if(text(quote.pets_json)!==declared)throw reject("Booking pets do not match the pets declared on the accepted Grooming quote",409);
  if(text(quote.add_ons_json)!==canonicalAddOns(input.addOns))throw reject("Booking add-ons do not match the accepted Grooming quote",409);
  if((text(quote.coupon_quote_id)||null)!==(text(input.couponQuoteId)||null))throw reject("Grooming coupon does not match the server quote",409);
  const mismatch=(pinned:unknown,governedValue:number)=>Number(pinned)!==toMinor(governedValue);
  if(mismatch(quote.base_amount_minor,g.baseAmount)||mismatch(quote.add_on_total_minor,g.addOnTotal)||mismatch(quote.coupon_discount_minor,g.couponDiscount)||mismatch(quote.final_payable_minor,g.finalPayable)||mismatch(quote.amount_due_now_minor,g.amountDueNow))throw reject(`Grooming quote terms no longer match governed catalogue ${text(quote.catalogue_version)}; request a fresh quote`,409);
  if(g.catalogueVersion!==undefined&&text(quote.catalogue_version)!==text(g.catalogueVersion))throw reject("Grooming catalogue changed since the quote; request a fresh quote",409);
  if(g.pricingBreakdown!==undefined&&(text(quote.pricing_breakdown_json)||null)!==canonicalBreakdown(g.pricingBreakdown))throw reject("Grooming pricing breakdown changed since the quote; request a fresh quote",409);
  if(g.commercialPolicyVersion!==undefined&&(text(quote.commercial_policy_version)||null)!==(text(g.commercialPolicyVersion)||null))throw reject("Grooming commercial policy changed since the quote; request a fresh quote",409);
  return{quoteId,customerId:text(quote.customer_id),finalPayable:Number(quote.final_payable_minor)/100,amountDueNow:Number(quote.amount_due_now_minor)/100,paymentMode:text(quote.payment_mode),catalogueVersion:text(quote.catalogue_version),couponQuoteId:text(quote.coupon_quote_id)||null};
}

/**
 * Consume + link as statements for the booking's own atomic batch, with eligibility enforced INSIDE the transaction:
 *  1. UPDATE consumes the quote only if it is still open, unexpired at commit time and owned by this customer.
 *  2. INSERT writes the link with quote_id taken from a subquery that matches only when step 1 consumed THIS quote for THIS
 *     booking. If step 1 changed nothing (quote expired, used, foreign, or raced), the subquery is NULL and the NOT NULL /
 *     CHECK constraint raises, so the whole batch (booking, work order, payment, link, consume) rolls back.
 * A concurrent second acceptance therefore fails at step 2; the unique (quote_id) and (booking_id) constraints still hold.
 */
export const GROOMING_QUOTE_ACCEPTANCE_GUARD="grooming_booking_quote_links";
export function groomingQuoteAcceptanceStatements(db:D1Database,quoteId:string,bookingId:string,customerId:string,now=Date.now()){return[
  db.prepare("UPDATE grooming_commercial_quotes SET status='used',used_at=?,used_booking_id=? WHERE id=? AND customer_id=? AND status='open' AND expires_at>?").bind(now,bookingId,quoteId,customerId,now),
  db.prepare("INSERT INTO grooming_booking_quote_links (quote_id,booking_id,created_at) VALUES ((SELECT id FROM grooming_commercial_quotes WHERE id=? AND status='used' AND used_booking_id=? AND used_at=?),?,?)").bind(quoteId,bookingId,now,bookingId,now),
];}
/** True when a batch error is this guard refusing a stale/non-open/raced acceptance (constraint raised on the link). */
export function isGroomingQuoteAcceptanceGuardError(error:unknown){const message=error instanceof Error?error.message:String(error??"");return /grooming_booking_quote_links|CHECK constraint failed|NOT NULL constraint failed/.test(message)&&/grooming_booking_quote_links|quote_id/.test(message);}

/**
 * Truthful replay-time reconciliation for a committed booking. With the in-transaction guard above a link can only exist
 * alongside a consumed quote, so this exists for HISTORICAL partial rows only. It never legitimizes a stale acceptance: a
 * linked-but-open quote is repaired to 'used' ONLY when the link was written before the quote's expiry; otherwise it is
 * reported as `staleLinkDetected` and left untouched for a human decision. It never un-consumes and never creates a link.
 */
export async function reconcileGroomingQuoteLink(db:D1Database,bookingId:string){
  await ensureGroomingCommercialTables(db);
  const row=await db.prepare("SELECT l.quote_id,l.created_at link_created_at,q.status,q.used_booking_id,q.expires_at FROM grooming_booking_quote_links l LEFT JOIN grooming_commercial_quotes q ON q.id=l.quote_id WHERE l.booking_id=?").bind(bookingId).first<Row>();
  if(!row)return{linked:false as const,repaired:false,staleLinkDetected:false};
  const quoteId=text(row.quote_id);
  if(row.status==null)return{linked:true as const,quoteId,repaired:false,staleLinkDetected:true,reason:"quote_row_missing"};
  const consistent=text(row.status)==="used"&&text(row.used_booking_id)===bookingId;
  if(consistent)return{linked:true as const,quoteId,repaired:false,staleLinkDetected:false};
  if(Number(row.link_created_at)>Number(row.expires_at))return{linked:true as const,quoteId,repaired:false,staleLinkDetected:true,reason:"link_written_after_quote_expiry"};
  if(text(row.status)==="used"&&text(row.used_booking_id)&&text(row.used_booking_id)!==bookingId)return{linked:true as const,quoteId,repaired:false,staleLinkDetected:true,reason:"quote_used_by_other_booking"};
  const result=await db.prepare("UPDATE grooming_commercial_quotes SET status='used',used_at=COALESCE(used_at,?),used_booking_id=? WHERE id=? AND (status='open' OR used_booking_id IS NULL) AND ?<=expires_at").bind(Date.now(),bookingId,quoteId,Number(row.link_created_at)).run();
  return{linked:true as const,quoteId,repaired:Number(result.meta.changes||0)===1,staleLinkDetected:false};
}
