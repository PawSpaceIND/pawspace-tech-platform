/**
 * Input tax credit: the purchase register, GSTR-2B matching and the monthly ITC computation (owner decision E, 27 Sept 2026:
 * "we take GST credit on the value we pay to the vendor like Google AdWords", within Indian GST law).
 *
 * Purchase register. A vendor bill (finance_bills, written by app/api/finance-control) now carries the supplier's GSTIN and
 * state, the supplier's invoice number and date, the place of supply, the SAC/HSN, the tax by head (CGST, SGST, IGST, cess),
 * whether PawSpace pays the tax under reverse charge, the expense category (lib/chart-of-accounts.ts codes) and the ITC
 * treatment: eligible, blocked under section 17(5) (with the clause), common credit under Rule 42, no GST, or not eligible for
 * another reason. The tax heads must suit the place of supply (same state: CGST + SGST; another state: IGST). A bill written
 * before this change has only an aggregate gst_amount: it "needs a component split" and is never credited until Finance splits
 * it. The default treatment of each expense category is one data table, EXPENSE_ITC_DEFAULTS, so it can be adjusted.
 *
 * GSTR-2B (section 16(2)(aa)). Finance uploads the GSTR-2B JSON from the GST portal. Its b2b invoices are matched to bills on
 * supplier GSTIN + invoice number (upper case, letters and digits only, so "INV-001" matches "inv001") + invoice date, with
 * the taxable value and every tax head within Rs 1. Only a matched bill, or one Finance confirms by hand with a reason (audited),
 * can be credited. The portal's own totals are never trusted: every figure is recomputed from the invoices.
 *
 * Monthly ITC computation (entity + GST registration + IST month), GSTR-3B Table 4:
 *  4(A)(2) import of services and 4(A)(3) other reverse charge: the tax PawSpace pays in cash on a reverse-charge purchase is
 *    credited in the same month (the purchase's time of supply, section 13(3)).
 *  4(A)(5) all other ITC: bills in GSTR-2B (or confirmed) whose credit has not been taken yet, plus Rule 37 re-claims. Blocked
 *    (17(5)) and otherwise ineligible bills that appear in GSTR-2B are shown here and reversed in full in 4(B)(1), as GSTR-3B
 *    expects (CBIC circular 170/02/2022); they are never credited.
 *  4(B)(1) Rule 42: D1 = C2 x E / F, C2 = common credit of the month, E = exempt turnover (funeral), F = total turnover, both
 *    from the service supply register. The annual true-up (rule42AnnualTrueUp) posts the year's difference in a later month.
 *  4(B)(2) Rule 37: a credited bill not paid to the supplier within 180 days is reversed, and re-claimed when it is paid.
 *  4(D)(2): credit that can never be taken (section 16(4) time limit, place of supply in another state).
 * A computation is saved as a numbered version; saving marks which bills it took, so a bill is credited once, a late bill rolls
 * into the next month saved, and a month is never changed once a later month is saved or its tax is paid.
 *
 * Journals. Approving a bill (app/api/finance-control) posts Dr expense (net of creditable GST; blocked GST stays in the
 * expense), Dr input tax by head (1180-1183, or 1185 until the bill is in GSTR-2B), Cr accounts payable; reverse charge also
 * credits 2135. A later classification or GSTR-2B match posts only the difference (syncBillLedger), once. Saving a month moves
 * the Rule 42 and Rule 37 reversals from input tax to expense (and back when re-claimed). Every journal balances, every action
 * is audited, and nothing is posted into a locked month. Import-safe for `node --experimental-strip-types`.
 */
import{ACCT,round as round2}from"./finance-accounts";
import{expenseChartOfAccounts,findExpenseCategory}from"./chart-of-accounts";
import{governedJsonError}from"./governed-http-error";
import{ConfigurationRequired}from"./gst-accounting";
import{ensureFinanceEntityScope}from"./finance-filing-closeout";
import{canonicalInvoicesOnlySql,serviceVerticalOutputTax}from"./service-output-tax";
import{chunkedIn}from"./d1-chunked-in";
import{resolveFuneralGstTreatment}from"./funeral-gst-treatment";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const IST=330*60_000,DAY=86_400_000;
export const istToday=(at=Date.now())=>new Date(at+IST).toISOString().slice(0,10);
export const isIsoDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export const isPeriod=(v:string)=>/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
export const addDays=(date:string,days:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+days*DAY).toISOString().slice(0,10);
export const lastDayOf=(period:string)=>{const[y,m]=period.split("-").map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
export const nextPeriod=(period:string)=>{const[y,m]=period.split("-").map(Number);return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,"0")}`;};
const periodWindow=(from:string,to:string)=>{const[y1,m1]=from.split("-").map(Number),[y2,m2]=to.split("-").map(Number);return{startMs:Date.UTC(y1,m1-1,1)-IST,endMs:Date.UTC(m2===12?y2+1:y2,m2===12?0:m2,1)-IST};};
const idOf=(prefix:string)=>`${prefix}_${crypto.randomUUID().slice(0,16)}`;
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");}
const refuse=(error:string,status=409)=>governedJsonError({error},status);

// ---------------------------------------------------------------------------------------------------------------------
// Tax heads
// ---------------------------------------------------------------------------------------------------------------------
export type Heads={igst:number;cgst:number;sgst:number;cess:number};
export const HEADS=["igst","cgst","sgst","cess"] as const;
export const zeroHeads=():Heads=>({igst:0,cgst:0,sgst:0,cess:0});
export const addHeads=(a:Heads,b:Heads):Heads=>({igst:round2(a.igst+b.igst),cgst:round2(a.cgst+b.cgst),sgst:round2(a.sgst+b.sgst),cess:round2(a.cess+b.cess)});
export const subHeads=(a:Heads,b:Heads):Heads=>({igst:round2(a.igst-b.igst),cgst:round2(a.cgst-b.cgst),sgst:round2(a.sgst-b.sgst),cess:round2(a.cess-b.cess)});
export const scaleHeads=(a:Heads,factor:number):Heads=>({igst:round2(a.igst*factor),cgst:round2(a.cgst*factor),sgst:round2(a.sgst*factor),cess:round2(a.cess*factor)});
export const headsTotal=(a:Heads)=>round2(a.igst+a.cgst+a.sgst+a.cess);
export const portalHeads=(a:Heads)=>({iamt:a.igst,camt:a.cgst,samt:a.sgst,csamt:a.cess});
const readHeads=(value:unknown):Heads=>{const v=(value&&typeof value==="object"?value:{}) as Row;return{igst:round2(num(v.igst)),cgst:round2(num(v.cgst)),sgst:round2(num(v.sgst)),cess:round2(num(v.cess))};};
export const INPUT_TAX_ACCOUNTS:Record<keyof Heads,string>={igst:ACCT.INPUT_IGST,cgst:ACCT.INPUT_CGST,sgst:ACCT.INPUT_SGST,cess:ACCT.INPUT_CESS};
export const ACCOUNTS_PAYABLE="2200-Accounts payable";
export const DEFAULT_BILL_EXPENSE_ACCOUNT="6300-Vendor expense";
/** "Ineligible ITC As Per Rule 42" in the MIS chart: where the Rule 42 reversal is expensed. */
export const RULE42_EXPENSE_ACCOUNT=findExpenseCategory("EXP-TAX-ITC")?.accountCode??"6130-Rates and Taxes (2)";
export function billExpenseAccount(categoryCode:unknown){const entry=text(categoryCode)?findExpenseCategory(text(categoryCode)):undefined;return entry?entry.accountCode:DEFAULT_BILL_EXPENSE_ACCOUNT;}

// ---------------------------------------------------------------------------------------------------------------------
// GSTIN and states
// ---------------------------------------------------------------------------------------------------------------------
/** GST state codes (first two characters of a GSTIN; a place of supply). 96 = a supplier outside India (import of services). */
export const GST_STATES:Record<string,string>={"01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur","15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","26":"Dadra and Nagar Haveli and Daman and Diu","27":"Maharashtra","29":"Karnataka","30":"Goa","31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu","34":"Puducherry","35":"Andaman and Nicobar Islands","36":"Telangana","37":"Andhra Pradesh","38":"Ladakh","97":"Other Territory"};
export const OVERSEAS_STATE="96";
const GSTIN_CHARS="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The GSTIN check character (mod-36 weighted sum of the first 14 characters). */
export function gstinCheckCharacter(first14:string){let factor=1,sum=0;for(const ch of first14){const product=factor*GSTIN_CHARS.indexOf(ch);factor=factor===2?1:2;sum+=Math.floor(product/36)+product%36;}return GSTIN_CHARS[(36-sum%36)%36];}
export function validateGstin(value:unknown):{ok:true;gstin:string;stateCode:string}|{ok:false;error:string}{
 const gstin=text(value).toUpperCase().replace(/\s+/g,"");
 if(!/^\d{2}[A-Z0-9]{10}[1-9A-Z][A-Z][0-9A-Z]$/.test(gstin))return{ok:false,error:`${gstin||"The GSTIN"} is not a GSTIN: it must be 15 characters, a two-digit state code, the PAN, the entity number, a letter and a check character`};
 if(!GST_STATES[gstin.slice(0,2)])return{ok:false,error:`GSTIN ${gstin} starts with ${gstin.slice(0,2)}, which is not a GST state code`};
 const check=gstinCheckCharacter(gstin.slice(0,14));
 if(check!==gstin[14])return{ok:false,error:`GSTIN ${gstin} fails the GSTIN check character (it should end in ${check}); check it against the supplier's invoice`};
 return{ok:true,gstin,stateCode:gstin.slice(0,2)};
}
/** Supplier invoice numbers compared the way GSTR-2B matching does: upper case, letters and digits only. */
export const normaliseInvoiceNumber=(value:unknown)=>text(value).toUpperCase().replace(/[^A-Z0-9]/g,"");

// ---------------------------------------------------------------------------------------------------------------------
// ITC treatments and the expense taxonomy (owner's MIS sheet)
// ---------------------------------------------------------------------------------------------------------------------
export const ITC_TREATMENTS=["eligible","blocked_17_5","common_rule_42","no_gst","ineligible_other"] as const;
export type ItcTreatment=typeof ITC_TREATMENTS[number];
export const ITC_TREATMENT_LABELS:Record<ItcTreatment,string>={eligible:"Eligible: credit taken",blocked_17_5:"Blocked under section 17(5): never credited, the GST is part of the expense",common_rule_42:"Common credit: used for taxable and exempt supplies (Rule 42 share reversed)",no_gst:"No GST on this expense",ineligible_other:"Not eligible (other reason): the GST is part of the expense"};
const CREDITABLE=new Set<string>(["eligible","common_rule_42"]);
const REPORTED_NOT_CREDITED=new Set<string>(["blocked_17_5","ineligible_other"]);
export const SUPPLIER_TYPES=["registered","unregistered","overseas"] as const;
export const GSTR2B_STATUSES=["not_in_2b","matched","manual_confirmed"] as const;
/** When a purchase in the category is under reverse charge: never, when the supplier is unregistered, when the service is
 * imported (a supplier outside India), or always (legal services by an advocate). */
export type ReverseChargeRule="no"|"if_unregistered"|"if_imported"|"always";
/** sharedOverhead: the category serves every service, the exempt funeral service included, so its credit is common credit under
 * Rule 42 whenever PawSpace has exempt turnover (see rule42.sharedOverheadWarning). */
export type ItcDefault={treatment:ItcTreatment;clause?:string;reason?:string;reverseCharge:ReverseChargeRule;sharedOverhead?:boolean;note:string};
/**
 * THE default ITC treatment of every expense category (lib/chart-of-accounts.ts codes, from the owner's MIS sheet), per the legal
 * research of 27 Sept 2026 (round3/gst-law.md section 4). Finance can set a different treatment or reverse-charge flag on a bill,
 * with a reason; this is what the bill form starts with. Keep this the one place it is decided.
 */
