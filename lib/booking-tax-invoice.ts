/**
 * THE customer tax invoice for a completed booking (owner decision B, 27 Sept 2026). The seller named in the active tax policy
 * (tax_policy_versions.policy_json.seller: legalName, gstin, stateCode, state, address) issues one document per completed
 * booking, through lib/statutory-invoicing.ts: the one FY series numbering scheme, idempotent per booking (source_event_key
 * "booking-invoice:<bookingId>", so a retry returns the same invoice), refused in a closed month, dated the IST completion date.
 * The seller is never written in code: a missing or ambiguous seller, a GSTIN with no active registration, a service with no
 * valid SAC or no invoice series is configuration_required with a plain message for Finance.
 *
 * What it shows is what the customer paid (the payout record's order_value: after coupons and discounts, add-ons included),
 * split the owner's way (decision A: "PawSpace pays 18% GST on the amount it makes"):
 *   Own supply (full-time or contract provider, company vehicle): one line for the service - taxable value = the amount paid
 *     (the value the GST setting charged GST on), GST included and paid to the government by the seller.
 *   Commission booking: the provider's charges, collected on their behalf (not the seller's supply: no SAC, no GST), and the
 *     "PawSpace platform and service fee" - the only taxable line, GST included and paid by the seller.
 *   Funeral / memorial: no GST, by Finance's funeral GST treatment (lib/funeral-gst-treatment.ts): outside GST under Schedule III
 *     by default, or exempt - a bill of supply (Rule 49); beside taxable lines, an invoice-cum-bill of supply (Rule 46A).
 * Every invoice names the customer's state (proviso to Rule 46(f): services through an e-commerce operator to an unregistered
 * person) and the place of supply follows the resolver's rule for the service (lib/tax-pos-resolver.ts), recorded per line.
 *
 * When: at completion, for every vertical that completes through the payout record (issueBookingInvoiceAfterCompletion never
 * blocks or fails a completion), and from Finance's "Issue missing invoices" for completed bookings in open months. A booking
 * completed more than 30 days ago is listed, not issued (Rule 47 / s.31(2)). No IRN, e-invoice or dynamic QR (not required).
 * The printable document (renderBookingInvoiceHtml) is one A4 layout for the customer and staff.
 */
import{ConfigurationRequired,ensureGstAccountingTables}from"./gst-accounting";
import{resolveGstPolicy}from"./gst-setting";
import{funeralGstTreatmentOn,funeralGstTreatmentVersions}from"./funeral-gst-treatment";
import{governedJsonError}from"./governed-http-error";
import{pawspaceServices}from"./service-control";
import{bookingInvoiceEventKey}from"./service-output-tax";
import{PLATFORM_COMMISSION_SERVICE_CODE,SERVICE_SAC_DEFAULTS,gstStateName,isValidSac,normaliseSac,sacDescription,serviceSacDefault}from"./service-sac-defaults";
import{issueInvoiceStatutory}from"./statutory-invoicing";
import{stateCodeFromGstin}from"./tax-pos-resolver";
import{CITY_STATE_CODE}from"./tcs-governance";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const IST=330*60_000,DAY=86_400_000;
const istDate=(ms:number)=>new Date(ms+IST).toISOString().slice(0,10);
/** Rule 47 / s.31(2): a service's invoice is issued within 30 days of the supply. */
export const BOOKING_INVOICE_DAYS=30;
const SERVICE_NAMES=new Map<string,string>([...pawspaceServices.map(s=>[s.code,s.name] as [string,string]),[PLATFORM_COMMISSION_SERVICE_CODE,"PawSpace platform and service fee"],["funeral","Funeral & Memorial"],["day_care","Day care"]]);
export const bookingServiceName=(code:string)=>SERVICE_NAMES.get(code)??(code?code.replaceAll("_"," ").replace(/^\w/,c=>c.toUpperCase()):"Service");
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function columnsOf(db:Db,name:string){return await tableExists(db,name)?new Set((await db.prepare(`PRAGMA table_info(${name})`).all<Row>()).results.map(r=>text(r.name))):new Set<string>();}
function jsonOf(value:unknown):Row{let parsed:unknown=null;try{parsed=JSON.parse(text(value)||"{}");}catch{parsed=null;}return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed as Row:{};}
const asRow=(value:unknown):Row=>value&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
function jsonList(value:unknown):unknown[]{let parsed:unknown=null;try{parsed=JSON.parse(text(value)||"[]");}catch{parsed=null;}return Array.isArray(parsed)?parsed:[];}
async function audit(db:Db,actor:string,entityType:string,entityId:string,action:string,after:unknown,reason:string,before:unknown=null){await db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,entityType,entityId,action,before==null?null:JSON.stringify(before),JSON.stringify(after),actor,reason,Date.now()).run();}

/* What Finance reads when an invoice cannot be issued. */
const REFUSALS:Record<string,string>={
 active_policy_seller:"No active tax policy names the seller. Add the seller's legal name, GSTIN, state and address to the active tax policy.",
 single_active_policy_seller:"More than one active tax policy names a seller. Keep one seller's policy active.",
 policy_seller_details:"The seller in the active tax policy has no legal name, no address or no valid GSTIN.",
 policy_seller_state:"The seller's state code in the active tax policy does not match its GSTIN.",
 active_tax_registration:"The seller's GSTIN has no active GST registration.",
 active_tax_policy:"The seller has no active tax policy on the invoice date.",
 valid_supplier_gstin:"The seller's GST registration does not hold a valid GSTIN.",
 invoice_series:"No invoice number series is set up for the seller. Set one on the GST screen: a prefix with {FY} and 5 digits gives a new series every financial year.",
 customer_state:"The customer's state is not known: add a place of supply to the customer's tax profile, or book in a city with a state code.",
 valid_recipient_gstin:"The GSTIN on the customer's tax profile is not valid.",
 place_of_supply_state:"The place of supply cannot be worked out for this booking.",
};
/** The plain-English reason an invoice was refused, from a configuration_required key. */
export function bookingInvoiceRefusal(key:string){
 const[head,...rest]=key.split(":"),name=rest.length?bookingServiceName(rest.join(":")):"A service";
 if(head==="invoice_tax_total_mismatch")return`${name}: taxable value plus GST does not equal the billed amount. Finance must reconcile the configured GST basis before issuing a new invoice.`;
 if(head==="tax_classification")return`${name} has no SAC classification in the active tax policy. Set its SAC on the GST screen.`;
 if(head==="tax_classification_sac")return`${name} has no valid SAC in the active tax policy (4 or 6 digits starting 99). Set it on the GST screen.`;
 if(["tax_component_code","tax_component_rate","tax_components"].includes(head))return`${name}'s tax classification has no valid GST rate.`;
 return REFUSALS[head]??`Configuration is needed before the invoice can be issued (${key}).`;
}
const refusalKey=(error:unknown)=>error instanceof ConfigurationRequired?error.key:(()=>{const message=error instanceof Error?error.message:String(error);return message.startsWith("configuration_required:")?message.slice("configuration_required:".length):null;})();

export type InvoiceSeller={entityId:string;policyId:string;registrationId:string;legalName:string;tradeName:string;gstin:string;stateCode:string;state:string;address:string};
/** The seller in the one active tax policy that names one, on a date, with the active GST registration of its GSTIN. */
export async function resolveBookingInvoiceSeller(db:Db,onDate:string):Promise<InvoiceSeller>{
 if(!await tableExists(db,"tax_policy_versions")||!await tableExists(db,"tax_registrations"))throw new ConfigurationRequired("active_policy_seller");
 const latest=new Map<string,Row>();
 for(const p of(await db.prepare("SELECT * FROM tax_policy_versions WHERE status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY entity_id,version DESC").bind(onDate,onDate).all<Row>()).results)if(!latest.has(text(p.entity_id)))latest.set(text(p.entity_id),p);
 const named=[...latest.values()].map(policy=>({policy,seller:jsonOf(policy.policy_json).seller})).filter((entry):entry is{policy:Row;seller:Row}=>Boolean(entry.seller)&&typeof entry.seller==="object"&&!Array.isArray(entry.seller));
 if(!named.length)throw new ConfigurationRequired("active_policy_seller");
 if(named.length>1)throw new ConfigurationRequired("single_active_policy_seller");
 const{policy,seller}=named[0],gstin=text(seller.gstin).toUpperCase(),stateCode=stateCodeFromGstin(gstin);
 if(!text(seller.legalName)||!text(seller.address)||!stateCode)throw new ConfigurationRequired("policy_seller_details");
 if(text(seller.stateCode)&&text(seller.stateCode).slice(0,2)!==stateCode)throw new ConfigurationRequired("policy_seller_state");
 const registration=await db.prepare("SELECT id FROM tax_registrations WHERE entity_id=? AND status='active' AND (effective_from IS NULL OR effective_from<=?) AND (effective_to IS NULL OR effective_to>=?) AND UPPER(TRIM(registration_reference))=? ORDER BY approved_at DESC LIMIT 1").bind(text(policy.entity_id),onDate,onDate,gstin).first<Row>();
 if(!registration)throw new ConfigurationRequired("active_tax_registration");
 return{entityId:text(policy.entity_id),policyId:text(policy.id),registrationId:text(registration.id),legalName:text(seller.legalName),tradeName:text(seller.tradeName)||text(seller.legalName),gstin,stateCode,state:text(seller.state)||gstStateName(stateCode),address:text(seller.address)};
}

/* The components a seeded classification charges: the seller policy's own defaultComponents when valid, else the one GST
 * setting's rate as CGST + SGST (lib/tax-pos-resolver.ts re-heads it to IGST for a supply into another state). */
async function defaultComponents(db:Db,seller:InvoiceSeller,onDate:string){
 const configured=jsonOf((await db.prepare("SELECT policy_json FROM tax_policy_versions WHERE id=?").bind(seller.policyId).first<Row>())?.policy_json).defaultComponents;
 if(Array.isArray(configured)&&configured.length&&configured.every(c=>c&&typeof c==="object"&&text((c as Row).code)&&Number.isFinite(Number((c as Row).rate))&&Number((c as Row).rate)>=0))return(configured as Row[]).map(c=>({code:text(c.code).toUpperCase(),rate:Number(c.rate)}));
 const rate=(await resolveGstPolicy(db,{atDate:onDate})).ratePercent;return[{code:"CGST",rate:rate/2},{code:"SGST",rate:rate/2}];
}
/** Seed each missing classification of the seller's policy from the one SAC table. A row Finance set is never touched. */
async function seedDefaultClassifications(db:Db,seller:InvoiceSeller,serviceCodes:string[],onDate:string,actor:string){
 for(const code of[...new Set(serviceCodes)]){const preset=serviceSacDefault(code);if(!preset)continue;
  if(await db.prepare("SELECT id FROM tax_classifications WHERE policy_id=? AND service_code=?").bind(seller.policyId,code).first<Row>())continue;
  const components=await defaultComponents(db,seller,onDate),id=`taxclass_${crypto.randomUUID().slice(0,16)}`;
  const inserted=await db.prepare("INSERT OR IGNORE INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES (?,?,?,?,?,?,'standard',?)").bind(id,seller.policyId,code,preset.sac,JSON.stringify(components),preset.placeOfSupplyRule,Date.now()).run();
  if(Number(inserted.meta?.changes)>0)await audit(db,actor,"tax_classification",id,"seeded_default",{policyId:seller.policyId,serviceCode:code,classificationCode:preset.sac,description:preset.description,components,placeOfSupplyRule:preset.placeOfSupplyRule},"Default SAC from the one SAC table (owner decision F); Finance can change it on the GST screen");}
}
/** Refuses unless each service has a classification with a printable SAC (checked before anything is written). */
async function assertServiceSacs(db:Db,seller:InvoiceSeller,serviceCodes:string[]){
 for(const code of[...new Set(serviceCodes)]){const row=await db.prepare("SELECT classification_code FROM tax_classifications WHERE policy_id=? AND service_code=?").bind(seller.policyId,code).first<Row>();
  if(!row)throw new ConfigurationRequired(`tax_classification:${code}`);if(!isValidSac(row.classification_code))throw new ConfigurationRequired(`tax_classification_sac:${code}`);}
}
/* The invoice number series for the seller's financial year: Finance's FY row, or a series template to expand (see
 * lib/statutory-invoicing.ts). Read-only here, so the backlog can say "no series" before anything is issued. */
async function hasInvoiceSeries(db:Db,seller:InvoiceSeller,onDate:string){
 const y=Number(onDate.slice(0,4)),m=Number(onDate.slice(5,7)),start=m>=4?y:y-1,fy=`${start}-${String((start+1)%100).padStart(2,"0")}`;
 if(await tableExists(db,"finance_document_series_v2")&&await db.prepare("SELECT id FROM finance_document_series_v2 WHERE entity_id=? AND gstin=? AND document_type='invoice' AND financial_year=? AND status='active'").bind(seller.entityId,seller.gstin,fy).first<Row>())return true;
 return await tableExists(db,"finance_document_series")&&Boolean(await db.prepare("SELECT id FROM finance_document_series WHERE entity_id=? AND document_type='invoice' AND status='active'").bind(seller.entityId).first<Row>());
}