export const EXPENSE_ITC_DEFAULTS:Record<string,ItcDefault>={
 "EXP-COMM-FUNERAL":{treatment:"ineligible_other",reason:"Used only for the funeral / memorial service, which is not a taxable supply (Schedule III by default, or exempt)",reverseCharge:"no",note:"Credit on a purchase used only for a supply that is not taxable is not available (Rule 42 T2 when funeral is exempt). Funeral follows the funeral GST treatment setting (Schedule III by default); if the CA sets it to taxable at 18%, choose Eligible with a reason."},
 "EXP-CP-FOOD":{treatment:"no_gst",reverseCharge:"no",note:"A provider payout is not a purchase: credit only if the provider is GST-registered and invoices PawSpace for a service PawSpace consumes."},
 "EXP-CP-GROOMING":{treatment:"no_gst",reverseCharge:"no",note:"A provider payout is not a purchase: credit only if the provider is GST-registered and invoices PawSpace for a service PawSpace consumes."},
 "EXP-CP-TRAINER":{treatment:"no_gst",reverseCharge:"no",note:"A provider payout is not a purchase: credit only if the provider is GST-registered and invoices PawSpace for a service PawSpace consumes."},
 "EXP-CP-BADDEBT":{treatment:"no_gst",reverseCharge:"no",note:"A bad debt written off is not a purchase."},
 "EXP-B2B-HOTEL":{treatment:"eligible",reverseCharge:"no",note:"Hotel stay for a taxable B2B service. A hotel outside Karnataka charges its own state's tax, which the Karnataka registration cannot credit."},
 "EXP-B2B-INCENTIVE":{treatment:"no_gst",reverseCharge:"no",note:"Incentives paid to people are not a supply."},
 "EXP-B2B-GROOMING-OTHER":{treatment:"eligible",reverseCharge:"no",note:"Used for a taxable B2B grooming service."},
 "EXP-B2B-PETEVENT":{treatment:"eligible",reverseCharge:"no",note:"Used for a taxable B2B pet event."},
 "EXP-B2B-TRAVEL":{treatment:"eligible",reverseCharge:"no",note:"Business travel. Hired cabs and food are blocked under 17(5)(b)(i): book those bills as blocked."},
 "EXP-EC-SALARY":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply (Schedule III para 1)."},
 "EXP-EC-BOARDING":{treatment:"eligible",reverseCharge:"no",note:"Used for taxable boarding."},
 "EXP-EC-RENT":{treatment:"eligible",reverseCharge:"if_unregistered",note:"Credit when the landlord is GST-registered. Commercial rent from an unregistered landlord is under reverse charge from 10 Oct 2024 (13/2017 Sl.5AB): self-invoice within 30 days (Rule 47A), pay in cash, credit in 4(A)(3). A residential dwelling rented to PawSpace is under reverse charge from 18 Jul 2022 (Sl.5AA); staff housing may be blocked under 17(5)(g)."},
 "EXP-EC-ELECTRICITY":{treatment:"no_gst",reverseCharge:"no",note:"Electricity is nil-rated (HSN 2716)."},
 "EXP-FIN-BANK":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Banks may issue one consolidated monthly invoice (Rule 54(2)); PawSpace's GSTIN must be registered with the bank so it reaches GSTR-2B."},
 "EXP-FIN-LOAN":{treatment:"no_gst",reverseCharge:"no",note:"Loan interest is exempt."},
 "EXP-FIN-CARLOAN":{treatment:"no_gst",reverseCharge:"no",note:"Loan interest is exempt."},
 "EXP-FIN-OTHERLOAN":{treatment:"no_gst",reverseCharge:"no",note:"Loan interest is exempt."},
 "EXP-FIN-PROCESSING":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"A bank's loan processing fee carries GST."},
 "EXP-FOOD-EMPLOYEE":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply."},
 "EXP-FOOD-PETROL":{treatment:"no_gst",reverseCharge:"no",note:"Petrol and diesel are outside GST (section 9(2))."},
 "EXP-FOOD-COST":{treatment:"eligible",reverseCharge:"no",note:"Pet food for resale or used in taxable boarding is an element of a taxable supply (proviso to 17(5)(b)(i))."},
 "EXP-GROOM-PRODUCTS":{treatment:"eligible",reverseCharge:"no",note:"Used in 18% grooming."},
 "EXP-GROOM-SALARY":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply."},
 "EXP-GROOM-LEADCOMM":{treatment:"eligible",reverseCharge:"no",note:"Credit only when the lead partner is GST-registered and charges GST; otherwise choose No GST."},
 "EXP-GROOM-GENERAL":{treatment:"eligible",reverseCharge:"no",note:"Credit when there is a GST invoice."},
 "EXP-GROOM-HELPER":{treatment:"no_gst",reverseCharge:"no",note:"Wages are not a supply."},
 "EXP-MKT-FACEBOOK":{treatment:"eligible",reverseCharge:"if_imported",sharedOverhead:true,note:"Facebook India charges GST in INR: PawSpace's GSTIN must be on the ad account. Billed from abroad it is an import of services: IGST under reverse charge (section 5(3) IGST Act), paid in cash, credit in 4(A)(2)."},
 "EXP-MKT-GOOGLE":{treatment:"eligible",reverseCharge:"if_imported",sharedOverhead:true,note:"Google India Pvt Ltd (Haryana) charges IGST to a Karnataka bill-to: PawSpace's GSTIN must be on the ad account. Billed from abroad it is an import of services: IGST under reverse charge, credit in 4(A)(2)."},
 "EXP-MKT-GENERAL":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Marketing with a GST invoice."},
 "EXP-OFF-ELECTRICITY":{treatment:"no_gst",reverseCharge:"no",note:"Electricity is nil-rated (HSN 2716)."},
 "EXP-OFF-INTERNET":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Office overhead with a GST invoice."},
 "EXP-OFF-MAID":{treatment:"no_gst",reverseCharge:"no",note:"Wages are not a supply."},
 "EXP-OFF-CONVEYANCE":{treatment:"no_gst",reverseCharge:"no",note:"An allowance paid to staff is not a purchase."},
 "EXP-OFF-GENERAL":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Office overhead with a GST invoice."},
 "EXP-OFF-RENT":{treatment:"eligible",reverseCharge:"if_unregistered",sharedOverhead:true,note:"Credit when the landlord is GST-registered. Commercial rent from an unregistered landlord is under reverse charge from 10 Oct 2024 (Sl.5AB): self-invoice within 30 days (Rule 47A), credit in 4(A)(3). A residential dwelling rented to PawSpace is under reverse charge from 18 Jul 2022 (Sl.5AA)."},
 "EXP-OFF-PRINTING":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Printing and stationery with a GST invoice."},
 "EXP-OFF-REPAIR":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Eligible, except motor-vehicle repairs (17(5)(ab)) and works capitalised into immovable property (17(5)(c)/(d)): book those as blocked."},
 "EXP-OFF-TELEPHONE":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Telephone with a GST invoice."},
 "EXP-OTHER-ACADEMY":{treatment:"eligible",reverseCharge:"no",note:"Used for taxable training."},
 "EXP-OTHER-COMPENSATION":{treatment:"no_gst",reverseCharge:"no",note:"Compensation paid is not a purchase."},
 "EXP-OTHER-BOARDING":{treatment:"eligible",reverseCharge:"no",note:"Used for taxable boarding."},
 "EXP-OTHER-INHOUSE-EMP":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply."},
 "EXP-OTHER-INHOUSE-LEGAL":{treatment:"eligible",reverseCharge:"always",sharedOverhead:true,note:"Legal services by an advocate or a firm of advocates: PawSpace pays the GST under reverse charge (13/2017 Sl.2), in cash; credit in 4(A)(3)."},
 "EXP-PROF-MANPOWER":{treatment:"eligible",reverseCharge:"no",note:"Manpower agency with a GST invoice."},
 "EXP-PROF-CHARGES":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"CA and consultants with a GST invoice."},
 "EXP-TAX-INCOMETAX":{treatment:"no_gst",reverseCharge:"no",note:"A tax, not a supply."},
 "EXP-TAX-ITC":{treatment:"no_gst",reverseCharge:"no",note:"Where the monthly ITC computation posts the Rule 42 reversal; not a purchase."},
 "EXP-TAX-GSTLATE":{treatment:"no_gst",reverseCharge:"no",note:"Interest and late fee are not supplies; the GST payment posts them here."},
 "EXP-TAX-PROFTAX-INT":{treatment:"no_gst",reverseCharge:"no",note:"Statutory interest is not a supply."},
 "EXP-TAX-TDS-INT":{treatment:"no_gst",reverseCharge:"no",note:"Statutory interest is not a supply."},
 "EXP-TAX-MCA":{treatment:"no_gst",reverseCharge:"no",note:"Government filing fees carry no GST."},
 "EXP-TAX-PROFTAX":{treatment:"no_gst",reverseCharge:"no",note:"A tax, not a supply."},
 "EXP-TAX-PF":{treatment:"no_gst",reverseCharge:"no",note:"A statutory contribution, not a supply."},
 "EXP-TAX-ROUNDOFF":{treatment:"no_gst",reverseCharge:"no",note:"Rounding, not a supply."},
 "EXP-RENT-COWORKING":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Co-working space with a GST invoice."},
 "EXP-SAL-SALARIES":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply (Schedule III para 1)."},
 "EXP-SAL-HEALTH":{treatment:"blocked_17_5",clause:"17(5)(b)(i) health insurance",reverseCharge:"no",note:"Blocked unless a law obliges the employer to provide it (Circular 172/04/2022)."},
 "EXP-SAL-WELFARE":{treatment:"blocked_17_5",clause:"17(5)(g) personal consumption",reverseCharge:"no",note:"Staff food, gifts and personal consumption are blocked (17(5)(b)(i), (g), (h)). Cash staff welfare is not a supply: choose No GST."},
 "EXP-SAL-INCENTIVE":{treatment:"no_gst",reverseCharge:"no",note:"Incentives paid to staff are not a supply."},
 "EXP-SUB-EXOTEL":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Forward charge; the invoice must be in GSTR-2B (Rule 36(4))."},
 "EXP-SUB-GMAIL":{treatment:"eligible",reverseCharge:"if_imported",sharedOverhead:true,note:"Google Workspace is billed by Google Cloud India with 18% GST; reverse charge (IGST) only if billed from abroad."},
 "EXP-SUB-GENERAL":{treatment:"eligible",reverseCharge:"if_imported",sharedOverhead:true,note:"Forward charge with a GST invoice; a subscription billed from abroad is an import (IGST under reverse charge, 4(A)(2))."},
 "EXP-SUB-RAZORPAY":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"Razorpay fees are forward charge; the invoice must be in GSTR-2B."},
 "EXP-TAXI-EMPLOYEES":{treatment:"no_gst",reverseCharge:"no",note:"Salary is not a supply."},
 "EXP-TAXI-INSURANCE":{treatment:"blocked_17_5",clause:"17(5)(ab) motor vehicle insurance",reverseCharge:"no",note:"Pet taxi cars (up to 13 seats) are blocked under 17(5)(a): the exceptions are passenger transport, further supply and driving training, and carrying pets is none of them; their insurance is blocked under (ab)."},
 "EXP-TAXI-GENERAL":{treatment:"no_gst",reverseCharge:"no",note:"Fuel is outside GST (section 9(2)); hired cabs are blocked (17(5)(b)(i)). A GST invoice for anything else can be booked with a reason."},
 "EXP-TAXI-MAINTENANCE":{treatment:"blocked_17_5",clause:"17(5)(ab) motor vehicle repair and maintenance",reverseCharge:"no",note:"Servicing and repairs of pet taxi cars are blocked under 17(5)(ab)."},
 "EXP-EVENT":{treatment:"eligible",reverseCharge:"no",note:"Used for taxable events."},
 "EXP-IT":{treatment:"eligible",reverseCharge:"no",sharedOverhead:true,note:"IT maintenance with a GST invoice."},
 "EXP-SOFTWARE":{treatment:"eligible",reverseCharge:"if_imported",sharedOverhead:true,note:"Indian software with a GST invoice; software billed from abroad is an import (IGST under reverse charge, 4(A)(2))."},
};
/** Whether the category expects this purchase to be under reverse charge. */
export function expectedReverseCharge(rule:ReverseChargeRule,supplierType:string){return rule==="always"||(rule==="if_unregistered"&&supplierType==="unregistered")||(rule==="if_imported"&&supplierType==="overseas");}
/** The taxonomy the bill form shows: category -> sub-categories, each with its default treatment. */
export function expenseItcTaxonomy(){return expenseChartOfAccounts.map(entry=>({code:entry.code,category:entry.category,subCategory:entry.subCategory,accountCode:entry.accountCode,...(EXPENSE_ITC_DEFAULTS[entry.code]??{treatment:"eligible" as ItcTreatment,reverseCharge:"no" as ReverseChargeRule,note:"No default recorded; check the invoice."})}));}