type Completed={booking:Row;payout:Row;completedAt:number;completedOn:string};
/* A booking the payout record says is completed (final) under the owner's model; anything else is not invoiced here. */
async function completedBooking(db:Db,bookingId:string):Promise<Completed|null>{
 if(!await tableExists(db,"provider_payout_computations")||!await tableExists(db,"canonical_bookings"))return null;
 const payout=await db.prepare("SELECT * FROM provider_payout_computations WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!payout||!(num(payout.finalized_at)>0)||!["commission","own_supply"].includes(text(payout.supply_model)))return null;
 const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();if(!booking)return null;
 const completedAt=num(payout.computed_at)||num(payout.finalized_at);return{booking,payout,completedAt,completedOn:istDate(completedAt)};
}
async function periodLocked(db:Db,date:string){if(!await tableExists(db,"finance_close_periods"))return false;const row=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(date.slice(0,7)).first<Row>();return text(row?.status)==="locked";}
const daysBetween=(from:string,to:string)=>Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY);

type Customer={customerId:string;name:string;phone:string;address:string;gstin:string;stateCode:string;state:string;stateSource:string};
/* The recipient: name, phone and service address from the booking, GSTIN and place of supply from the customer's tax profile.
 * The customer's state is the profile's place of supply, else the GSTIN's state, else the state of the city the booking is in. */
async function customerDetails(db:Db,booking:Row):Promise<Customer>{
 const customerId=text(booking.customer_id);let name="",phone="",address="",gstin="",profileState="";
 if(hasAll(await columnsOf(db,"canonical_customers"),["id","name","primary_phone"])){const c=await db.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();name=text(c?.name);phone=text(c?.primary_phone);}
 if(hasAll(await columnsOf(db,"booking_service_addresses"),["booking_id","address"])){const a=await db.prepare("SELECT address FROM booking_service_addresses WHERE booking_id=?").bind(text(booking.id)).first<Row>();address=text(a?.address);}
 if(!address&&hasAll(await columnsOf(db,"customer_addresses"),["customer_id","line1","city","is_default"])){const a=await db.prepare("SELECT line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC LIMIT 1").bind(customerId).first<Row>();address=[a?.line1,a?.line2,a?.area,a?.city,a?.postal_code].map(text).filter(Boolean).join(", ");}
 if(hasAll(await columnsOf(db,"finance_customer_tax_profiles"),["customer_id","registration_reference","place_of_supply"])){const p=await db.prepare("SELECT registration_reference,place_of_supply FROM finance_customer_tax_profiles WHERE customer_id=?").bind(customerId).first<Row>();gstin=text(p?.registration_reference).toUpperCase();profileState=text(p?.place_of_supply).slice(0,2);}
 const validGstin=stateCodeFromGstin(gstin)?gstin:"",city=CITY_STATE_CODE[text(booking.city_id).toLowerCase()]??"";
 const[stateCode,stateSource]=/^\d{2}$/.test(profileState)?[profileState,"customer_tax_profile"]:validGstin?[validGstin.slice(0,2),"customer_gstin"]:city?[city,"booking_city"]:["",""];
 return{customerId,name:name||`Customer ${customerId}`,phone,address,gstin:validGstin,stateCode,state:gstStateName(stateCode),stateSource};
}
function hasAll(cols:Set<string>,names:readonly string[]){return names.every(n=>cols.has(n));}

type Particulars={serviceName:string;packageName:string;pets:string[];addOns:string[];serviceDate:string;providerName:string};
async function bookingParticulars(db:Db,booking:Row,payout:Row):Promise<Particulars>{
 const petIds=jsonList(booking.pet_ids_json).map(text).filter(Boolean).slice(0,20),pets:string[]=[];
 if(petIds.length&&hasAll(await columnsOf(db,"canonical_pets"),["id","name"]))for(const petId of petIds){const pet=await db.prepare("SELECT name FROM canonical_pets WHERE id=?").bind(petId).first<Row>();if(text(pet?.name))pets.push(text(pet?.name));}
 const pricing=jsonOf(booking.pricing_json),addOns=(Array.isArray(pricing.addOns)?pricing.addOns:[]).map(text).filter(Boolean);
 let providerName=text(jsonOf(payout.breakdown_json).beneficiaryType)==="vehicle_owner"?"the vehicle owner":"";
 if(!providerName&&hasAll(await columnsOf(db,"provider_capacity_profiles"),["id","name"])){const p=await db.prepare("SELECT name FROM provider_capacity_profiles WHERE id=?").bind(text(payout.provider_id)).first<Row>();providerName=text(p?.name);}
 if(!providerName&&hasAll(await columnsOf(db,"provider_work_orders"),["booking_id","provider_name"])){const w=await db.prepare("SELECT provider_name FROM provider_work_orders WHERE booking_id=?").bind(text(booking.id)).first<Row>();providerName=text(w?.provider_name);}
 const start=Date.parse(text(booking.scheduled_start));
 return{serviceName:bookingServiceName(text(booking.service_code)),packageName:text(booking.package_name),pets,addOns,serviceDate:Number.isFinite(start)?istDate(start):"",providerName:providerName||"your provider"};
}
const longDate=(date:string)=>{const at=Date.parse(`${date}T12:00:00+05:30`);return Number.isFinite(at)?new Date(at).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"}):date;};
const serviceParticulars=(p:Particulars)=>[p.packageName&&p.packageName!==p.serviceName?`${p.serviceName}: ${p.packageName}`:p.serviceName,p.pets.length?`for ${p.pets.join(", ")}`:"",p.addOns.length?`with ${p.addOns.join(", ")}`:"",p.serviceDate?`on ${longDate(p.serviceDate)}`:""].filter(Boolean).join(" ");

export type BookingInvoiceOutcome={status:"issued"|"existing"|"invoiced_by_hand"|"not_completed"|"too_late"|"period_locked"|"refused";bookingId:string;invoiceId?:string;invoiceNumber?:string;completedOn?:string;key?:string;message?:string};
async function invoiceRowFor(db:Db,bookingId:string){return await tableExists(db,"finance_invoices")?await db.prepare("SELECT * FROM finance_invoices WHERE source_type='booking' AND source_id=?").bind(bookingId).first<Row>():null;}

/**
 * Issue (or return) the customer tax invoice of one completed booking. Never throws for a refusal: the outcome says why
 * nothing was issued (not completed, more than 30 days after completion, a closed month, or configuration Finance must add).
 */
export async function issueBookingInvoice(db:Db,input:{bookingId:string;actorId:string;reason?:string;asOf?:number}):Promise<BookingInvoiceOutcome>{
 const bookingId=text(input.bookingId),eventKey=bookingInvoiceEventKey(bookingId);
 const prior=await invoiceRowFor(db,bookingId);
 if(prior)return text(prior.source_event_key)===eventKey?{status:"existing",bookingId,invoiceId:text(prior.id),invoiceNumber:text(prior.invoice_number)}:{status:"invoiced_by_hand",bookingId,invoiceId:text(prior.id),invoiceNumber:text(prior.invoice_number),message:"Finance already issued an invoice for this booking by hand"};
 const done=await completedBooking(db,bookingId);if(!done)return{status:"not_completed",bookingId,message:"The booking has no final completion record yet"};
 const issueDate=done.completedOn,today=istDate(input.asOf??Date.now());
 if(daysBetween(issueDate,today)>BOOKING_INVOICE_DAYS)return{status:"too_late",bookingId,completedOn:issueDate,message:`Completed on ${issueDate}, more than ${BOOKING_INVOICE_DAYS} days ago: not issued (Rule 47)`};
 if(await periodLocked(db,issueDate))return{status:"period_locked",bookingId,completedOn:issueDate,message:`${issueDate.slice(0,7)} is closed: not issued`};
 let lastError:unknown=null;
 for(let attempt=0;attempt<3;attempt++){
  try{const invoice=await issue(db,done,input.actorId,text(input.reason)||"Customer tax invoice for a completed booking");return{status:"issued",bookingId,invoiceId:text(invoice?.id),invoiceNumber:text(invoice?.invoice_number),completedOn:issueDate};}
  catch(error){
   const key=refusalKey(error),message=String(error instanceof Error?error.message:error);if(key)return{status:"refused",bookingId,completedOn:issueDate,key,message:bookingInvoiceRefusal(key)};
   if(/period_locked/.test(message))return{status:"period_locked",bookingId,completedOn:issueDate,message:`${issueDate.slice(0,7)} is closed: not issued`};
   // Two bookings completing at once can race for the same serial: the loser's batch rolls back whole, so it takes the next one.
   if(!/UNIQUE|invoice_serial_cas_failed/i.test(message))throw error;
   const replay=await invoiceRowFor(db,bookingId);if(replay)return{status:"existing",bookingId,invoiceId:text(replay.id),invoiceNumber:text(replay.invoice_number)};lastError=error;
  }
 }
 // Still colliding after the retries: the series' next number is already on another invoice (for example one issued by hand
 // under that number), so taking it again cannot succeed. Refuse with the reason; the booking stays on the missing-invoices list.
 const taken=/finance_invoices\.invoice_number/i.test(String(lastError instanceof Error?lastError.message:lastError));
 return{status:"refused",bookingId,completedOn:issueDate,key:taken?"invoice_number_taken":"invoice_series_busy",message:taken?"The next number in this invoice series is already on another invoice. Finance must check the series before this invoice can be issued.":"The invoice series was busy with other invoices. Try again."};
}

async function issue(db:Db,done:Completed,actor:string,reason:string){
 await ensureGstAccountingTables(db);
 const{booking,payout,completedAt,completedOn}=done,bookingId=text(booking.id),serviceCode=text(booking.service_code)||text(payout.service_code);
 const seller=await resolveBookingInvoiceSeller(db,completedOn),customer=await customerDetails(db,booking);
 if(!customer.stateCode)throw new ConfigurationRequired("customer_state");
 const own=text(payout.supply_model)==="own_supply",exempt=num(payout.gst_exempt)===1,order=round2(num(payout.order_value)),fee=round2(num(payout.platform_fee));
 const treatment=funeralGstTreatmentOn(await funeralGstTreatmentVersions(db),completedOn).treatment,noGstRole:"exempt"|"non_gst"=treatment==="exempt"?"exempt":"non_gst";
 const feeCode=exempt?serviceCode:PLATFORM_COMMISSION_SERVICE_CODE,codes=own?[serviceCode]:[feeCode];
 // Every refusal is decided before anything is written: no series, then the SACs (a missing default is seeded, never overwritten).
 if(!await hasInvoiceSeries(db,seller,completedOn))throw new ConfigurationRequired("invoice_series");
 await seedDefaultClassifications(db,seller,codes,completedOn,actor);await assertServiceSacs(db,seller,codes);
 const particulars=await bookingParticulars(db,booking,payout),described=serviceParticulars(particulars);
 const ownValue=num(payout.own_supply_taxable_value)>0?round2(num(payout.own_supply_taxable_value)):text(payout.gst_method)==="extract_inclusive"?round2(order-num(payout.pawspace_gst_on_order)):order;
 const commissionValue=payout.taxable_commission==null?fee:round2(num(payout.taxable_commission)),collected=round2(order-fee);
 const lines:Row[]=own?[{lineKey:"service",description:described,serviceCode,lineAmount:order,...exempt?{taxability:noGstRole}:{taxableAmount:ownValue}}]
  :[...collected>0?[{lineKey:"provider-charges",taxability:"collected_on_behalf",description:`${particulars.serviceName} by ${particulars.providerName}: charges collected on the provider's behalf`,serviceCode,lineAmount:collected}]:[],
    {lineKey:"platform-fee",description:"PawSpace platform and service fee",serviceCode:feeCode,lineAmount:fee,...exempt?{taxability:noGstRole}:{taxableAmount:commissionValue}}];
 const notes=[...exempt?[treatment==="exempt"?"Exempt supply: no GST is charged.":"Funeral, burial, crematorium or mortuary services are neither a supply of goods nor a supply of services (CGST Act, Schedule III, para 4): no GST is charged."]:[`GST is included in the amount paid and is paid to the government by ${seller.tradeName}.`],
  ...!own&&collected>0?[`The provider's charges are collected on the provider's behalf and paid to the provider. They are not part of ${seller.tradeName}'s taxable value and no GST is charged on them by ${seller.tradeName}.`]:[]];
 return issueInvoiceStatutory(db,{entityId:seller.entityId,registrationId:seller.registrationId,customerId:customer.customerId,issueDate:completedOn,sourceType:"booking",sourceId:bookingId,sourceEventKey:bookingInvoiceEventKey(bookingId),
  // The customer's state is the address on record (IGST s.12(2)(b)); the service is performed in the booking's city.
  recipientState:customer.stateCode,serviceState:CITY_STATE_CODE[text(booking.city_id).toLowerCase()]??customer.stateCode,recipientRegistered:Boolean(customer.gstin),currency:text(booking.currency)||"INR",amountReceived:order,taxLedgerType:"booking_output",reason,lines,
  document:{seller:{legalName:seller.legalName,tradeName:seller.tradeName,gstin:seller.gstin,stateCode:seller.stateCode,state:seller.state,address:seller.address},
   buyer:{customerId:customer.customerId,name:customer.name,phone:customer.phone,address:customer.address,gstin:customer.gstin||null,stateCode:customer.stateCode,state:customer.state,stateSource:customer.stateSource},
   booking:{bookingId,serviceCode,serviceName:particulars.serviceName,packageName:particulars.packageName,pets:particulars.pets,addOns:particulars.addOns,serviceDate:particulars.serviceDate,completedAt,completedOn,providerName:particulars.providerName,supplyModel:text(payout.supply_model),gstMethod:text(payout.gst_method)||null,gstRatePercent:num(payout.gst_rate),funeralGstTreatment:exempt?treatment:null},
   notes,reverseCharge:false,amountInWords:rupeesInWords(order)}},actor);
}

/** One log field: the booking ID comes from the request, so it is never the format string. CR/LF are removed first, other
 * control characters are replaced (no forged log lines) and the length is capped. */
const logValue=(value:unknown)=>String(value).replace(/\r|\n/g,"").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g," ").slice(0,300);