// ---------------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------------
/* Additive and nullable (or defaulted), so every bill written before the purchase register keeps working. */
const BILL_COLUMNS:Array<[string,string]>=[
 ["supplier_gstin","TEXT"],["supplier_state_code","TEXT"],["supplier_type","TEXT"],["supplier_invoice_number","TEXT"],["supplier_invoice_date","TEXT"],
 ["place_of_supply","TEXT"],["sac_code","TEXT"],["cgst_amount","REAL"],["sgst_amount","REAL"],["igst_amount","REAL"],["cess_amount","REAL"],
 ["reverse_charge","INTEGER NOT NULL DEFAULT 0"],["itc_treatment","TEXT"],["itc_clause","TEXT"],["itc_reason","TEXT"],["recipient_registration_id","TEXT"],
 ["gstr2b_status","TEXT NOT NULL DEFAULT 'not_in_2b'"],["gstr2b_period","TEXT"],["gstr2b_line_id","TEXT"],["gstr2b_note","TEXT"],["gstr2b_confirmed_by","TEXT"],["gstr2b_confirmed_at","INTEGER"],
 ["paid_to_supplier_on","TEXT"],["itc_registration_id","TEXT"],["itc_claimed_period","TEXT"],["rcm_reported_period","TEXT"],["rule37_reversed_period","TEXT"],["rule37_reclaimed_period","TEXT"],
 ["itc_override_reason","TEXT"],["rule37a_flagged_on","TEXT"],["rule37a_note","TEXT"],["rule37a_cleared_on","TEXT"],["rule37a_reversed_period","TEXT"],["rule37a_reclaimed_period","TEXT"],
 ["category_code","TEXT"],["created_by","TEXT"],
];
const inputTaxReady=new WeakSet<Db>();
export async function ensureInputTaxTables(db:Db){
 if(inputTaxReady.has(db))return;
 await ensureFinanceEntityScope(db);
 await db.batch([
  // Same declarations as app/api/finance-control/route.ts (tests/schema-declaration-consistency.test.mjs).
  db.prepare("CREATE TABLE IF NOT EXISTS finance_vendors (id text PRIMARY KEY NOT NULL,name text NOT NULL,gstin text,pan text,payment_terms_days integer DEFAULT 30 NOT NULL,bank_reference text,tds_section text,status text DEFAULT 'active' NOT NULL,created_at integer NOT NULL,updated_at integer NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_journal_posting_claims (source_type text NOT NULL,source_id text NOT NULL,claim_token text NOT NULL,created_at integer NOT NULL,PRIMARY KEY(source_type,source_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_gstr2b_imports (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,gstin TEXT NOT NULL,return_period TEXT NOT NULL,generated_on TEXT,checksum TEXT NOT NULL,invoice_count INTEGER NOT NULL,matched_count INTEGER NOT NULL,result_json TEXT NOT NULL,reason TEXT NOT NULL,imported_by TEXT NOT NULL,imported_at INTEGER NOT NULL,UNIQUE(registration_id,return_period,checksum))"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_gstr2b_lines (id TEXT PRIMARY KEY,import_id TEXT NOT NULL,supplier_gstin TEXT NOT NULL,supplier_name TEXT,invoice_number TEXT NOT NULL,invoice_key TEXT NOT NULL,invoice_date TEXT NOT NULL,invoice_type TEXT,place_of_supply TEXT,reverse_charge INTEGER NOT NULL DEFAULT 0,itc_available TEXT,itc_reason TEXT,invoice_value REAL NOT NULL,taxable_value REAL NOT NULL,igst REAL NOT NULL,cgst REAL NOT NULL,sgst REAL NOT NULL,cess REAL NOT NULL,supplier_period TEXT,match_status TEXT NOT NULL,matched_bill_id TEXT,match_note TEXT)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_gstr2b_lines_import ON finance_gstr2b_lines(import_id)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_itc_computations (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,period_code TEXT NOT NULL,version INTEGER NOT NULL,figures_json TEXT NOT NULL,checksum TEXT NOT NULL,journal_group TEXT,reason TEXT NOT NULL,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,UNIQUE(entity_id,registration_id,period_code,version))"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_itc_rule42_trueups (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,financial_year TEXT NOT NULL,apply_period TEXT NOT NULL,figures_json TEXT NOT NULL,journal_group TEXT,reason TEXT NOT NULL,prepared_by TEXT NOT NULL,prepared_at INTEGER NOT NULL,UNIQUE(entity_id,registration_id,financial_year))"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_gst_setoff_payments (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,period_code TEXT NOT NULL,challan_reference TEXT NOT NULL,paid_on TEXT NOT NULL,computation_id TEXT NOT NULL,gstr3b_id TEXT NOT NULL,itc_used_json TEXT NOT NULL,cash_json TEXT NOT NULL,interest_json TEXT NOT NULL,settlement_json TEXT NOT NULL,total_cash REAL NOT NULL,journal_group TEXT NOT NULL,reason TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(entity_id,registration_id,challan_reference))"),
 ]);
 const present=new Set((await db.prepare("PRAGMA table_info(finance_bills)").all<Row>()).results.map(r=>text(r.name)));
 for(const[column,definition]of BILL_COLUMNS){
  if(present.has(column))continue;
  await db.prepare(`ALTER TABLE finance_bills ADD COLUMN ${column} ${definition}`).run().catch(async(error:unknown)=>{const again=new Set((await db.prepare("PRAGMA table_info(finance_bills)").all<Row>()).results.map(r=>text(r.name)));if(!again.has(column))throw error;});
 }
 inputTaxReady.add(db);
}

async function audit(db:Db,actor:string,entityType:string,entityId:string,action:string,after:unknown,reason:string,before:unknown=null){
 return db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(idOf("ga_audit"),entityType,entityId,action,before===null?null:JSON.stringify(before),JSON.stringify(after),actor,reason,Date.now());
}
export async function periodLocked(db:Db,period:string){const row=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(period).first<Row>();return text(row?.status)==="locked";}
export async function activeRegistration(db:Db,scope:{entityId:string;registrationId:string},onDate:string){
 const row=await db.prepare("SELECT * FROM tax_registrations WHERE entity_id=? AND id=? AND status='active' AND (effective_from IS NULL OR effective_from<=?) AND (effective_to IS NULL OR effective_to>=?) ORDER BY approved_at DESC LIMIT 1").bind(scope.entityId,scope.registrationId,onDate,onDate).first<Row>();
 if(!row)throw new ConfigurationRequired("active_tax_registration");
 const gstin=text(row.registration_reference).toUpperCase();
 return{row,gstin,homeState:gstin.slice(0,2)};
}

// ---------------------------------------------------------------------------------------------------------------------
// Purchase register: validating a bill's GST details
// ---------------------------------------------------------------------------------------------------------------------
const TAX_INPUT_FIELDS=["supplierGstin","supplierType","supplierStateCode","supplierInvoiceNumber","supplierInvoiceDate","placeOfSupply","sacCode","cgstAmount","sgstAmount","igstAmount","cessAmount","reverseCharge","itcTreatment","itcClause","itcReason","itcOverrideReason","recipientRegistrationId"] as const;
/** True when a request carries any purchase-register field; a request without them keeps the bill's old behaviour. */
export const hasBillTaxInput=(body:Row)=>TAX_INPUT_FIELDS.some(key=>body[key]!==undefined&&body[key]!==null&&body[key]!=="");
const flag=(v:unknown)=>v===true||v===1||["true","1","yes","on"].includes(text(v).toLowerCase());
export type BillTaxContext={vendorGstin:string|null;billNumber:string;billDate:string;taxable:number;total:number;categoryCode:string|null;homeState:string|null;today?:string};
export type BillTaxColumns={supplier_gstin:string|null;supplier_state_code:string;supplier_type:string;supplier_invoice_number:string;supplier_invoice_date:string;place_of_supply:string;sac_code:string|null;cgst_amount:number;sgst_amount:number;igst_amount:number;cess_amount:number;reverse_charge:number;itc_treatment:ItcTreatment;itc_clause:string|null;itc_reason:string|null;itc_override_reason:string|null;recipient_registration_id:string|null;gst_amount:number};
/** Validates and normalises a bill's GST details. Returns the columns to write, or the plain-English reason it cannot be saved. */
export function billTaxColumns(body:Row,ctx:BillTaxContext):{columns:BillTaxColumns}|{error:string}{
 const today=ctx.today??istToday();
 const bodyGstin=text(body.supplierGstin),type=text(body.supplierType)||(bodyGstin||ctx.vendorGstin?"registered":"unregistered");
 if(!(SUPPLIER_TYPES as readonly string[]).includes(type))return{error:"Supplier type must be registered, unregistered or overseas"};
 let gstin:string|null=null,supplierState="";
 if(type==="registered"){const checked=validateGstin(bodyGstin||ctx.vendorGstin);if(!checked.ok)return{error:checked.error};gstin=checked.gstin;supplierState=checked.stateCode;if(text(body.supplierStateCode)&&text(body.supplierStateCode)!==supplierState)return{error:`The supplier state must be the GSTIN's state (${supplierState})`};}
 else if(type==="unregistered"){if(bodyGstin)return{error:"An unregistered supplier has no GSTIN; choose registered to enter one"};supplierState=text(body.supplierStateCode);if(!GST_STATES[supplierState])return{error:"Choose the state the unregistered supplier is in"};}
 else{if(bodyGstin)return{error:"A supplier outside India has no Indian GSTIN; choose registered if it has one"};supplierState=OVERSEAS_STATE;}
 const pos=text(body.placeOfSupply)||text(ctx.homeState);
 if(!GST_STATES[pos])return{error:"Choose the place of supply (the state code on the invoice)"};
 const invoiceNumber=text(body.supplierInvoiceNumber)||text(ctx.billNumber),invoiceDate=text(body.supplierInvoiceDate)||text(ctx.billDate);
 if(!invoiceNumber)return{error:"The supplier's invoice number is required"};
 if(!isIsoDate(invoiceDate)||invoiceDate>today)return{error:"The supplier's invoice date must be a real date, not in the future"};
 const sac=text(body.sacCode).replace(/\s+/g,"");
 if(sac&&!/^\d{4}(\d{2}){0,2}$/.test(sac))return{error:"SAC / HSN must be 4, 6 or 8 digits"};
 const amounts:Record<string,number>={};
 for(const key of["cgstAmount","sgstAmount","igstAmount","cessAmount"]){const raw=body[key],value=raw===undefined||raw===null||raw===""?0:Number(raw);if(!Number.isFinite(value)||value<0)return{error:"CGST, SGST, IGST and cess must be amounts of zero or more"};amounts[key]=round2(value);}
 const tax:Heads={igst:amounts.igstAmount,cgst:amounts.cgstAmount,sgst:amounts.sgstAmount,cess:amounts.cessAmount},gst=headsTotal(tax),rcm=flag(body.reverseCharge),intra=supplierState===pos;
 if(intra&&tax.igst>0)return{error:`The supplier (${GST_STATES[supplierState]??supplierState}) and the place of supply are in the same state, so the tax is CGST + SGST, not IGST`};
 if(!intra&&(tax.cgst>0||tax.sgst>0))return{error:`The supplier (${GST_STATES[supplierState]??"outside India"}) and the place of supply (${GST_STATES[pos]}) are in different states, so the tax is IGST, not CGST + SGST`};
 if(Math.abs(tax.cgst-tax.sgst)>1)return{error:"CGST and SGST are charged at the same rate, so they must be equal (within Rs 1)"};
 if(type==="overseas"&&gst>0&&!rcm)return{error:"A service bought from outside India is an import: PawSpace pays IGST under reverse charge, so tick reverse charge"};
 if(type==="unregistered"&&gst>0&&!rcm)return{error:"An unregistered supplier cannot charge GST; enter the bill without GST, or tick reverse charge if PawSpace must pay it"};
 const bodyGst=body.gstAmount;if(bodyGst!==undefined&&bodyGst!==null&&bodyGst!==""&&Math.abs(Number(bodyGst)-gst)>0.01)return{error:"The GST amount must equal CGST + SGST + IGST + cess"};
 const fallback=ctx.categoryCode?EXPENSE_ITC_DEFAULTS[ctx.categoryCode]?.treatment:undefined;
 const treatment=(text(body.itcTreatment)||fallback||(gst===0?"no_gst":"")) as ItcTreatment;
 if(!(ITC_TREATMENTS as readonly string[]).includes(treatment))return{error:"Choose the ITC treatment: eligible, blocked under 17(5), common (Rule 42), no GST or not eligible"};
 const clause=text(body.itcClause)||(treatment==="blocked_17_5"&&fallback===treatment?text(EXPENSE_ITC_DEFAULTS[ctx.categoryCode??""]?.clause):""),reason=text(body.itcReason);
 if(treatment==="no_gst"&&(gst>0||rcm))return{error:"A bill with GST (or reverse charge) cannot be marked No GST"};
 if(treatment!=="no_gst"&&gst===0)return{error:"This bill has no GST; choose No GST"};
 if(treatment==="blocked_17_5"&&!/^17\(5\)\([a-z]{1,2}\)/i.test(clause))return{error:"Name the section 17(5) clause, for example \"17(5)(a) motor vehicle\""};
 if(treatment==="ineligible_other"&&reason.length<5)return{error:"Say why the credit is not eligible"};
 if(CREDITABLE.has(treatment)&&ctx.homeState&&pos!==ctx.homeState)return{error:`The place of supply is ${GST_STATES[pos]}, so this tax belongs to that state and PawSpace's ${GST_STATES[ctx.homeState]??ctx.homeState} registration cannot credit it; mark it not eligible`};
 // The category's default treatment and reverse-charge rule are what the law expects; departing from them needs a reason.
 const defaults=ctx.categoryCode?EXPENSE_ITC_DEFAULTS[ctx.categoryCode]:undefined,overrideReason=text(body.itcOverrideReason),departures:string[]=[];
 if(defaults&&treatment!==defaults.treatment)departures.push(`the ITC treatment (${ITC_TREATMENT_LABELS[defaults.treatment]} for this category)`);
 if(defaults&&rcm!==expectedReverseCharge(defaults.reverseCharge,type))departures.push(`reverse charge (${expectedReverseCharge(defaults.reverseCharge,type)?"expected":"not expected"} for this category and supplier)`);
 if(departures.length&&overrideReason.length<5)return{error:`This bill departs from the category default in ${departures.join(" and ")}; give the reason`};
 const taxable=round2(ctx.taxable),total=round2(ctx.total);
 if(!rcm&&Math.abs(total-(taxable+gst))>1)return{error:`The bill total (${total}) must be the taxable value (${taxable}) plus the GST (${gst})`};
 if(rcm&&Math.abs(total-taxable)>1)return{error:`Under reverse charge the supplier does not charge GST: the bill total (${total}) must equal the taxable value (${taxable}); the GST is paid by PawSpace`};
 return{columns:{supplier_gstin:gstin,supplier_state_code:supplierState,supplier_type:type,supplier_invoice_number:invoiceNumber,supplier_invoice_date:invoiceDate,place_of_supply:pos,sac_code:sac||null,cgst_amount:tax.cgst,sgst_amount:tax.sgst,igst_amount:tax.igst,cess_amount:tax.cess,reverse_charge:rcm?1:0,itc_treatment:treatment,itc_clause:treatment==="blocked_17_5"?clause:null,itc_reason:treatment==="ineligible_other"?reason:null,itc_override_reason:departures.length?overrideReason:null,recipient_registration_id:text(body.recipientRegistrationId)||null,gst_amount:gst}};
}
/** The one active registration's state for an entity (for place-of-supply checks), or null when there is none or several. */
export async function entityHomeState(db:Db,entityId:string,registrationId?:string|null){
 await ensureInputTaxTables(db);
 const rows=(await db.prepare("SELECT id,registration_reference FROM tax_registrations WHERE entity_id=? AND status='active'").bind(entityId).all<Row>()).results;
 const chosen=registrationId?rows.filter(r=>text(r.id)===registrationId):rows;
 return chosen.length===1?text(chosen[0].registration_reference).slice(0,2)||null:null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bill journals
// ---------------------------------------------------------------------------------------------------------------------
export type PostingLine={account:string;debit:number;credit:number};
export const billHasSplit=(bill:Row)=>["igst_amount","cgst_amount","sgst_amount","cess_amount"].some(key=>bill[key]!==null&&bill[key]!==undefined);
export const billTax=(bill:Row):Heads=>({igst:round2(num(bill.igst_amount)),cgst:round2(num(bill.cgst_amount)),sgst:round2(num(bill.sgst_amount)),cess:round2(num(bill.cess_amount))});
export const billNeedsSplit=(bill:Row)=>!billHasSplit(bill)&&num(bill.gst_amount)>0;
const inTwoB=(bill:Row)=>["matched","manual_confirmed"].includes(text(bill.gstr2b_status));
/**
 * What a bill should hold in the books: Dr expense (the bill total less creditable GST; blocked or ineligible GST stays in the
 * expense), Dr input tax by head (1185 until the invoice is in GSTR-2B, except reverse charge, which is credited in the month
 * PawSpace pays it), Cr accounts payable; reverse charge also credits the tax PawSpace owes (2135). A bill with no split tax
 * posts exactly the old pair: Dr expense total, Cr accounts payable total.
 */
export function billPostingLines(bill:Row,expenseAccount=billExpenseAccount(bill.category_code)):PostingLine[]{
 const total=round2(num(bill.total_amount)),split=billHasSplit(bill),tax=split?billTax(bill):zeroHeads(),rcm=num(bill.reverse_charge)===1&&split;
 const creditable=split&&CREDITABLE.has(text(bill.itc_treatment))?tax:zeroHeads(),credit=headsTotal(creditable),taxTotal=headsTotal(tax);
 const lines:PostingLine[]=[];
 if(rcm){
  lines.push({account:expenseAccount,debit:round2(total+taxTotal-credit),credit:0});
  for(const head of HEADS)lines.push({account:INPUT_TAX_ACCOUNTS[head],debit:creditable[head],credit:0});
  lines.push({account:ACCOUNTS_PAYABLE,debit:0,credit:total},{account:ACCT.GST_RCM_PAYABLE,debit:0,credit:taxTotal});
 }else{
  lines.push({account:expenseAccount,debit:round2(total-credit),credit:0});
  if(inTwoB(bill))for(const head of HEADS)lines.push({account:INPUT_TAX_ACCOUNTS[head],debit:creditable[head],credit:0});
  else lines.push({account:ACCT.INPUT_TAX_PENDING_2B,debit:credit,credit:0});
  lines.push({account:ACCOUNTS_PAYABLE,debit:0,credit:total});
 }
 return lines.filter(line=>Math.abs(line.debit)>=0.005||Math.abs(line.credit)>=0.005);
}
const toPaise=(v:number)=>Math.round(v*100);
export function assertBalanced(lines:PostingLine[]){
 const debit=lines.reduce((s,l)=>s+toPaise(l.debit),0),credit=lines.reduce((s,l)=>s+toPaise(l.credit),0);
 if(debit!==credit)throw new Error(`Journal is not balanced: debit ${debit/100} != credit ${credit/100}`);
 if(lines.some(l=>l.debit<0||l.credit<0))throw new Error("Journal lines must not be negative");
}
/** Net debit (debit - credit) per account. */
export const netByAccount=(lines:PostingLine[])=>{const out=new Map<string,number>();for(const l of lines)out.set(l.account,round2((out.get(l.account)??0)+l.debit-l.credit));return out;};
/** The lines that move the books from `posted` to `target` (both as net debit per account). */
export function deltaLines(target:Map<string,number>,posted:Map<string,number>):PostingLine[]{
 const accounts=[...new Set([...target.keys(),...posted.keys()])].sort(),lines:PostingLine[]=[];
 for(const account of accounts){const diff=round2((target.get(account)??0)-(posted.get(account)??0));if(Math.abs(diff)<0.005)continue;lines.push(diff>0?{account,debit:diff,credit:0}:{account,debit:0,credit:round2(-diff)});}
 return lines;
}
/**
 * Posts one balanced journal exactly once, in the same D1 batch as `extra` statements. The claim row (source_type, source_id)
 * is the concurrency boundary: a second caller computing from the same state claims the same key and its whole batch fails,
 * so a journal is never doubled; its rows only insert when this call's claim token is the one on file.
 */
export async function postClaimedJournal(db:Db,input:{claimType:string;claimKey:string;sourceType:string;sourceId:string;entityId:string;entryDate:string;narration:string;lines:PostingLine[];costCentre?:string|null;vertical?:string|null;extra?:D1PreparedStatement[]}){
 const lines=input.lines.filter(l=>Math.abs(l.debit)>=0.005||Math.abs(l.credit)>=0.005);
 assertBalanced(lines);
 const period=input.entryDate.slice(0,7);
 if(lines.length&&await periodLocked(db,period))throw refuse(`${period} is closed and locked; this journal would be dated ${input.entryDate}`);
 const token=crypto.randomUUID(),group=idOf("jrn"),now=Date.now(),statements:D1PreparedStatement[]=[];
 if(lines.length){
  statements.push(db.prepare("INSERT INTO finance_journal_posting_claims (source_type,source_id,claim_token,created_at) VALUES (?,?,?,?)").bind(input.claimType,input.claimKey,token,now));
  lines.forEach((l,i)=>statements.push(db.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1,? FROM finance_journal_posting_claims WHERE source_type=? AND source_id=? AND claim_token=?").bind(`${group}_${i+1}`,input.entityId,input.entryDate,input.sourceType,input.sourceId,l.account,input.costCentre??null,input.vertical??null,round2(l.debit),round2(l.credit),input.narration,period,now,input.claimType,input.claimKey,token)));
 }
 statements.push(...(input.extra??[]));
 if(!statements.length)return{journalGroup:null as string|null};
 try{await db.batch(statements);}
 catch(error){const message=error instanceof Error?error.message:String(error);if(/UNIQUE|constraint/i.test(message))throw refuse("This record changed at the same time from another session; refresh and try again");throw error;}
 return{journalGroup:lines.length?group:null};
}
async function postedForBill(db:Db,billId:string){
 const rows=(await db.prepare("SELECT account_code,COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) net FROM finance_journal_entries WHERE source_id=? AND source_type IN ('vendor_bill','vendor_bill_itc') GROUP BY account_code").bind(billId).all<Row>()).results;
 return new Map(rows.map(r=>[text(r.account_code),round2(num(r.net))]));
}
async function nextClaimNumber(db:Db,claimType:string,prefix:string){
 const row=await db.prepare("SELECT COUNT(*) n FROM finance_journal_posting_claims WHERE source_type=? AND source_id>=? AND source_id<?").bind(claimType,`${prefix}#`,`${prefix}$`).first<Row>();
 return num(row?.n)+1;
}
/**
 * Brings an approved bill's journal in line with its current GST details (a split or classification after approval, a GSTR-2B
 * match moving the credit from 1185 to the head accounts). Posts only the difference, once; a bill that is not approved yet, or
 * already in line, posts nothing. Dated today (IST), so a closed month is never written into.
 */
export async function syncBillLedger(db:Db,bill:Row,input:{actor:string;reason:string;today?:string}){
 if(!["approved","paid"].includes(text(bill.status)))return{journalGroup:null as string|null,lines:[] as PostingLine[]};
 const posted=await postedForBill(db,text(bill.id));
 if(!posted.size)return{journalGroup:null as string|null,lines:[] as PostingLine[]};
 const lines=deltaLines(netByAccount(billPostingLines(bill)),posted);
 if(!lines.length)return{journalGroup:null as string|null,lines};
 const claimKey=`${text(bill.id)}#${await nextClaimNumber(db,"vendor_bill_itc",text(bill.id))}`;
 const posting=await postClaimedJournal(db,{claimType:"vendor_bill_itc",claimKey,sourceType:"vendor_bill_itc",sourceId:text(bill.id),entityId:text(bill.entity_id)||"pawspace_india",entryDate:input.today??istToday(),narration:`GST of bill ${text(bill.supplier_invoice_number)||text(bill.bill_number)} brought in line with its GST details: ${input.reason}`.slice(0,300),lines,costCentre:text(bill.cost_centre)||null,vertical:text(bill.vertical)||null});
 return{journalGroup:posting.journalGroup,lines};
}
/** A bill's GST details can change until a saved ITC computation has taken it; after that the month's figures are final. */
export function billTaxLocked(bill:Row){return Boolean(text(bill.itc_claimed_period)||text(bill.rcm_reported_period)||text(bill.rule37_reversed_period)||text(bill.rule37a_reversed_period));}

// ---------------------------------------------------------------------------------------------------------------------
// GSTR-2B import and matching
// ---------------------------------------------------------------------------------------------------------------------
export type Gstr2bLine={supplierGstin:string;supplierName:string;invoiceNumber:string;invoiceKey:string;invoiceDate:string;invoiceType:string;placeOfSupply:string;reverseCharge:boolean;itcAvailable:string;itcReason:string;invoiceValue:number;taxableValue:number;tax:Heads;supplierPeriod:string};
const portalDate=(value:unknown)=>{const v=text(value);const m=/^(\d{2})-(\d{2})-(\d{4})$/.exec(v);const iso=m?`${m[3]}-${m[2]}-${m[1]}`:v;return isIsoDate(iso)?iso:"";};
const portalPeriod=(value:unknown)=>{const v=text(value);return/^\d{6}$/.test(v)&&isPeriod(`${v.slice(2)}-${v.slice(0,2)}`)?`${v.slice(2)}-${v.slice(0,2)}`:"";};
const MAX_2B_INVOICES=20_000;
/**
 * Reads the GSTR-2B JSON the GST portal downloads ({data:{gstin,rtnprd,gendt,docdata:{b2b:[{ctin,trdnm,supprd,inv:[...]}]}}}),
 * tolerating the wrapper being absent and item-level amounts. Only the b2b section is matched; other sections are counted.
 */
export function parseGstr2b(raw:unknown){
 let value=raw;
 if(typeof value==="string"){if(value.length>8_000_000)throw refuse("The GSTR-2B file is too large (8 MB at most)",400);try{value=JSON.parse(value);}catch{throw refuse("The GSTR-2B file is not valid JSON",400);}}
 if(!value||typeof value!=="object")throw refuse("Upload the GSTR-2B JSON downloaded from the GST portal",400);
 const root=((value as Row).data&&typeof (value as Row).data==="object"?(value as Row).data:value) as Row;
 const gstin=text(root.gstin).toUpperCase(),returnPeriod=portalPeriod(root.rtnprd);
 if(!gstin||!returnPeriod)throw refuse("This is not a GSTR-2B file: it has no GSTIN or return period (rtnprd)",400);
 const docs=((root.docdata&&typeof root.docdata==="object"?root.docdata:root) as Row);
 const suppliers=Array.isArray(docs.b2b)?docs.b2b as Row[]:[];
 const lines:Gstr2bLine[]=[],skipped:Array<{supplierGstin:string;invoiceNumber:string;reason:string}>=[];
 for(const supplier of suppliers){
  const ctin=text(supplier?.ctin).toUpperCase(),invoices=Array.isArray(supplier?.inv)?supplier.inv as Row[]:[];
  for(const inv of invoices){
   if(lines.length+skipped.length>=MAX_2B_INVOICES)throw refuse(`The GSTR-2B file has more than ${MAX_2B_INVOICES} invoices; split it by month`,400);
   const invoiceNumber=text(inv?.inum),invoiceDate=portalDate(inv?.dt);
   if(!validateGstin(ctin).ok||!invoiceNumber||!invoiceDate){skipped.push({supplierGstin:ctin,invoiceNumber,reason:"The supplier GSTIN, invoice number or date is missing or not valid"});continue;}
   const items=[...(Array.isArray(inv.items)?inv.items as Row[]:[]),...(Array.isArray(inv.itms)?(inv.itms as Row[]).map(i=>(i?.itm_det??i) as Row):[])];
   const pick=(key:string)=>inv[key]!==undefined&&inv[key]!==null&&inv[key]!==""?round2(num(inv[key])):round2(items.reduce((s,i)=>s+num(i?.[key]),0));
   const tax={igst:pick("igst"),cgst:pick("cgst"),sgst:pick("sgst"),cess:pick("cess")};
   lines.push({supplierGstin:ctin,supplierName:text(supplier.trdnm),invoiceNumber,invoiceKey:normaliseInvoiceNumber(invoiceNumber),invoiceDate,invoiceType:text(inv.typ)||"R",placeOfSupply:text(inv.pos)?text(inv.pos).padStart(2,"0").slice(0,2):"",reverseCharge:text(inv.rev).toUpperCase()==="Y",itcAvailable:text(inv.itcavl).toUpperCase()||"Y",itcReason:text(inv.rsn),invoiceValue:round2(num(inv.val)),taxableValue:pick("txval"),tax,supplierPeriod:portalPeriod(supplier.supprd)});
  }
 }
 const otherSections=Object.entries(docs).filter(([key,v])=>key!=="b2b"&&Array.isArray(v)&&(v as unknown[]).length).map(([key,v])=>({section:key,documents:(v as unknown[]).length}));
 return{gstin,returnPeriod,generatedOn:text(root.gendt),lines,skipped,otherSections};
}
type MatchOutcome={status:"matched"|"already_matched"|"no_bill"|"date_mismatch"|"amount_mismatch"|"needs_split"|"itc_not_available"|"duplicate";billId:string|null;note:string};
const within1=(a:number,b:number)=>Math.abs(round2(a)-round2(b))<=1;
/** One GSTR-2B invoice against the entity's bills (same supplier GSTIN and normalised invoice number). */
export function matchGstr2bLine(line:Gstr2bLine,candidates:Row[],taken:Set<string>):MatchOutcome{
 if(!candidates.length)return{status:"no_bill",billId:null,note:"No bill in the books for this supplier invoice"};
 const sameDate=candidates.filter(b=>(text(b.supplier_invoice_date)||text(b.bill_date))===line.invoiceDate);
 if(!sameDate.length)return{status:"date_mismatch",billId:text(candidates[0].id),note:`The books date this invoice ${text(candidates[0].supplier_invoice_date)||text(candidates[0].bill_date)}; GSTR-2B has ${line.invoiceDate}`};
 const bill=sameDate.find(b=>!taken.has(text(b.id)))??sameDate[0];
 if(taken.has(text(bill.id)))return{status:"duplicate",billId:text(bill.id),note:"GSTR-2B lists this invoice more than once"};
 if(line.itcAvailable==="N")return{status:"itc_not_available",billId:text(bill.id),note:`GSTR-2B marks this credit as not available${line.itcReason?` (reason ${line.itcReason}: ${line.itcReason==="P"?"place of supply in another state":line.itcReason==="C"?"section 16(4) time limit":"see GSTR-2B"})`:""}`};
 if(!billHasSplit(bill))return{status:"needs_split",billId:text(bill.id),note:`Split the bill's GST first; GSTR-2B shows CGST ${line.tax.cgst}, SGST ${line.tax.sgst}, IGST ${line.tax.igst}, cess ${line.tax.cess}`};
 const tax=billTax(bill);
 if(!within1(num(bill.taxable_amount),line.taxableValue)||HEADS.some(h=>!within1(tax[h],line.tax[h])))return{status:"amount_mismatch",billId:text(bill.id),note:`Books: taxable ${round2(num(bill.taxable_amount))}, CGST ${tax.cgst}, SGST ${tax.sgst}, IGST ${tax.igst}, cess ${tax.cess}. GSTR-2B: taxable ${line.taxableValue}, CGST ${line.tax.cgst}, SGST ${line.tax.sgst}, IGST ${line.tax.igst}, cess ${line.tax.cess}`};
 if(inTwoB(bill))return{status:"already_matched",billId:text(bill.id),note:`Already ${text(bill.gstr2b_status)==="matched"?"matched":"confirmed"} for ${text(bill.gstr2b_period)}`};
 return{status:"matched",billId:text(bill.id),note:"Supplier GSTIN, invoice number, date and every amount agree (within Rs 1)"};
}
async function entityBills(db:Db,entityId:string){
 return(await db.prepare("SELECT b.*,v.name vendor_name,v.gstin vendor_gstin FROM finance_bills b LEFT JOIN finance_vendors v ON v.id=b.vendor_id WHERE b.entity_id=? AND b.status<>'rejected'").bind(entityId).all<Row>()).results;
}
const billGstin=(b:Row)=>text(b.supplier_gstin)||(text(b.supplier_type)&&text(b.supplier_type)!=="registered"?"":text(b.vendor_gstin).toUpperCase());
/** Import a GSTR-2B JSON for a registration and match it to the bills. Idempotent per file; audited. */
export async function importGstr2b(db:Db,input:{entityId:string;registrationId:string;gstr2b:unknown;reason:string},actor:string){
 await ensureInputTaxTables(db);
 const reason=text(input.reason);if(reason.length<5)throw refuse("A reason of at least 5 characters is required",400);
 const parsed=parseGstr2b(input.gstr2b),reg=await activeRegistration(db,input,lastDayOf(parsed.returnPeriod));
 if(parsed.gstin!==reg.gstin)throw refuse(`This GSTR-2B is for GSTIN ${parsed.gstin}, not the selected registration ${reg.gstin}`,400);
 const checksum=await sha256(JSON.stringify(parsed.lines));
 const prior=await db.prepare("SELECT * FROM finance_gstr2b_imports WHERE registration_id=? AND return_period=? AND checksum=?").bind(input.registrationId,parsed.returnPeriod,checksum).first<Row>();
 if(prior&&text(prior.result_json))return await rematchPriorImport(db,prior,parsed.lines,input.entityId,actor,reason);
 if(prior){
  // Claimed but never finished: another session is importing this file now, or an earlier attempt stopped part-way.
  if(Date.now()-num(prior.imported_at)<10*60_000)throw refuse("This GSTR-2B file is being imported from another session; refresh in a minute",409);
  const stale=text(prior.id);
  await db.batch([db.prepare("UPDATE finance_bills SET gstr2b_status='not_in_2b',gstr2b_period=NULL,gstr2b_line_id=NULL WHERE gstr2b_status='matched' AND gstr2b_line_id IN (SELECT id FROM finance_gstr2b_lines WHERE import_id=?)").bind(stale),
   db.prepare("DELETE FROM finance_gstr2b_lines WHERE import_id=?").bind(stale),db.prepare("DELETE FROM finance_gstr2b_imports WHERE id=? AND result_json=''").bind(stale)]);
 }
 const bills=await entityBills(db,input.entityId),byKey=new Map<string,Row[]>();
 for(const b of bills){const g=billGstin(b);if(!g)continue;const key=`${g}|${normaliseInvoiceNumber(text(b.supplier_invoice_number)||text(b.bill_number))}`;byKey.set(key,[...(byKey.get(key)??[]),b]);}
 const importId=idOf("g2b"),taken=new Set<string>(),outcomes:Array<{line:Gstr2bLine;outcome:MatchOutcome;lineId:string}>=[];
 for(const line of parsed.lines){const outcome=matchGstr2bLine(line,byKey.get(`${line.supplierGstin}|${line.invoiceKey}`)??[],taken);if(outcome.billId&&["matched","already_matched"].includes(outcome.status))taken.add(outcome.billId);outcomes.push({line,outcome,lineId:idOf("g2bl")});}
 const period=parsed.returnPeriod,periodEnd=lastDayOf(period),now=Date.now();
 const matched=outcomes.filter(o=>o.outcome.status==="matched");
 const billById=new Map(bills.map(b=>[text(b.id),b]));
 const mentioned=new Set(outcomes.map(o=>o.outcome.billId).filter(Boolean) as string[]);
 const unmatchedIn2b=bills.filter(b=>!mentioned.has(text(b.id))&&!inTwoB(b)&&num(b.reverse_charge)!==1&&billGstin(b)&&(text(b.supplier_invoice_date)||text(b.bill_date))<=periodEnd&&(billNeedsSplit(b)||(billHasSplit(b)&&headsTotal(billTax(b))>0))).map(b=>({billId:text(b.id),supplierGstin:billGstin(b),supplierName:text(b.vendor_name),invoiceNumber:text(b.supplier_invoice_number)||text(b.bill_number),invoiceDate:text(b.supplier_invoice_date)||text(b.bill_date),tax:billHasSplit(b)?billTax(b):null,gstAmount:round2(num(b.gst_amount)),status:text(b.status)}));
 const view=(o:typeof outcomes[number])=>({lineId:o.lineId,supplierGstin:o.line.supplierGstin,supplierName:o.line.supplierName,invoiceNumber:o.line.invoiceNumber,invoiceDate:o.line.invoiceDate,taxableValue:o.line.taxableValue,tax:o.line.tax,billId:o.outcome.billId,status:o.outcome.status,note:o.outcome.note});
 const result={importId,registrationId:input.registrationId,gstin:parsed.gstin,returnPeriod:period,generatedOn:parsed.generatedOn,invoices:parsed.lines.length,
  matched:outcomes.filter(o=>["matched","already_matched"].includes(o.outcome.status)).map(view),
  unmatchedInBooks:outcomes.filter(o=>o.outcome.status==="no_bill").map(view),
  needsAttention:outcomes.filter(o=>!["matched","already_matched","no_bill"].includes(o.outcome.status)).map(view),
  unmatchedIn2b,skipped:parsed.skipped,otherSections:parsed.otherSections,
  note:"Only matched bills (or bills Finance confirms with a reason) can be credited. Credit and debit notes and amendments in GSTR-2B are listed, not matched."};
 // The import row is claimed first (its result empty until the end), so a second session importing the same file at the same
 // time is refused before it writes anything, and never leaves lines or bill matches of its own.
 try{await db.prepare("INSERT INTO finance_gstr2b_imports (id,entity_id,registration_id,gstin,return_period,generated_on,checksum,invoice_count,matched_count,result_json,reason,imported_by,imported_at) VALUES (?,?,?,?,?,?,?,?,0,'',?,?,?)").bind(importId,input.entityId,input.registrationId,parsed.gstin,period,parsed.generatedOn||null,checksum,parsed.lines.length,reason,actor,now).run();}
 catch(error){if(/UNIQUE|constraint/i.test(error instanceof Error?error.message:String(error)))throw refuse("The same GSTR-2B file was imported at the same time from another session; refresh",409);throw error;}
 const header=[db.prepare("UPDATE finance_gstr2b_imports SET matched_count=?,result_json=? WHERE id=?").bind(matched.length,JSON.stringify(result),importId)],statements:D1PreparedStatement[]=[];
 for(const o of outcomes)statements.push(db.prepare("INSERT INTO finance_gstr2b_lines (id,import_id,supplier_gstin,supplier_name,invoice_number,invoice_key,invoice_date,invoice_type,place_of_supply,reverse_charge,itc_available,itc_reason,invoice_value,taxable_value,igst,cgst,sgst,cess,supplier_period,match_status,matched_bill_id,match_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(o.lineId,importId,o.line.supplierGstin,o.line.supplierName||null,o.line.invoiceNumber,o.line.invoiceKey,o.line.invoiceDate,o.line.invoiceType,o.line.placeOfSupply||null,o.line.reverseCharge?1:0,o.line.itcAvailable,o.line.itcReason||null,o.line.invoiceValue,o.line.taxableValue,o.line.tax.igst,o.line.tax.cgst,o.line.tax.sgst,o.line.tax.cess,o.line.supplierPeriod||null,o.outcome.status,o.outcome.billId,o.outcome.note));
 // A bill is matched into the later of the GSTR-2B month and its invoice month, and only if nothing matched it meanwhile.
 for(const o of matched){const b=billById.get(o.outcome.billId as string)!,invMonth=(text(b.supplier_invoice_date)||text(b.bill_date)).slice(0,7);statements.push(db.prepare("UPDATE finance_bills SET gstr2b_status='matched',gstr2b_period=?,gstr2b_line_id=?,updated_at=? WHERE id=? AND gstr2b_status NOT IN ('matched','manual_confirmed')").bind(invMonth>period?invMonth:period,o.lineId,now,text(b.id)));}
 header.push(await audit(db,actor,"gstr2b_import",importId,"imported",{registrationId:input.registrationId,returnPeriod:period,checksum,invoices:parsed.lines.length,matched:matched.length,unmatchedInBooks:result.unmatchedInBooks.length,unmatchedIn2b:unmatchedIn2b.length,needsAttention:result.needsAttention.length},reason));
 // D1 binds at most 100 values per statement and each batch is one transaction: write in chunks and the import's result last,
 // so a failure part-way never leaves an import that looks complete (after 10 minutes, re-importing the same file redoes it).
 for(let i=0;i<statements.length;i+=50)await db.batch(statements.slice(i,i+50));
 await db.batch(header);
 const journals:Array<{billId:string;journalGroup:string|null}>=[];
 for(const o of matched){const fresh=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(o.outcome.billId).first<Row>();if(fresh){const synced=await syncBillLedger(db,fresh,{actor,reason:`matched in GSTR-2B ${period}`});if(synced.journalGroup)journals.push({billId:text(fresh.id),journalGroup:synced.journalGroup});}}
 return{...result,id:importId,journals,duplicatePrevented:false};
}
/**
 * The same GSTR-2B file again: no second import is recorded, but its lines that matched no bill before are matched again, because
 * Finance may have split a bill's GST or corrected its invoice number since (what the import's own guidance asks for).
 */
async function rematchPriorImport(db:Db,prior:Row,lines:Gstr2bLine[],entityId:string,actor:string,reason:string){
 const importId=text(prior.id),period=text(prior.return_period),stored=JSON.parse(text(prior.result_json)||"{}") as Row;
 const open=(await db.prepare("SELECT id,supplier_gstin,invoice_key,invoice_date FROM finance_gstr2b_lines WHERE import_id=? AND match_status NOT IN ('matched','already_matched')").bind(importId).all<Row>()).results;
 if(!open.length)return{...stored,id:importId,duplicatePrevented:true,rematched:0};
 const bills=await entityBills(db,entityId),byKey=new Map<string,Row[]>(),billById=new Map(bills.map(b=>[text(b.id),b]));
 for(const b of bills){const g=billGstin(b);if(!g)continue;const key=`${g}|${normaliseInvoiceNumber(text(b.supplier_invoice_number)||text(b.bill_number))}`;byKey.set(key,[...(byKey.get(key)??[]),b]);}
 const taken=new Set((await db.prepare("SELECT matched_bill_id FROM finance_gstr2b_lines WHERE import_id=? AND matched_bill_id IS NOT NULL AND match_status IN ('matched','already_matched')").bind(importId).all<Row>()).results.map(r=>text(r.matched_bill_id)));
 const byLine=new Map(lines.map(l=>[`${l.supplierGstin}|${l.invoiceKey}|${l.invoiceDate}`,l])),now=Date.now(),statements:D1PreparedStatement[]=[],matchedBills:string[]=[],changed=new Map<string,MatchOutcome>();
 for(const row of open){
  const line=byLine.get(`${text(row.supplier_gstin)}|${text(row.invoice_key)}|${text(row.invoice_date)}`);if(!line)continue;
  const outcome=matchGstr2bLine(line,byKey.get(`${line.supplierGstin}|${line.invoiceKey}`)??[],taken);
  if(outcome.status!=="matched"||!outcome.billId)continue;
  taken.add(outcome.billId);matchedBills.push(outcome.billId);changed.set(text(row.id),outcome);
  const b=billById.get(outcome.billId)!,invMonth=(text(b.supplier_invoice_date)||text(b.bill_date)).slice(0,7);
  statements.push(db.prepare("UPDATE finance_gstr2b_lines SET match_status='matched',matched_bill_id=?,match_note=? WHERE id=? AND match_status NOT IN ('matched','already_matched')").bind(outcome.billId,outcome.note||null,text(row.id)));
  statements.push(db.prepare("UPDATE finance_bills SET gstr2b_status='matched',gstr2b_period=?,gstr2b_line_id=?,updated_at=? WHERE id=? AND gstr2b_status NOT IN ('matched','manual_confirmed')").bind(invMonth>period?invMonth:period,text(row.id),now,outcome.billId));
 }
 if(!statements.length)return{...stored,id:importId,duplicatePrevented:true,rematched:0};
 // The stored result moves the re-matched lines to "matched", so the import screen shows what is matched now.
 const moved=(list:unknown)=>(Array.isArray(list)?list:[]) as Row[],result={...stored};
 const wasOpen=[...moved(stored.unmatchedInBooks),...moved(stored.needsAttention)].filter(v=>changed.has(text(v.lineId)));
 result.matched=[...moved(stored.matched),...wasOpen.map(v=>({...v,billId:changed.get(text(v.lineId))!.billId,status:"matched",note:changed.get(text(v.lineId))!.note}))];
 result.unmatchedInBooks=moved(stored.unmatchedInBooks).filter(v=>!changed.has(text(v.lineId)));
 result.needsAttention=moved(stored.needsAttention).filter(v=>!changed.has(text(v.lineId)));
 result.unmatchedIn2b=moved(stored.unmatchedIn2b).filter(v=>!matchedBills.includes(text(v.billId)));
 statements.push(db.prepare("UPDATE finance_gstr2b_imports SET matched_count=matched_count+?,result_json=? WHERE id=?").bind(changed.size,JSON.stringify(result),importId));
 statements.push(await audit(db,actor,"gstr2b_import",importId,"rematched",{returnPeriod:period,rematched:changed.size},reason));
 await db.batch(statements);
 const journals:Array<{billId:string;journalGroup:string|null}>=[];
 for(const billId of matchedBills){const fresh=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(billId).first<Row>();if(fresh){const synced=await syncBillLedger(db,fresh,{actor,reason:`matched in GSTR-2B ${period}`});if(synced.journalGroup)journals.push({billId,journalGroup:synced.journalGroup});}}
 return{...result,id:importId,duplicatePrevented:true,rematched:changed.size,journals};
}
/** Finance confirms by hand that a bill's invoice is in GSTR-2B (for example a number the supplier typed differently). */
export async function confirmBillItc(db:Db,input:{billId:string;claimPeriod?:string;reason:string},actor:string){
 await ensureInputTaxTables(db);
 const reason=text(input.reason);if(reason.length<10)throw refuse("Say why this bill is confirmed without a GSTR-2B match (at least 10 characters)",400);
 const bill=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(text(input.billId)).first<Row>();
 if(!bill)throw refuse("Bill not found",404);
 if(text(bill.status)==="rejected")throw refuse("A rejected bill cannot be credited");
 if(!billHasSplit(bill))throw refuse("Split the bill's GST into CGST, SGST, IGST and cess before confirming it");
 if(num(bill.reverse_charge)===1)throw refuse("Reverse-charge tax is credited when PawSpace pays it; it does not need GSTR-2B");
 const invMonth=(text(bill.supplier_invoice_date)||text(bill.bill_date)).slice(0,7),claimPeriod=text(input.claimPeriod)||invMonth;
 if(!isPeriod(claimPeriod)||claimPeriod<invMonth||claimPeriod>istToday().slice(0,7))throw refuse("The GSTR-2B month must be on or after the invoice month and not in the future",400);
 if(text(bill.gstr2b_status)==="manual_confirmed"&&text(bill.gstr2b_period)===claimPeriod)return{billId:text(bill.id),gstr2bStatus:"manual_confirmed",gstr2bPeriod:claimPeriod,duplicatePrevented:true};
 if(inTwoB(bill))throw refuse(`This bill is already ${text(bill.gstr2b_status)==="matched"?"matched in GSTR-2B":"confirmed"} for ${text(bill.gstr2b_period)}`);
 if(claimPeriod>itcDeadlinePeriod(invMonth+"-01"))throw refuse(`Section 16(4): credit for an invoice of ${invMonth} could be taken only up to the return for ${itcDeadlinePeriod(invMonth+"-01")} (filed by 30 November); it can no longer be claimed`);
 if(await periodLocked(db,claimPeriod))throw refuse(`${claimPeriod} is closed and locked; confirm the bill for the current month`);
 const now=Date.now(),changed=await db.prepare("UPDATE finance_bills SET gstr2b_status='manual_confirmed',gstr2b_period=?,gstr2b_note=?,gstr2b_confirmed_by=?,gstr2b_confirmed_at=?,updated_at=? WHERE id=? AND gstr2b_status NOT IN ('matched','manual_confirmed')").bind(claimPeriod,reason,actor,now,now,text(bill.id)).run();
 if(!Number(changed.meta?.changes))throw refuse("The bill's GSTR-2B status changed at the same time; refresh and try again");
 await (await audit(db,actor,"vendor_bill",text(bill.id),"itc_manual_confirmed",{gstr2bStatus:"manual_confirmed",gstr2bPeriod:claimPeriod},reason,{gstr2bStatus:text(bill.gstr2b_status)||"not_in_2b"})).run();
 const fresh=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(text(bill.id)).first<Row>();
 const synced=fresh?await syncBillLedger(db,fresh,{actor,reason:"confirmed in GSTR-2B by Finance"}):{journalGroup:null};
 return{billId:text(bill.id),gstr2bStatus:"manual_confirmed",gstr2bPeriod:claimPeriod,journalGroup:synced.journalGroup,duplicatePrevented:false};
}

// ---------------------------------------------------------------------------------------------------------------------
// Monthly ITC computation
// ---------------------------------------------------------------------------------------------------------------------
export type Scope={entityId:string;registrationId:string};
export type Table4={a1_importOfGoods:Heads;a2_importOfServices:Heads;a3_reverseCharge:Heads;a4_isd:Heads;a5_allOther:Heads;b1_rules42_43_s17_5:Heads;b2_others:Heads;c_net:Heads;d1_reclaimed:Heads;d2_ineligible:Heads};
type BillRef={billId:string;supplier:string;supplierGstin:string|null;invoiceNumber:string;invoiceDate:string;treatment:string;tax:Heads;note?:string;expenseAccount?:string};
type Reversal=BillRef&{rule:"rule37"|"rule37a";amount:Heads;expenseAccount:string;claimedIn:string;dueBy?:string};
export type FuneralGstTreatment="schedule_iii"|"exempt"|"taxable_18";
export type ItcComputation={entityId:string;registrationId:string;period:string;gstin:string;homeState:string;table4:Table4;netItc:Heads;
 reverseCharge:{taxableValue:number;liability:Heads;importOfServices:Heads;bills:BillRef[]};
 rule42:{t_total:Heads;t1t2_ineligible:Heads;t3_blocked:Heads;c1_credited:Heads;t4_taxableOnly:Heads;commonCredit:Heads;d1:Heads;d2:Heads;c3_retained:Heads;reversal:Heads;nonBusinessCommonUse:boolean;
  exemptTurnover:number;totalTurnover:number;ratio:number;source:string;funeralGstTreatment:FuneralGstTreatment;
  turnover:{taxable:number;canonicalInvoices:number;exempt:number;funeral:number;funeralCounted:string;notYetClassified:number}|null;sharedOverheadWarning:string|null;note:string};
 rule37:{reversals:Reversal[];reclaims:Array<Reversal&{reversedIn:string}>;reversed:Heads;reclaimed:Heads;watch:BillRef[]};
 blocked:{reported:Heads;bills:BillRef[]};trueUp:{financialYear:string;difference:Heads}|null;
 credited:BillRef[];notCredited:{waitingForGstr2b:BillRef[];needsComponentSplit:Array<{billId:string;invoiceNumber:string;invoiceDate:string;gstAmount:number;legacyReviewedEligible:number}>;awaitingApproval:BillRef[];timeBarred:BillRef[];placeOfSupply:BillRef[]};
 marks:{itcClaimed:string[];rcmReported:string[];rule37Reversed:string[];rule37Reclaimed:string[];rule37aReversed:string[];rule37aReclaimed:string[]}};
const ref=(b:Row,tax:Heads,note?:string):BillRef=>({billId:text(b.id),supplier:text(b.vendor_name)||text(b.vendor_id),supplierGstin:billGstin(b)||null,invoiceNumber:text(b.supplier_invoice_number)||text(b.bill_number),invoiceDate:text(b.supplier_invoice_date)||text(b.bill_date),treatment:text(b.itc_treatment),tax,...(note?{note}:{})});
const fyStartYear=(date:string)=>{const y=Number(date.slice(0,4)),m=Number(date.slice(5,7));return m>=4?y:y-1;};
/** Section 16(4): fresh credit of an invoice can be taken up to 30 November after its financial year: the October return. */
export function itcDeadlinePeriod(invoiceDate:string){return`${fyStartYear(invoiceDate)+1}-10`;}
/** Section 13(3): reverse-charge tax on a service falls due on payment, or on the 61st day after the invoice if unpaid. */
export function reverseChargeTaxPoint(invoiceDate:string,paidOn:string|null){const deemed=addDays(invoiceDate,61);return paidOn&&paidOn<deemed?paidOn:deemed;}
/** Rule 37: credit is reversed in the return for the period after the 180 days from the invoice, if the supplier is unpaid. */
export const rule37DueMonth=(invoiceDate:string)=>addDays(invoiceDate,181).slice(0,7);
/** Rule 37A: a supplier who has not filed GSTR-3B by 30 September after the financial year: reversed from that return on. */
export const rule37aFromMonth=(invoiceDate:string)=>`${fyStartYear(invoiceDate)+1}-09`;
export async function latestComputations(db:Db,scope:Scope){
 const rows=(await db.prepare("SELECT * FROM finance_itc_computations WHERE entity_id=? AND registration_id=? ORDER BY period_code,version").bind(scope.entityId,scope.registrationId).all<Row>()).results;
 const latest=new Map<string,Row>();for(const r of rows)latest.set(text(r.period_code),r);
 return latest;
}
export const computationFigures=(row:Row|null|undefined):ItcComputation|null=>{if(!row)return null;try{return JSON.parse(text(row.figures_json)) as ItcComputation;}catch{return null;}};
/**
 * How funeral / memorial is treated for GST: the Finance setting funeral_gst_treatment (lib/funeral-gst-treatment.ts; legal
 * default Schedule III non-GST, or exempt / 18% if the CA decides). Only "exempt" puts funeral turnover in Rule 42's E; under
 * Schedule III it is in neither E nor F (Explanation to section 17(3): not a supply, so not turnover).
 */
export async function funeralGstTreatment(db:Db,_entityId:string,onDate:string):Promise<FuneralGstTreatment>{
 return(await resolveFuneralGstTreatment(db,onDate)).treatment;
}
const isFuneralLine=(l:{serviceCode:string;source:string})=>l.serviceCode==="funeral_memorial"||l.source==="funeral_case"||l.source==="funeral_manual_order";
/**
 * Turnover for Rule 42 of a window: E (exempt supplies) and F (total turnover in the State) from the service supply register and
 * the canonical invoices. F counts what PawSpace makes (its commission on provider-delivered bookings). Funeral follows
 * funeralGstTreatment: in E and F only when exempt; in F only when taxable; in neither under Schedule III.
 */
export async function rule42Turnover(db:Db,scope:Scope,fromPeriod:string,toPeriod:string){
 const{startMs,endMs}=periodWindow(fromPeriod,toPeriod),svc=await serviceVerticalOutputTax(db,startMs,endMs,scope);
 // Invoices issued by hand only: a booking's customer tax invoice is already in the service register above.
 const canonical=await db.prepare(`SELECT COALESCE(SUM(subtotal),0) txval FROM finance_invoices WHERE entity_id=? AND registration_id=? AND substr(issue_date,1,7) BETWEEN ? AND ? AND status!='cancelled'${await canonicalInvoicesOnlySql(db)}`).bind(scope.entityId,scope.registrationId,fromPeriod,toPeriod).first<Row>();
 const treatment=await funeralGstTreatment(db,scope.entityId,lastDayOf(toPeriod));
 const funeral=round2(svc.lines.filter(l=>l.section==="exempt"&&isFuneralLine(l)).reduce((s,l)=>s+l.exemptValue,0)),otherExempt=round2(svc.exemptValue-funeral);
 const taxable=round2(svc.pawspaceOwnTaxableValue+(treatment==="taxable_18"?funeral:0)),canonicalInvoices=round2(num(canonical?.txval)),exempt=round2(otherExempt+(treatment==="exempt"?funeral:0));
 return{taxable,canonicalInvoices,exempt,funeral,funeralCounted:treatment==="exempt"?"in E and F (exempt)":treatment==="taxable_18"?"in F only (taxable)":"in neither E nor F (Schedule III)",total:round2(taxable+canonicalInvoices+exempt),notYetClassified:round2(svc.notYetClassified.orderValue),funeralGstTreatment:treatment};
}
/**
 * The month's input tax credit for one GST registration, computed live from the purchase register. Saved computations of other
 * months decide what was already credited, reversed or re-claimed (see saveItcComputation), so a bill is never credited twice.
 */
export async function computeItc(db:Db,input:Scope&{period:string;nonBusinessCommonUse?:boolean}):Promise<ItcComputation>{
 await ensureInputTaxTables(db);
 const period=text(input.period);if(!isPeriod(period))throw refuse("The month must be YYYY-MM",400);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},reg=await activeRegistration(db,scope,lastDayOf(period)),periodEnd=lastDayOf(period);
 const saved=await latestComputations(db,scope),bills=await entityBills(db,scope.entityId);
 const figuresOf=new Map<string,ItcComputation|null>(),savedFigures=(p:string)=>{if(!figuresOf.has(p))figuresOf.set(p,computationFigures(saved.get(p)));return figuresOf.get(p)??null;};
 const legacy=new Map((await db.prepare("SELECT bill_id,COALESCE(SUM(eligible_tax_amount),0) amount FROM finance_vendor_tax_reviews WHERE review_status='eligible' GROUP BY bill_id").all<Row>()).results.map(r=>[text(r.bill_id),round2(num(r.amount))]));
 const t4:Table4={a1_importOfGoods:zeroHeads(),a2_importOfServices:zeroHeads(),a3_reverseCharge:zeroHeads(),a4_isd:zeroHeads(),a5_allOther:zeroHeads(),b1_rules42_43_s17_5:zeroHeads(),b2_others:zeroHeads(),c_net:zeroHeads(),d1_reclaimed:zeroHeads(),d2_ineligible:zeroHeads()};
 let commonCredit=zeroHeads(),taxableOnly=zeroHeads(),blockedT3=zeroHeads(),ineligibleT1T2=zeroHeads(),rcmTaxable=0,rcmLiability=zeroHeads(),blockedReported=zeroHeads();
 const rcmBills:BillRef[]=[],credited:BillRef[]=[],blockedBills:BillRef[]=[],waiting:BillRef[]=[],awaiting:BillRef[]=[],timeBarred:BillRef[]=[],posBills:BillRef[]=[],needsSplit:ItcComputation["notCredited"]["needsComponentSplit"]=[];
 const marks:ItcComputation["marks"]={itcClaimed:[],rcmReported:[],rule37Reversed:[],rule37Reclaimed:[],rule37aReversed:[],rule37aReclaimed:[]};
 const creditedNow=new Set<string>(),sharedOverheadBills:string[]=[];
 const involve=(treatment:string,tax:Heads)=>{if(treatment==="eligible")taxableOnly=addHeads(taxableOnly,tax);else if(treatment==="common_rule_42")commonCredit=addHeads(commonCredit,tax);else if(treatment==="blocked_17_5")blockedT3=addHeads(blockedT3,tax);else if(treatment==="ineligible_other")ineligibleT1T2=addHeads(ineligibleT1T2,tax);};
 for(const b of bills){
  const markReg=text(b.itc_registration_id);if(markReg&&markReg!==scope.registrationId)continue;
  const recipient=text(b.recipient_registration_id);if(recipient&&recipient!==scope.registrationId)continue;
  const inv=text(b.supplier_invoice_date)||text(b.bill_date),approved=["approved","paid"].includes(text(b.status)),treatment=text(b.itc_treatment);
  if(billNeedsSplit(b)){if(inv.slice(0,7)<=period)needsSplit.push({billId:text(b.id),invoiceNumber:text(b.supplier_invoice_number)||text(b.bill_number),invoiceDate:inv,gstAmount:round2(num(b.gst_amount)),legacyReviewedEligible:legacy.get(text(b.id))??0});continue;}
  if(!billHasSplit(b))continue;
  const tax=billTax(b),taxTotal=headsTotal(tax);if(taxTotal===0)continue;
  if(num(b.reverse_charge)===1){
   const due=reverseChargeTaxPoint(inv,text(b.paid_to_supplier_on)||null).slice(0,7),reported=text(b.rcm_reported_period);
   if(reported?reported!==period:due>period)continue;
   if(!approved){awaiting.push(ref(b,tax,"Reverse-charge tax falls due this month; approve the bill to report it"));continue;}
   rcmLiability=addHeads(rcmLiability,tax);rcmTaxable=round2(rcmTaxable+num(b.taxable_amount));rcmBills.push(ref(b,tax));marks.rcmReported.push(text(b.id));involve(treatment,tax);
   if(CREDITABLE.has(treatment)){if(text(b.supplier_type)==="overseas")t4.a2_importOfServices=addHeads(t4.a2_importOfServices,tax);else t4.a3_reverseCharge=addHeads(t4.a3_reverseCharge,tax);credited.push(ref(b,tax,"Reverse charge: paid in cash, credited in the same month"));}
   else blockedBills.push(ref(b,tax,"Reverse-charge tax on a blocked or ineligible purchase: paid in cash, never credited"));
   continue;
  }
  if(!CREDITABLE.has(treatment)&&!REPORTED_NOT_CREDITED.has(treatment))continue;
  const claimed=text(b.itc_claimed_period);
  if(claimed&&claimed!==period)continue;
  if(!inTwoB(b)){if(CREDITABLE.has(treatment)){if(inv.slice(0,7)<=period)waiting.push(ref(b,tax,"Not in GSTR-2B yet: import the month's GSTR-2B, or confirm it with a reason"));}else if(inv.slice(0,7)===period)blockedBills.push(ref(b,tax,"Blocked or not eligible and never availed (not in GSTR-2B): shown here, never credited"));continue;}
  if(!claimed&&text(b.gstr2b_period)>period)continue;
  if(!approved){awaiting.push(ref(b,tax,"In GSTR-2B; approve the bill to credit it"));continue;}
  marks.itcClaimed.push(text(b.id));
  if(period>itcDeadlinePeriod(inv)){t4.d2_ineligible=addHeads(t4.d2_ineligible,tax);timeBarred.push({...ref(b,tax,`Section 16(4): credit for an invoice of ${inv} could be taken only until the return for ${itcDeadlinePeriod(inv)} (filed by 30 November)`),expenseAccount:billExpenseAccount(b.category_code)});continue;}
  if(text(b.place_of_supply)&&text(b.place_of_supply)!==reg.homeState){t4.d2_ineligible=addHeads(t4.d2_ineligible,tax);posBills.push({...ref(b,tax,`Place of supply ${GST_STATES[text(b.place_of_supply)]??text(b.place_of_supply)}: the tax belongs to that state`),expenseAccount:billExpenseAccount(b.category_code)});continue;}
  t4.a5_allOther=addHeads(t4.a5_allOther,tax);involve(treatment,tax);
  if(CREDITABLE.has(treatment)){credited.push(ref(b,tax));creditedNow.add(text(b.id));if(treatment==="eligible"&&EXPENSE_ITC_DEFAULTS[text(b.category_code)]?.sharedOverhead)sharedOverheadBills.push(text(b.id));}
  else{blockedReported=addHeads(blockedReported,tax);blockedBills.push(ref(b,tax,treatment==="blocked_17_5"?`${text(b.itc_clause)}: availed through GSTR-2B, reversed in full in 4(B)(1)`:`Not eligible (${text(b.itc_reason)}): availed through GSTR-2B, reversed in full in 4(B)(1)`));}
 }
 // Rule 42, per head: C2 common credit, D1 = C2 x E / F, D2 = 5% of C2 only when common inputs are also used for non-business
 // purposes. With no turnover this month, the last month that had turnover is used (Rule 42(1)).
 let turnover:Awaited<ReturnType<typeof rule42Turnover>>|null=null,ratio=0,ratioSource="No common credit this month";
 const funeralTreatment=await funeralGstTreatment(db,scope.entityId,periodEnd);
 if(headsTotal(commonCredit)>0||sharedOverheadBills.length){
  turnover=await rule42Turnover(db,scope,period,period);
  if(turnover.total>0){ratio=turnover.exempt/turnover.total;ratioSource="This month's turnover is used";}
  else{const earlier=[...saved.keys()].filter(p=>p<period).reverse().map(p=>savedFigures(p)).find(f=>f&&f.rule42.totalTurnover>0);ratio=earlier?earlier.rule42.ratio:0;ratioSource=earlier?`No turnover this month; the ratio of ${earlier.period} is used (Rule 42)`:"No turnover this month or before it: no exempt share to reverse";}
 }
 const nonBusiness=input.nonBusinessCommonUse===true,d1=scaleHeads(commonCredit,ratio),d2=nonBusiness?scaleHeads(commonCredit,0.05):zeroHeads(),ruleReversal=addHeads(d1,d2);
 // Rules 37 and 37A: credit taken on a bill is reversed while the supplier is unpaid 180 days after the invoice (37), or while the
 // supplier has not filed GSTR-3B by 30 September after the year (37A); it is re-claimed once paid / filed. One reversal at a time.
 const reversals:ItcComputation["rule37"]["reversals"]=[],reclaims:ItcComputation["rule37"]["reclaims"]=[],watch:BillRef[]=[];
 const ratioOf=(p:string)=>p===period?ratio:savedFigures(p)?.rule42.ratio??ratio;
 for(const b of bills){
  if(num(b.reverse_charge)===1||!CREDITABLE.has(text(b.itc_treatment))||!billHasSplit(b))continue;
  const markReg=text(b.itc_registration_id);if(markReg&&markReg!==scope.registrationId)continue;
  const marked=text(b.itc_claimed_period),claimedIn=creditedNow.has(text(b.id))?period:marked&&marked<period&&savedFigures(marked)?.credited.some(c=>c.billId===text(b.id))?marked:"";if(!claimedIn)continue;
  const inv=text(b.supplier_invoice_date)||text(b.bill_date),paid=text(b.paid_to_supplier_on),tax=billTax(b),expenseAccount=billExpenseAccount(b.category_code);
  const retained=text(b.itc_treatment)==="common_rule_42"?scaleHeads(tax,1-ratioOf(claimedIn)):tax,base={...ref(b,tax),amount:retained,expenseAccount,claimedIn};
  for(const rule of["rule37","rule37a"] as const){
   const reversedIn=text(b[`${rule}_reversed_period`]),reclaimedIn=text(b[`${rule}_reclaimed_period`]),other=rule==="rule37"?"rule37a":"rule37",otherActive=Boolean(text(b[`${other}_reversed_period`])&&text(b[`${other}_reversed_period`])!==period&&!text(b[`${other}_reclaimed_period`]))||reversals.some(r=>r.billId===text(b.id));
   if(!reversedIn||reversedIn===period){
    if(otherActive)continue;
    if(rule==="rule37"){const due=rule37DueMonth(inv);if((due>claimedIn?due:claimedIn)<=period&&(!paid||paid>periodEnd)){reversals.push({...base,rule,dueBy:addDays(inv,180),note:`Supplier not paid within 180 days of the invoice (by ${addDays(inv,180)})`});marks.rule37Reversed.push(text(b.id));}}
    else{const flagged=text(b.rule37a_flagged_on),cleared=text(b.rule37a_cleared_on);if(flagged&&flagged<=periodEnd&&(!cleared||cleared>periodEnd)){if(period>=rule37aFromMonth(inv)){reversals.push({...base,rule,note:`Supplier has not filed GSTR-3B for the invoice (30 September ${fyStartYear(inv)+1} passed): ${text(b.rule37a_note)}`});marks.rule37aReversed.push(text(b.id));}else watch.push(ref(b,tax,`Rule 37A watch: reverse from the return for ${rule37aFromMonth(inv)} if the supplier still has not filed GSTR-3B`));}}
    continue;
   }
   if(reversedIn<period&&(!reclaimedIn||reclaimedIn===period)){
    const settled=rule==="rule37"?Boolean(paid&&paid<=periodEnd):Boolean(text(b.rule37a_cleared_on)&&text(b.rule37a_cleared_on)<=periodEnd);
    if(settled){const earlier=savedFigures(reversedIn)?.rule37.reversals.find(r=>r.billId===text(b.id)&&(r.rule??"rule37")===rule);reclaims.push({...base,rule,amount:earlier?readHeads(earlier.amount):retained,reversedIn,note:rule==="rule37"?`Supplier paid on ${paid}: credit re-claimed (4(D)(1))`:"Supplier filed GSTR-3B: credit re-claimed (4(D)(1))"});marks[rule==="rule37"?"rule37Reclaimed":"rule37aReclaimed"].push(text(b.id));}
   }
  }
 }
 const reversed=reversals.reduce((s,r)=>addHeads(s,r.amount),zeroHeads()),reclaimed=reclaims.reduce((s,r)=>addHeads(s,r.amount),zeroHeads());
 t4.a5_allOther=addHeads(t4.a5_allOther,reclaimed);t4.d1_reclaimed=reclaimed;
 t4.b1_rules42_43_s17_5=addHeads(ruleReversal,blockedReported);t4.b2_others=reversed;
 // An annual Rule 42 true-up Finance chose to settle in this month: more reversal adds to 4(B)(1), less is credited in 4(A)(5).
 const trueUpRow=await db.prepare("SELECT financial_year,figures_json FROM finance_itc_rule42_trueups WHERE entity_id=? AND registration_id=? AND apply_period=?").bind(scope.entityId,scope.registrationId,period).first<Row>();
 let trueUp:ItcComputation["trueUp"]=null;
 if(trueUpRow){const difference=readHeads((JSON.parse(text(trueUpRow.figures_json)||"{}") as Row).difference);trueUp={financialYear:text(trueUpRow.financial_year),difference};for(const head of HEADS){if(difference[head]>0)t4.b1_rules42_43_s17_5[head]=round2(t4.b1_rules42_43_s17_5[head]+difference[head]);else t4.a5_allOther[head]=round2(t4.a5_allOther[head]-difference[head]);}}
 t4.c_net=subHeads(addHeads(addHeads(addHeads(t4.a1_importOfGoods,t4.a2_importOfServices),addHeads(t4.a3_reverseCharge,t4.a4_isd)),t4.a5_allOther),addHeads(t4.b1_rules42_43_s17_5,t4.b2_others));
 const tTotal=addHeads(addHeads(addHeads(ineligibleT1T2,blockedT3),taxableOnly),commonCredit);
 const sharedOverheadWarning=turnover&&turnover.exempt>0&&sharedOverheadBills.length?`PawSpace has exempt turnover this month (${turnover.exempt} of ${turnover.total}). ${sharedOverheadBills.length} bill(s) in categories that serve every service are credited in full as eligible; if they also serve the exempt supply, their GST is common credit under Rule 42: mark them "Common (Rule 42)" or confirm with the CA.`:null;
 return{entityId:scope.entityId,registrationId:scope.registrationId,period,gstin:reg.gstin,homeState:reg.homeState,table4:t4,netItc:t4.c_net,
  reverseCharge:{taxableValue:rcmTaxable,liability:rcmLiability,importOfServices:t4.a2_importOfServices,bills:rcmBills},
  rule42:{t_total:tTotal,t1t2_ineligible:ineligibleT1T2,t3_blocked:blockedT3,c1_credited:addHeads(taxableOnly,commonCredit),t4_taxableOnly:taxableOnly,commonCredit,d1,d2,c3_retained:subHeads(commonCredit,ruleReversal),reversal:ruleReversal,nonBusinessCommonUse:nonBusiness,
   exemptTurnover:turnover?.exempt??0,totalTurnover:turnover?.total??0,ratio:Math.round(ratio*1e6)/1e6,source:ratioSource,funeralGstTreatment:turnover?.funeralGstTreatment??funeralTreatment,
   turnover:turnover?{taxable:turnover.taxable,canonicalInvoices:turnover.canonicalInvoices,exempt:turnover.exempt,funeral:turnover.funeral,funeralCounted:turnover.funeralCounted,notYetClassified:turnover.notYetClassified}:null,sharedOverheadWarning,
   note:"T = all input tax of the month; T1 + T2 = not eligible (non-business or exempt-only); T3 = blocked under 17(5); C1 = T - (T1 + T2 + T3); T4 = used only for taxable supplies; C2 = common credit; D1 = C2 x E / F; D2 = 5% of C2 only when common inputs are also used for non-business purposes; C3 = C2 - (D1 + D2). E excludes Schedule III values and interest on deposits; F counts what PawSpace makes (its commission on provider-delivered bookings). Supplies the owner has not classified yet are in neither."},
  rule37:{reversals,reclaims,reversed,reclaimed,watch},blocked:{reported:blockedReported,bills:blockedBills},trueUp,credited,
  notCredited:{waitingForGstr2b:waiting,needsComponentSplit:needsSplit,awaitingApproval:awaiting,timeBarred,placeOfSupply:posBills},marks};
}
const figuresChecksum=(f:ItcComputation)=>sha256(JSON.stringify({t:f.table4,r:f.reverseCharge.liability,rb:f.reverseCharge.bills.map(b=>b.billId),c:f.rule42.commonCredit,ra:f.rule42.ratio,d2:f.rule42.d2,r37:f.rule37.reversals.map(r=>[r.rule,r.billId,r.amount]),r37c:f.rule37.reclaims.map(r=>[r.rule,r.billId,r.amount]),m:f.marks,tu:f.trueUp}));
export async function setoffRecorded(db:Db,scope:Scope,period:string){const row=await db.prepare("SELECT id FROM finance_gst_setoff_payments WHERE entity_id=? AND registration_id=? AND period_code=? LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();return Boolean(row);}
/** Where a month's reversals should stand in the books: Rule 42 to its expense; Rules 37 / 37A to each bill's expense, and back. */
function reversalTarget(f:ItcComputation){
 const lines:PostingLine[]=[];
 const reverse=(amount:Heads,debitAccount:string)=>{const total=headsTotal(amount);if(total<=0)return;lines.push({account:debitAccount,debit:total,credit:0});for(const head of HEADS)if(amount[head])lines.push({account:INPUT_TAX_ACCOUNTS[head],debit:0,credit:amount[head]});};
 reverse(f.rule42.reversal,RULE42_EXPENSE_ACCOUNT);
 for(const r of f.rule37.reversals)reverse(r.amount,r.expenseAccount);
 // Credit that can never be taken (4(D)(2): section 16(4) time limit or another state's place of supply) leaves input tax for the
 // bill's expense, like a blocked credit.
 for(const r of[...f.notCredited.timeBarred,...f.notCredited.placeOfSupply])if(r.expenseAccount)reverse(r.tax,r.expenseAccount);
 for(const r of f.rule37.reclaims){const total=headsTotal(r.amount);if(total<=0)continue;for(const head of HEADS)if(r.amount[head])lines.push({account:INPUT_TAX_ACCOUNTS[head],debit:r.amount[head],credit:0});lines.push({account:r.expenseAccount,debit:0,credit:total});}
 return netByAccount(lines);
}
const entryDateFor=(period:string)=>{const last=lastDayOf(period),today=istToday();return last<today?last:today;};
const MARK_COLUMNS:Array<[keyof ItcComputation["marks"],string]>=[["itcClaimed","itc_claimed_period"],["rcmReported","rcm_reported_period"],["rule37Reversed","rule37_reversed_period"],["rule37Reclaimed","rule37_reclaimed_period"],["rule37aReversed","rule37a_reversed_period"],["rule37aReclaimed","rule37a_reclaimed_period"]];
/**
 * Saves the month's computation as a new version (idempotent when nothing changed), marks the bills it took, and posts the
 * difference between this version's Rule 42 / 37 / 37A reversals and what is already posted for the month, all in one batch.
 * Refused for a locked month, a month whose GST payment is recorded, and a month before one already saved.
 */
export async function saveItcComputation(db:Db,input:Scope&{periodCode:string;reason:string;nonBusinessCommonUse?:boolean},actor:string){
 await ensureInputTaxTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},period=text(input.periodCode),reason=text(input.reason);
 if(!isPeriod(period))throw refuse("The month must be YYYY-MM",400);
 if(reason.length<8)throw refuse("A clear reason of at least 8 characters is required",400);
 if(period>istToday().slice(0,7))throw refuse(`${period} has not started yet`,400);
 if(await periodLocked(db,period))throw refuse(`${period} is closed and locked; its input tax credit can no longer change`);
 if(await setoffRecorded(db,scope,period))throw refuse(`The GST for ${period} is already paid; its input tax credit is final. Anything new is credited in a later month`);
 const later=await db.prepare("SELECT period_code FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code>? ORDER BY period_code LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();
 if(later)throw refuse(`The input tax credit of ${text(later.period_code)} is already saved; a month before it can no longer change`);
 const figures=await computeItc(db,{...scope,period,nonBusinessCommonUse:input.nonBusinessCommonUse===true}),checksum=await figuresChecksum(figures);
 const latest=await db.prepare("SELECT * FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code=? ORDER BY version DESC LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();
 if(latest&&text(latest.checksum)===checksum)return{id:text(latest.id),version:num(latest.version),period,figures:computationFigures(latest)??figures,journalGroup:text(latest.journal_group)||null,journal:[] as PostingLine[],duplicatePrevented:true};
 const version=num(latest?.version)+1,computationId=idOf("itc"),now=Date.now(),sourceId=`${scope.entityId}:${scope.registrationId}:${period}`;
 const postedRows=(await db.prepare("SELECT account_code,COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) net FROM finance_journal_entries WHERE source_type='itc_computation' AND source_id=? GROUP BY account_code").bind(sourceId).all<Row>()).results;
 const lines=deltaLines(reversalTarget(figures),new Map(postedRows.map(r=>[text(r.account_code),round2(num(r.net))])));
 const billsInScope="entity_id=? AND (itc_registration_id IS NULL OR itc_registration_id=?)",extra:D1PreparedStatement[]=[];
 for(const[,column]of MARK_COLUMNS)extra.push(db.prepare(`UPDATE finance_bills SET ${column}=NULL WHERE ${billsInScope} AND ${column}=?`).bind(scope.entityId,scope.registrationId,period));
 // The marks are written in the same batch as the computation row, so each chunk is a prepared statement, not a read.
 for(const[key,column]of MARK_COLUMNS)extra.push(...await chunkedIn(figures.marks[key],async(chunk,placeholders)=>[db.prepare(`UPDATE finance_bills SET ${column}=?,itc_registration_id=? WHERE ${billsInScope} AND id IN (${placeholders})`).bind(period,scope.registrationId,scope.entityId,scope.registrationId,...chunk)]));
 const journalGroup=lines.length?`itc-${computationId}`:null;
 extra.push(db.prepare("INSERT INTO finance_itc_computations (id,entity_id,registration_id,period_code,version,figures_json,checksum,journal_group,reason,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(computationId,scope.entityId,scope.registrationId,period,version,JSON.stringify(figures),checksum,journalGroup,reason,actor,now));
 extra.push(await audit(db,actor,"itc_computation",computationId,"saved",{period,version,netItc:figures.netItc,rule42:figures.rule42.reversal,rule37Reversed:figures.rule37.reversed,rule37Reclaimed:figures.rule37.reclaimed,reverseCharge:figures.reverseCharge.liability,journal:lines},reason));
 await postClaimedJournal(db,{claimType:"itc_computation",claimKey:`${sourceId}#v${version}`,sourceType:"itc_computation",sourceId,entityId:scope.entityId,entryDate:entryDateFor(period),narration:`Input tax credit ${period} (version ${version}): Rule 42, 37 and 37A reversals and re-claims`,lines,extra});
 return{id:computationId,version,period,figures,journalGroup,journal:lines,duplicatePrevented:false};
}
/**
 * The saved net ITC (Table 4(C)) of a range of months, by head: what the monthly close, the statutory package and GSTR-9 / 9C
 * should report as eligible input tax (they still read the older vendor tax reviews; wiring them is an integration step).
 */
export async function netItcForPeriods(db:Db,input:Scope&{fromPeriod:string;toPeriod:string}){
 await ensureInputTaxTables(db);
 let net=zeroHeads();const months:string[]=[];
 for(const[p,row]of await latestComputations(db,{entityId:text(input.entityId),registrationId:text(input.registrationId)}))if(p>=text(input.fromPeriod)&&p<=text(input.toPeriod)){const f=computationFigures(row);if(f){net=addHeads(net,readHeads(f.netItc));months.push(p);}}
 return{netItc:net,total:headsTotal(net),monthsSaved:months};
}
/**
 * Input tax credit for the reports that predate the purchase register (statutory package, monthly close, GSTR-9, GSTR-9C): a month
 * whose ITC computation Finance has saved uses it (what GSTR-3B files and the set-off pays); any other month keeps the older
 * reviewed-bill figure, given per month (YYYY-MM) by the caller. Scoped to an entity / registration when they are named.
 */
export async function reportItc(db:Db,input:{entityId?:string|null;registrationId?:string|null;fromPeriod:string;toPeriod:string;legacyByMonth:Map<string,number>}){
 const saved=new Map<string,number>();
 if(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_itc_computations'").first()){
  const entityId=text(input.entityId),registrationId=text(input.registrationId),binds:string[]=[text(input.fromPeriod),text(input.toPeriod)];
  const rows=(await db.prepare(`SELECT entity_id,registration_id,period_code,version,figures_json FROM finance_itc_computations WHERE period_code BETWEEN ? AND ?${entityId?" AND entity_id=?":""}${registrationId?" AND registration_id=?":""} ORDER BY entity_id,registration_id,period_code,version`).bind(...binds,...(entityId?[entityId]:[]),...(registrationId?[registrationId]:[])).all<Row>()).results;
  const latest=new Map<string,Row>();for(const r of rows)latest.set(`${text(r.entity_id)}|${text(r.registration_id)}|${text(r.period_code)}`,r);
  for(const r of latest.values()){const f=computationFigures(r);if(!f)continue;const p=text(r.period_code);saved.set(p,round2((saved.get(p)??0)+headsTotal(readHeads(f.netItc))));}
 }
 let total=0;for(const p of new Set([...input.legacyByMonth.keys(),...saved.keys()]))total+=saved.has(p)?saved.get(p)!:num(input.legacyByMonth.get(p));
 return{total:round2(total),monthsFromComputation:[...saved.keys()].sort()};
}
/** The saved computation (if any) and a live recomputation, with whether the saved one is still current. */
export async function itcSummary(db:Db,input:Scope&{period:string}){
 await ensureInputTaxTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},period=text(input.period);
 if(!isPeriod(period))throw refuse("The month must be YYYY-MM",400);
 const latest=await db.prepare("SELECT * FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code=? ORDER BY version DESC LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();
 const frozen=await setoffRecorded(db,scope,period),later=await db.prepare("SELECT 1 x FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code>? LIMIT 1").bind(scope.entityId,scope.registrationId,period).first<Row>();
 const final=frozen||Boolean(later)||await periodLocked(db,period),savedFigures=computationFigures(latest);
 const live=final&&latest?null:await computeItc(db,{...scope,period,nonBusinessCommonUse:savedFigures?.rule42.nonBusinessCommonUse===true});
 const current=latest&&live?text(latest.checksum)===await figuresChecksum(live):Boolean(latest);
 return{period,saved:latest?{id:text(latest.id),version:num(latest.version),preparedBy:text(latest.prepared_by),preparedAt:num(latest.prepared_at),reason:text(latest.reason),figures:savedFigures}:null,live,savedIsCurrent:current,final,
  explanation:final?"This month is final (its GST is paid, a later month is saved, or the month is locked); the saved computation stands.":latest?(current?"The saved computation matches the purchase register.":"The purchase register changed since the computation was saved; save it again before paying."):"Not saved yet: save the computation before generating the GSTR-3B you will pay from."};
}
/**
 * Rule 42(2) annual true-up: C2 of the financial year x E / F of the year (+ D2 where it applied), against the monthly reversals
 * already made. The difference is posted now and reported in the month Finance chooses: more reversal in 4(B)(1), with interest
 * from 1 April (Rule 42(2)(a)); less reversal credited back in 4(A)(5). The rule's text once tied this to the September return
 * after the year; since the Finance Act 2022 aligned it with the amended section 16(4), the standard is the October return,
 * filed by 30 November after the year. One per year.
 */
export async function rule42AnnualTrueUp(db:Db,input:Scope&{financialYear:string;applyInPeriod:string;reason:string},actor:string){
 await ensureInputTaxTables(db);
 const scope={entityId:text(input.entityId),registrationId:text(input.registrationId)},startYear=Number(text(input.financialYear).slice(0,4)),apply=text(input.applyInPeriod),reason=text(input.reason);
 if(!Number.isInteger(startYear)||startYear<2017||startYear>2100)throw refuse("Choose the financial year (for example 2026 for 2026-27)",400);
 if(reason.length<8)throw refuse("A clear reason of at least 8 characters is required",400);
 const fy=`${startYear}-${String((startYear+1)%100).padStart(2,"0")}`,from=`${startYear}-04`,to=`${startYear+1}-03`;
 if(!isPeriod(apply)||apply<`${startYear+1}-04`||apply>`${startYear+1}-10`)throw refuse(`The true-up for ${fy} is reported in a month from April to October ${startYear+1} (the October return, due 30 November, is the standard deadline)`,400);
 if(apply>istToday().slice(0,7))throw refuse(`${apply} has not started yet`,400);
 await activeRegistration(db,scope,lastDayOf(apply));
 if(await periodLocked(db,apply))throw refuse(`${apply} is closed and locked`);
 if(await setoffRecorded(db,scope,apply))throw refuse(`The GST for ${apply} is already paid; choose a later month`);
 const later=await db.prepare("SELECT period_code FROM finance_itc_computations WHERE entity_id=? AND registration_id=? AND period_code>? LIMIT 1").bind(scope.entityId,scope.registrationId,apply).first<Row>();
 if(later)throw refuse(`The input tax credit of ${text(later.period_code)} is already saved; report the true-up in that month or later`);
 const saved=await latestComputations(db,scope);
 let commonCredit=zeroHeads(),monthly=zeroHeads(),annualD2=zeroHeads();const months:string[]=[];
 for(const[p,row]of saved)if(p>=from&&p<=to){const f=computationFigures(row);if(!f)continue;commonCredit=addHeads(commonCredit,readHeads(f.rule42.commonCredit));monthly=addHeads(monthly,readHeads(f.rule42.reversal));annualD2=addHeads(annualD2,readHeads(f.rule42.d2));months.push(p);}
 const turnover=await rule42Turnover(db,scope,from,to),ratio=turnover.total>0?turnover.exempt/turnover.total:0,annual=addHeads(scaleHeads(commonCredit,ratio),annualD2),difference=subHeads(annual,monthly);
 // deadlineNote: kept in the shape for compatibility, always null now that 30 November (the October return) is the
 // confirmed standard and the window check above already refuses anything reported later than that.
 const figures={financialYear:fy,commonCredit,exemptTurnover:turnover.exempt,totalTurnover:turnover.total,funeralGstTreatment:turnover.funeralGstTreatment,ratio:Math.round(ratio*1e6)/1e6,annualReversal:annual,monthlyReversals:monthly,difference,monthsSaved:months,applyInPeriod:apply,
  interestNote:headsTotal(difference)>0?`Interest under section 50 runs on the extra reversal from 1 April ${startYear+1} until it is paid (Rule 42(2)(a)); the GST payment for ${apply} shows it.`:null,deadlineNote:null as string|null};
 const prior=await db.prepare("SELECT * FROM finance_itc_rule42_trueups WHERE entity_id=? AND registration_id=? AND financial_year=?").bind(scope.entityId,scope.registrationId,fy).first<Row>();
 if(prior){const before=JSON.parse(text(prior.figures_json)||"{}") as Row;if(text(prior.apply_period)===apply&&JSON.stringify(readHeads(before.difference))===JSON.stringify(difference))return{id:text(prior.id),...figures,journalGroup:text(prior.journal_group)||null,duplicatePrevented:true};throw refuse(`The Rule 42 true-up for ${fy} is already posted (reported in ${text(prior.apply_period)}); correct it through a later month`);}
 const id=idOf("r42tu"),lines:PostingLine[]=[];
 for(const head of HEADS){const d=difference[head];if(d>0)lines.push({account:RULE42_EXPENSE_ACCOUNT,debit:d,credit:0},{account:INPUT_TAX_ACCOUNTS[head],debit:0,credit:d});else if(d<0)lines.push({account:INPUT_TAX_ACCOUNTS[head],debit:-d,credit:0},{account:RULE42_EXPENSE_ACCOUNT,debit:0,credit:-d});}
 const merged=deltaLines(netByAccount(lines),new Map());
 const extra=[db.prepare("INSERT INTO finance_itc_rule42_trueups (id,entity_id,registration_id,financial_year,apply_period,figures_json,journal_group,reason,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,scope.entityId,scope.registrationId,fy,apply,JSON.stringify(figures),merged.length?`r42-${id}`:null,reason,actor,Date.now()),await audit(db,actor,"rule42_true_up",id,"posted",figures,reason)];
 const posting=await postClaimedJournal(db,{claimType:"itc_rule42_trueup",claimKey:`${scope.entityId}:${scope.registrationId}:${fy}`,sourceType:"itc_rule42_trueup",sourceId:`${scope.entityId}:${scope.registrationId}:${fy}`,entityId:scope.entityId,entryDate:entryDateFor(apply),narration:`Rule 42 annual true-up ${fy}, reported in ${apply}`,lines:merged,extra});
 return{id,...figures,journalGroup:posting.journalGroup,duplicatePrevented:false};
}
/**
 * Rule 37A: Finance records that a supplier has not filed GSTR-3B for a bill's invoice (checked after 30 September following the
 * year), or that it has since filed. The monthly computation reverses the credit (4(B)(2)) and re-claims it once filed.
 */
export async function markSupplierGstr3b(db:Db,input:{billId:string;filed:boolean;reason:string;checkedOn?:string},actor:string){
 await ensureInputTaxTables(db);
 const reason=text(input.reason);if(reason.length<10)throw refuse("Say what was checked (at least 10 characters)",400);
 const checkedOn=text(input.checkedOn)||istToday();if(!isIsoDate(checkedOn)||checkedOn>istToday())throw refuse("The date checked must be a real date, not in the future",400);
 if(await periodLocked(db,checkedOn.slice(0,7)))throw refuse(`${checkedOn.slice(0,7)} is closed and locked; record the check with a date in an open month`);
 const bill=await db.prepare("SELECT * FROM finance_bills WHERE id=?").bind(text(input.billId)).first<Row>();
 if(!bill)throw refuse("Bill not found",404);
 if(num(bill.reverse_charge)===1)throw refuse("Rule 37A is about a supplier's own return; reverse-charge tax is paid by PawSpace");
 const today=checkedOn,flagged=text(bill.rule37a_flagged_on),cleared=text(bill.rule37a_cleared_on),now=Date.now();
 if(!input.filed){
  if(flagged&&!cleared)return{billId:text(bill.id),supplierGstr3bFiled:false,flaggedOn:flagged,duplicatePrevented:true};
  const changed=await db.prepare("UPDATE finance_bills SET rule37a_flagged_on=?,rule37a_note=?,rule37a_cleared_on=NULL,updated_at=? WHERE id=? AND (rule37a_flagged_on IS NULL OR rule37a_cleared_on IS NOT NULL)").bind(today,reason,now,text(bill.id)).run();
  if(!Number(changed.meta?.changes))throw refuse("The bill changed at the same time; refresh and try again");
 }else{
  if(!flagged)throw refuse("This bill is not marked as waiting for the supplier's GSTR-3B");
  if(cleared)return{billId:text(bill.id),supplierGstr3bFiled:true,clearedOn:cleared,duplicatePrevented:true};
  if(today<flagged)throw refuse(`The supplier was recorded as not filed on ${flagged}; the date it filed cannot be earlier`,400);
  const changed=await db.prepare("UPDATE finance_bills SET rule37a_cleared_on=?,updated_at=? WHERE id=? AND rule37a_flagged_on IS NOT NULL AND rule37a_cleared_on IS NULL").bind(today,now,text(bill.id)).run();
  if(!Number(changed.meta?.changes))throw refuse("The bill changed at the same time; refresh and try again");
 }
 await (await audit(db,actor,"vendor_bill",text(bill.id),input.filed?"supplier_gstr3b_filed":"supplier_gstr3b_not_filed",{rule37aFlaggedOn:input.filed?flagged:today,rule37aClearedOn:input.filed?today:null},reason,{rule37aFlaggedOn:flagged||null,rule37aClearedOn:cleared||null})).run();
 return{billId:text(bill.id),supplierGstr3bFiled:input.filed,[input.filed?"clearedOn":"flaggedOn"]:today,duplicatePrevented:false};
}

// ---------------------------------------------------------------------------------------------------------------------
// Purchase register read model
// ---------------------------------------------------------------------------------------------------------------------
export async function purchaseRegister(db:Db,input:{entityId?:string;month?:string;categoryCode?:string;treatment?:string;gstr2bStatus?:string}){
 await ensureInputTaxTables(db);
 const clauses:string[]=[],binds:unknown[]=[];
 if(text(input.entityId)){clauses.push("b.entity_id=?");binds.push(text(input.entityId));}
 if(text(input.month)){if(!isPeriod(text(input.month)))throw refuse("The month must be YYYY-MM",400);clauses.push("substr(COALESCE(b.supplier_invoice_date,b.bill_date),1,7)=?");binds.push(text(input.month));}
 if(text(input.categoryCode)){clauses.push("b.category_code=?");binds.push(text(input.categoryCode));}
 const treatment=text(input.treatment);
 if(treatment==="needs_split")clauses.push("b.cgst_amount IS NULL AND b.sgst_amount IS NULL AND b.igst_amount IS NULL AND b.cess_amount IS NULL AND b.gst_amount>0");
 else if(treatment){clauses.push("b.itc_treatment=?");binds.push(treatment);}
 if(text(input.gstr2bStatus)){clauses.push("COALESCE(b.gstr2b_status,'not_in_2b')=?");binds.push(text(input.gstr2bStatus));}
 const rows=(await db.prepare(`SELECT b.*,v.name vendor_name,v.gstin vendor_gstin FROM finance_bills b LEFT JOIN finance_vendors v ON v.id=b.vendor_id ${clauses.length?`WHERE ${clauses.join(" AND ")}`:""} ORDER BY COALESCE(b.supplier_invoice_date,b.bill_date) DESC,b.id LIMIT 500`).bind(...binds).all<Row>()).results;
 const items=rows.map(b=>{const split=billHasSplit(b),tax=split?billTax(b):null,category=text(b.category_code)?findExpenseCategory(text(b.category_code)):undefined,treatmentCode=text(b.itc_treatment);
  return{id:text(b.id),updatedAt:num(b.updated_at),status:text(b.status),entityId:text(b.entity_id),vendorId:text(b.vendor_id),supplier:text(b.vendor_name)||text(b.vendor_id),supplierGstin:billGstin(b)||null,supplierType:text(b.supplier_type)||null,supplierState:text(b.supplier_state_code)||(billGstin(b)?billGstin(b).slice(0,2):null),
   billNumber:text(b.bill_number),invoiceNumber:text(b.supplier_invoice_number)||text(b.bill_number),invoiceDate:text(b.supplier_invoice_date)||text(b.bill_date),billDate:text(b.bill_date),dueDate:text(b.due_date),placeOfSupply:text(b.place_of_supply)||null,sacCode:text(b.sac_code)||null,
   categoryCode:text(b.category_code)||null,category:category?.category??null,subCategory:category?.subCategory??null,taxableAmount:round2(num(b.taxable_amount)),gstAmount:round2(num(b.gst_amount)),totalAmount:round2(num(b.total_amount)),tax,reverseCharge:num(b.reverse_charge)===1,
   itcTreatment:treatmentCode||null,itcTreatmentLabel:treatmentCode?ITC_TREATMENT_LABELS[treatmentCode as ItcTreatment]??treatmentCode:null,itcClause:text(b.itc_clause)||null,itcReason:text(b.itc_reason)||null,needsComponentSplit:billNeedsSplit(b),
   gstr2bStatus:text(b.gstr2b_status)||"not_in_2b",gstr2bPeriod:text(b.gstr2b_period)||null,gstr2bNote:text(b.gstr2b_note)||null,paidToSupplierOn:text(b.paid_to_supplier_on)||null,itcClaimedPeriod:text(b.itc_claimed_period)||null,rcmReportedPeriod:text(b.rcm_reported_period)||null,rule37ReversedPeriod:text(b.rule37_reversed_period)||null,rule37ReclaimedPeriod:text(b.rule37_reclaimed_period)||null,
   supplierGstr3bNotFiledOn:text(b.rule37a_flagged_on)||null,supplierGstr3bFiledOn:text(b.rule37a_cleared_on)||null,rule37aReversedPeriod:text(b.rule37a_reversed_period)||null,taxLocked:billTaxLocked(b)};});
 const sum=(pick:(i:typeof items[number])=>number)=>round2(items.reduce((s,i)=>s+pick(i),0));
 const vendors=(await db.prepare("SELECT id,name,gstin FROM finance_vendors WHERE status='active' ORDER BY name LIMIT 500").all<Row>()).results.map(v=>({id:text(v.id),name:text(v.name),gstin:text(v.gstin).toUpperCase()||null}));
 return{items,totals:{bills:items.length,taxable:sum(i=>i.taxableAmount),cgst:sum(i=>i.tax?.cgst??0),sgst:sum(i=>i.tax?.sgst??0),igst:sum(i=>i.tax?.igst??0),cess:sum(i=>i.tax?.cess??0),needsComponentSplit:items.filter(i=>i.needsComponentSplit).length},
  taxonomy:expenseItcTaxonomy(),treatments:ITC_TREATMENTS.map(code=>({code,label:ITC_TREATMENT_LABELS[code]})),states:Object.entries(GST_STATES).map(([code,name])=>({code,name})),vendors};
}
export async function gstr2bImports(db:Db,input:{registrationId?:string;period?:string}){
 await ensureInputTaxTables(db);
 const clauses:string[]=[],binds:unknown[]=[];
 if(text(input.registrationId)){clauses.push("registration_id=?");binds.push(text(input.registrationId));}
 if(text(input.period)){clauses.push("return_period=?");binds.push(text(input.period));}
 const rows=(await db.prepare(`SELECT * FROM finance_gstr2b_imports ${clauses.length?`WHERE ${clauses.join(" AND ")}`:""} ORDER BY imported_at DESC LIMIT 12`).bind(...binds).all<Row>()).results;
 return rows.map(r=>({id:text(r.id),registrationId:text(r.registration_id),returnPeriod:text(r.return_period),invoices:num(r.invoice_count),matched:num(r.matched_count),importedBy:text(r.imported_by),importedAt:num(r.imported_at),result:(()=>{try{return JSON.parse(text(r.result_json)) as Row;}catch{return{};}})()}));
}
/** The bills a set of ids refers to, read in chunks (a D1 query binds at most 100 values). */
export async function billsByIds(db:Db,ids:string[]){return chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT * FROM finance_bills WHERE id IN (${placeholders})`).bind(...chunk).all<Row>()).results);}