/** Completion's hook: issue the booking's invoice, never failing or blocking the completion. A refusal is logged and stays on
 * Finance's missing-invoices list with its reason. */
export async function issueBookingInvoiceAfterCompletion(db:Db,bookingId:string,actorId:string):Promise<BookingInvoiceOutcome>{
 try{
  // A database with no tax policy at all has no seller: nothing to issue, and nothing is created for it.
  if(!await tableExists(db,"tax_policy_versions"))return{status:"refused",bookingId,key:"active_policy_seller",message:bookingInvoiceRefusal("active_policy_seller")};
  const outcome=await issueBookingInvoice(db,{bookingId,actorId,reason:"Customer tax invoice issued at completion"});
  // A re-run of an old completion (a read-model refresh) is "too late" by design and is listed for Finance, not logged.
  if(outcome.status==="refused"||outcome.status==="period_locked")console.warn("[booking-invoice] %s not issued at completion: %s",logValue(bookingId),logValue(outcome.message));
  return outcome;
 }catch(error){console.error("[booking-invoice] %s could not be issued at completion; it stays on Finance's missing-invoices list: %s",logValue(bookingId),logValue(error instanceof Error?`${error.name}: ${error.message}`:error));return{status:"refused",bookingId,key:"unexpected_error",message:error instanceof Error?error.message:String(error)};}
}

export type BacklogRow={bookingId:string;serviceCode:string;amountPaid:number;completedOn:string;daysSinceCompletion:number;status:"ready"|"too_late"|"period_locked"|"refused";key?:string;message:string};
/**
 * Completed bookings with no invoice yet, newest first: ready to issue, more than 30 days old (listed, not issued: Rule 47),
 * in a closed month, or refused for configuration (the reason Finance must fix). Read only: nothing is created or seeded.
 */
export async function bookingInvoiceBacklog(db:Db,input:{asOf?:number;limit?:number}={}){
 const asOf=input.asOf??Date.now(),today=istDate(asOf),limit=Math.min(Math.max(1,Math.floor(input.limit??200)),500),rows:BacklogRow[]=[];
 const cols=await columnsOf(db,"provider_payout_computations");if(!hasAll(cols,["booking_id","service_code","order_value","supply_model","gst_exempt","finalized_at","computed_at"]))return{asOf:today,rows,counts:{ready:0,tooLate:0,periodLocked:0,refused:0}};
 const invoiced=await tableExists(db,"finance_invoices")?" AND NOT EXISTS (SELECT 1 FROM finance_invoices i WHERE i.source_type='booking' AND i.source_id=p.booking_id)":"";
 const pending=(await db.prepare(`SELECT p.booking_id,p.service_code,p.order_value,p.supply_model,p.gst_exempt,p.computed_at,p.finalized_at FROM provider_payout_computations p WHERE p.finalized_at>0 AND p.supply_model IN ('commission','own_supply')${invoiced} ORDER BY p.computed_at DESC LIMIT ?`).bind(limit).all<Row>()).results;
 // One read per date, month and service - not per booking - so a long list stays cheap to show.
 const sellers=new Map<string,InvoiceSeller|string>(),sellerOn=async(date:string)=>{if(!sellers.has(date)){try{sellers.set(date,await resolveBookingInvoiceSeller(db,date));}catch(error){const key=refusalKey(error);if(!key)throw error;sellers.set(date,key);}}return sellers.get(date) as InvoiceSeller|string;};
 const locks=new Map<string,boolean>(),lockedOn=async(date:string)=>{const month=date.slice(0,7);if(!locks.has(month))locks.set(month,await periodLocked(db,date));return locks.get(month) as boolean;};
 const problems=new Map<string,string|null>(),problemFor=async(seller:InvoiceSeller,sacCode:string,date:string)=>{const key=`${seller.policyId}:${sacCode}:${date.slice(0,4)}${Number(date.slice(5,7))>=4?"b":"a"}`;if(!problems.has(key))problems.set(key,await backlogProblem(db,seller,sacCode,date));return problems.get(key) as string|null;};
 for(const r of pending){const completedOn=istDate(num(r.computed_at)||num(r.finalized_at)),days=daysBetween(completedOn,today),base={bookingId:text(r.booking_id),serviceCode:text(r.service_code),amountPaid:round2(num(r.order_value)),completedOn,daysSinceCompletion:days};
  if(days>BOOKING_INVOICE_DAYS){rows.push({...base,status:"too_late",message:`Completed more than ${BOOKING_INVOICE_DAYS} days ago: listed, not issued (Rule 47)`});continue;}
  if(await lockedOn(completedOn)){rows.push({...base,status:"period_locked",message:`${completedOn.slice(0,7)} is closed: not issued`});continue;}
  const seller=await sellerOn(completedOn);if(typeof seller==="string"){rows.push({...base,status:"refused",key:seller,message:bookingInvoiceRefusal(seller)});continue;}
  const problem=await problemFor(seller,text(r.supply_model)==="own_supply"||num(r.gst_exempt)===1?base.serviceCode:PLATFORM_COMMISSION_SERVICE_CODE,completedOn);rows.push(problem?{...base,status:"refused",key:problem,message:bookingInvoiceRefusal(problem)}:{...base,status:"ready",message:"Ready to issue"});}
 return{asOf:today,rows,counts:{ready:rows.filter(r=>r.status==="ready").length,tooLate:rows.filter(r=>r.status==="too_late").length,periodLocked:rows.filter(r=>r.status==="period_locked").length,refused:rows.filter(r=>r.status==="refused").length}};
}
/* The configuration a booking's invoice would need, checked read-only: a SAC for its service (or a default to seed) and a series. */
async function backlogProblem(db:Db,seller:InvoiceSeller,sacCode:string,onDate:string){
 const row=await db.prepare("SELECT classification_code FROM tax_classifications WHERE policy_id=? AND service_code=?").bind(seller.policyId,sacCode).first<Row>();
 if(row&&!isValidSac(row.classification_code))return`tax_classification_sac:${sacCode}`;if(!row&&!serviceSacDefault(sacCode))return`tax_classification:${sacCode}`;
 return await hasInvoiceSeries(db,seller,onDate)?null:"invoice_series";
}

/** Finance's "Issue missing invoices" (finance.manage, checked by the route): issues every ready booking of the backlog in open
 * months, lists the rest with the reason, and audits the run. Re-running issues nothing twice. */
export async function issueMissingBookingInvoices(db:Db,input:{actorId:string;reason:string;asOf?:number;limit?:number}){
 const reason=text(input.reason);if(reason.length<8)throw governedJsonError({error:"A clear reason of at least 8 characters is required"},400);
 await ensureGstAccountingTables(db);
 const backlog=await bookingInvoiceBacklog(db,{asOf:input.asOf,limit:input.limit}),outcomes:BookingInvoiceOutcome[]=[];
 for(const row of backlog.rows)if(row.status==="ready"){
  // One booking's failure never stops the run or its audit row: it is listed as not issued, and the error is logged, not returned.
  try{outcomes.push(await issueBookingInvoice(db,{bookingId:row.bookingId,actorId:input.actorId,reason,asOf:input.asOf}));}
  catch(error){console.error("[booking-invoice] %s could not be issued by Finance's run: %s",logValue(row.bookingId),logValue(error instanceof Error?`${error.name}: ${error.message}`:error));outcomes.push({status:"refused",bookingId:row.bookingId,completedOn:row.completedOn,key:"unexpected_error",message:"Could not be issued because of an unexpected error. Try again; if it repeats, report it."});}
 }
 const issued=outcomes.filter(o=>o.status==="issued"),notIssued=[...backlog.rows.filter(r=>r.status!=="ready").map(r=>({bookingId:r.bookingId,status:r.status,message:r.message})),...outcomes.filter(o=>o.status!=="issued"&&o.status!=="existing").map(o=>({bookingId:o.bookingId,status:o.status,message:o.message??""}))];
 await audit(db,input.actorId,"booking_invoice_backfill",`backfill:${backlog.asOf}`,"issued_missing",{asOf:backlog.asOf,issued:issued.map(o=>({bookingId:o.bookingId,invoiceNumber:o.invoiceNumber})),notIssued:notIssued.slice(0,200)},reason);
 return{asOf:backlog.asOf,issued,notIssued,counts:{issued:issued.length,notIssued:notIssued.length}};
}

/** Finance changes the SAC of one service in the active seller policy (finance.manage, checked by the route); audited. Invoices
 * already issued keep the SAC printed on them; the next invoice uses the new one. */
export async function updateServiceSac(db:Db,input:{serviceCode:string;sac:string;reason:string},actor:string){
 const serviceCode=text(input.serviceCode),sac=normaliseSac(input.sac),reason=text(input.reason);
 if(!/^[a-z0-9_]{2,40}$/.test(serviceCode))throw governedJsonError({error:"Choose a service"},400);
 if(!isValidSac(sac))throw governedJsonError({error:"A SAC is 4 or 6 digits starting with 99, for example 998612"},400);
 if(reason.length<8)throw governedJsonError({error:"A clear reason of at least 8 characters is required"},400);
 await ensureGstAccountingTables(db);
 const onDate=istDate(Date.now()),seller=await resolveBookingInvoiceSeller(db,onDate),before=await db.prepare("SELECT * FROM tax_classifications WHERE policy_id=? AND service_code=?").bind(seller.policyId,serviceCode).first<Row>();
 if(before){if(normaliseSac(before.classification_code)===sac)return{serviceCode,sac,policyId:seller.policyId,unchanged:true};await db.prepare("UPDATE tax_classifications SET classification_code=? WHERE id=?").bind(sac,text(before.id)).run();await audit(db,actor,"tax_classification",text(before.id),"sac_changed",{policyId:seller.policyId,serviceCode,classificationCode:sac},reason,{classificationCode:text(before.classification_code)});return{serviceCode,sac,policyId:seller.policyId,unchanged:false};}
 const preset=serviceSacDefault(serviceCode),components=await defaultComponents(db,seller,onDate),id=`taxclass_${crypto.randomUUID().slice(0,16)}`;
 await db.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES (?,?,?,?,?,?,'standard',?)").bind(id,seller.policyId,serviceCode,sac,JSON.stringify(components),preset?.placeOfSupplyRule??"default_recipient_or_service",Date.now()).run();
 await audit(db,actor,"tax_classification",id,"sac_set",{policyId:seller.policyId,serviceCode,classificationCode:sac,components},reason);
 return{serviceCode,sac,policyId:seller.policyId,unchanged:false};
}
/** The SAC of every service in the active seller policy beside the default, for the GST screen. Read only. */
export async function serviceSacTable(db:Db){
 const onDate=istDate(Date.now());let seller:InvoiceSeller|null=null,refusal:string|null=null;
 try{seller=await resolveBookingInvoiceSeller(db,onDate);}catch(error){const key=refusalKey(error);if(!key)throw error;refusal=bookingInvoiceRefusal(key);}
 const set=new Map<string,Row>();if(seller)for(const r of(await db.prepare("SELECT service_code,classification_code FROM tax_classifications WHERE policy_id=?").bind(seller.policyId).all<Row>()).results)set.set(text(r.service_code),r);
 const rows=Object.entries(SERVICE_SAC_DEFAULTS).map(([serviceCode,preset])=>{const current=set.get(serviceCode),sac=current?normaliseSac(current.classification_code):preset.sac;return{serviceCode,label:bookingServiceName(serviceCode),sac,description:sacDescription(sac)||preset.description,source:current?"finance":"default",valid:isValidSac(sac),defaultSac:preset.sac,note:preset.note};});
 return{seller:seller?{legalName:seller.legalName,gstin:seller.gstin,state:seller.state,stateCode:seller.stateCode,address:seller.address,policyId:seller.policyId}:null,refusal,rows};
}

export type BookingInvoiceDocumentLine={lineKey:string;role:"taxable"|"exempt"|"non_gst"|"collected_on_behalf";description:string;sac:string;sacDescription:string;amount:number;taxableValue:number;ratePercent:number;cgst:number;sgst:number;igst:number;tax:number;value:number};
export type BookingInvoiceDocument={invoiceId:string;invoiceNumber:string;issueDate:string;title:string;documentKind:string;customerId:string;bookingId:string;seller:Row;buyer:Row;booking:Row;placeOfSupply:{code:string;name:string;rule:string};supplyType:"intra"|"inter";lines:BookingInvoiceDocumentLine[];taxableValue:number;cgst:number;sgst:number;igst:number;totalTax:number;exemptValue:number;nonGstValue:number;collectedOnBehalf:number;amountReceived:number;amountInWords:string;notes:string[]};
const TITLES:Record<string,string>={tax_invoice:"Tax invoice",bill_of_supply:"Bill of supply",invoice_cum_bill_of_supply:"Invoice-cum-bill of supply"};
/** The booking's customer tax invoice as the printable document reads it (null when none was issued by this flow). Read only. */
export async function bookingInvoiceDocument(db:Db,bookingId:string):Promise<BookingInvoiceDocument|null>{
 if(!await tableExists(db,"finance_invoices"))return null;
 const row=await db.prepare("SELECT * FROM finance_invoices WHERE source_type='booking' AND source_id=? AND source_event_key=? AND status!='cancelled'").bind(bookingId,bookingInvoiceEventKey(bookingId)).first<Row>();if(!row)return null;
 const snap=jsonOf(row.tax_snapshot_json),document=asRow(snap.document),kind=text(row.document_kind)||text(snap.document_kind)||"tax_invoice",stored=Array.isArray(snap.lines)?snap.lines as Row[]:[];
 const lines=stored.map((line):BookingInvoiceDocumentLine=>{const components=Array.isArray(line.components)?line.components as Row[]:[],part=(code:string)=>round2(components.filter(c=>text(c.code).toLowerCase().includes(code)).reduce((s,c)=>s+num(c.amount),0)),role=["exempt","non_gst","collected_on_behalf"].includes(text(line.role))?text(line.role) as BookingInvoiceDocumentLine["role"]:"taxable",sac=role==="collected_on_behalf"?"":normaliseSac(line.classificationCode);
  return{lineKey:text(line.lineKey),role,description:text(line.description),sac,sacDescription:sac?sacDescription(sac):"",amount:round2(num(line.lineAmount)),taxableValue:round2(num(line.taxableAmount)),ratePercent:round2(components.reduce((s,c)=>s+num(c.rate),0)),cgst:part("cgst"),sgst:part("sgst"),igst:part("igst"),tax:round2(num(line.taxAmount)),value:round2(num(line.exemptValue))};});
 const sum=(pick:(l:BookingInvoiceDocumentLine)=>number)=>round2(lines.reduce((s,l)=>s+pick(l),0)),pos=text(snap.pos_state),posRule=text(stored.find(l=>text(l.role)!=="collected_on_behalf")?.pos_rule);
 const amountReceived=round2(num(row.amount_received??row.total));
 return{invoiceId:text(row.id),invoiceNumber:text(row.invoice_number),issueDate:text(row.issue_date),title:TITLES[kind]??"Tax invoice",documentKind:kind,customerId:text(row.customer_id),bookingId,seller:asRow(document.seller),buyer:asRow(document.buyer),booking:asRow(document.booking),
  placeOfSupply:{code:pos,name:gstStateName(pos),rule:posRule},supplyType:text(snap.supply_type)==="inter"?"inter":"intra",lines,taxableValue:sum(l=>l.taxableValue),cgst:sum(l=>l.cgst),sgst:sum(l=>l.sgst),igst:sum(l=>l.igst),totalTax:sum(l=>l.tax),exemptValue:sum(l=>l.role==="exempt"?l.value:0),nonGstValue:sum(l=>l.role==="non_gst"?l.value:0),collectedOnBehalf:sum(l=>l.role==="collected_on_behalf"?l.amount:0),
  amountReceived,amountInWords:text(document.amountInWords)||rupeesInWords(amountReceived),notes:Array.isArray(document.notes)?(document.notes as unknown[]).map(text).filter(Boolean):[]};
}

/* Indian-system amount in words: "Rupees One Thousand Only", "Rupees One Lakh Twenty Thousand and Fifty Paise Only". */
const ONES=["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"],TENS=["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const underHundred=(n:number)=>n<20?ONES[n]:`${TENS[Math.floor(n/10)]}${n%10?` ${ONES[n%10]}`:""}`;
const underThousand=(n:number)=>[n>=100?`${ONES[Math.floor(n/100)]} Hundred`:"",n%100?underHundred(n%100):""].filter(Boolean).join(" ");
function wholeWords(n:number):string{if(n===0)return"Zero";const crore=Math.floor(n/10_000_000),lakh=Math.floor(n%10_000_000/100_000),thousand=Math.floor(n%100_000/1000),rest=n%1000;return[crore?`${wholeWords(crore)} Crore`:"",lakh?`${underHundred(lakh)} Lakh`:"",thousand?`${underHundred(thousand)} Thousand`:"",rest?underThousand(rest):""].filter(Boolean).join(" ");}
export function rupeesInWords(amount:number){const paise=Math.round(Math.abs(num(amount))*100),rupees=Math.floor(paise/100),cents=paise%100;return`Rupees ${wholeWords(rupees)}${cents?` and ${underHundred(cents)} Paise`:""} Only`;}

const escapeHtml=(value:unknown)=>text(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] as string));
const rupees=(value:number)=>`₹${num(value).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const stateLabel=(name:unknown,code:unknown)=>text(code)?`${escapeHtml(name)||"State"} (${escapeHtml(code)})`:"Not recorded";
/** The printable A4 document (browser "Save as PDF"): one layout for the customer and staff. Every value is escaped. */
export function renderBookingInvoiceHtml(doc:BookingInvoiceDocument,options:{nonce?:string}={}){
 const s=doc.seller,b=doc.buyer,k=doc.booking,intra=doc.supplyType==="intra",half=(rate:number)=>round2(rate/2);
 const lineRows=doc.lines.map((l,i)=>{const taxable=l.role==="taxable",sub=l.role==="collected_on_behalf"?"Collected on the provider's behalf: not part of the taxable value, no GST charged":l.role==="non_gst"?"Outside GST (Schedule III): no GST charged":l.role==="exempt"?"Exempt: no GST charged":"";
  return`<tr><td>${i+1}</td><td>${escapeHtml(l.description)}${sub?`<div class="sub">${escapeHtml(sub)}</div>`:""}</td><td>${l.sac?`${escapeHtml(l.sac)}${l.sacDescription?`<div class="sub">${escapeHtml(l.sacDescription)}</div>`:""}`:"—"}</td><td class="n">${rupees(l.amount)}</td><td class="n">${taxable?rupees(l.taxableValue):l.role==="collected_on_behalf"?"—":rupees(l.value)}</td>${intra?`<td class="n">${taxable?`${half(l.ratePercent)}%<div class="sub">${rupees(l.cgst)}</div>`:"—"}</td><td class="n">${taxable?`${half(l.ratePercent)}%<div class="sub">${rupees(l.sgst)}</div>`:"—"}</td>`:`<td class="n">${taxable?`${l.ratePercent}%<div class="sub">${rupees(l.igst)}</div>`:"—"}</td>`}</tr>`;}).join("");
 const rate=doc.lines.find(l=>l.role==="taxable")?.ratePercent??0;
 const taxed=doc.lines.some(l=>l.role==="taxable"),summary=[...taxed?[`<tr><th>Taxable value</th><td class="n">${rupees(doc.taxableValue)}</td></tr>`,...intra?[`<tr><th>CGST @ ${half(rate)}%</th><td class="n">${rupees(doc.cgst)}</td></tr>`,`<tr><th>SGST @ ${half(rate)}%</th><td class="n">${rupees(doc.sgst)}</td></tr>`]:[`<tr><th>IGST @ ${rate}%</th><td class="n">${rupees(doc.igst)}</td></tr>`],`<tr><th>Total GST (included in the amount paid)</th><td class="n">${rupees(doc.totalTax)}</td></tr>`]:[],...doc.exemptValue>0?[`<tr><th>Exempt value</th><td class="n">${rupees(doc.exemptValue)}</td></tr>`]:[],...doc.nonGstValue>0?[`<tr><th>Value outside GST (Schedule III)</th><td class="n">${rupees(doc.nonGstValue)}</td></tr>`]:[],...doc.collectedOnBehalf>0?[`<tr><th>Collected on the provider's behalf</th><td class="n">${rupees(doc.collectedOnBehalf)}</td></tr>`]:[],`<tr class="total"><th>Amount received</th><td class="n">${rupees(doc.amountReceived)}</td></tr>`].join("");
 const nonce=options.nonce?` nonce="${escapeHtml(options.nonce)}"`:"";
 return`<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(doc.title)} ${escapeHtml(doc.invoiceNumber)}</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;background:#f3f3f3}.sheet{max-width:210mm;margin:12px auto;background:#fff;padding:14mm;border:1px solid #ddd}
h1{font-size:20px;margin:0 0 2px}.muted,.sub{color:#555;font-size:11px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.box{border:1px solid #ccc;padding:8px;font-size:12px;line-height:1.45}.box h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin:0 0 4px;color:#333}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:5px 6px;vertical-align:top;text-align:left}td.n,th.n{text-align:right;white-space:nowrap}.summary{width:55%;margin-left:auto;margin-top:8px}.summary th{font-weight:normal}.summary .total th,.summary .total td{font-weight:bold}
.notes{font-size:11px;margin:10px 0}.sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:28px;font-size:12px}.actions{max-width:210mm;margin:12px auto 0;text-align:right}button{padding:8px 14px;font-size:14px}@media print{body{background:#fff}.sheet{border:0;margin:0;padding:0}.actions{display:none}}
</style></head><body><div class="actions"><button type="button" id="print">Print or save as PDF</button></div><main class="sheet">
<header><h1>${escapeHtml(doc.title)}</h1><div class="muted">Original for recipient</div></header>
<section class="grid"><div class="box"><h2>Seller</h2><b>${escapeHtml(s.legalName)}</b><br>${escapeHtml(s.address)}<br>GSTIN: ${escapeHtml(s.gstin)}<br>State: ${stateLabel(s.state,s.stateCode)}</div>
<div class="box"><h2>${escapeHtml(doc.title)} details</h2>Number: <b>${escapeHtml(doc.invoiceNumber)}</b><br>Date: ${escapeHtml(longDate(doc.issueDate))}<br>Place of supply: ${stateLabel(doc.placeOfSupply.name,doc.placeOfSupply.code)}<br>Tax payable on reverse charge: No<br>Booking: ${escapeHtml(doc.bookingId)}</div></section>
<section class="grid"><div class="box"><h2>Customer</h2><b>${escapeHtml(b.name)}</b>${text(b.address)?`<br>${escapeHtml(b.address)}`:""}${text(b.phone)?`<br>Phone: ${escapeHtml(b.phone)}`:""}${text(b.gstin)?`<br>GSTIN: ${escapeHtml(b.gstin)}`:""}<br>Customer state: ${stateLabel(b.state,b.stateCode)}</div>
<div class="box"><h2>Service</h2>${escapeHtml(k.serviceName)}${text(k.packageName)?`: ${escapeHtml(k.packageName)}`:""}${Array.isArray(k.pets)&&k.pets.length?`<br>Pets: ${escapeHtml((k.pets as unknown[]).map(text).join(", "))}`:""}${Array.isArray(k.addOns)&&k.addOns.length?`<br>Add-ons: ${escapeHtml((k.addOns as unknown[]).map(text).join(", "))}`:""}${text(k.serviceDate)?`<br>Service date: ${escapeHtml(longDate(text(k.serviceDate)))}`:""}${text(b.address)?`<br>Service address: ${escapeHtml(b.address)}`:""}</div></section>
<table><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="n">Amount</th><th class="n">Taxable value</th>${intra?`<th class="n">CGST</th><th class="n">SGST</th>`:`<th class="n">IGST</th>`}</tr></thead><tbody>${lineRows}</tbody></table>
<table class="summary"><tbody>${summary}</tbody></table>
<p class="notes"><b>Amount received in words:</b> ${escapeHtml(doc.amountInWords)}</p>
<div class="notes">${doc.notes.map(n=>`<p>${escapeHtml(n)}</p>`).join("")}<p>Tax payable on reverse charge: No.</p></div>
<div class="sign"><span class="muted">This is a computer-generated ${escapeHtml(doc.title.toLowerCase())}.</span><span>For ${escapeHtml(s.legalName)}<br><br>Authorised signatory</span></div>
</main><script${nonce}>document.getElementById("print").addEventListener("click",function(){window.print();});</script></body></html>`;
}
