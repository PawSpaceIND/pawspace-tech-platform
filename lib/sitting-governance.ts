import{governedJsonError}from"./governed-http-error";
import{splitPaymentPlan}from"./stay-split-payments";
type Row=Record<string,unknown>;
export type SittingMode="visit"|"overnight";
export type SittingPaymentMode="prepaid"|"split_50_50";
export type SittingQuote={quoteId:string;packageCode:string;packageName:string;packageVersion:number;mode:SittingMode;petCount:number;cityId:string;zoneId:string;scheduledStart:string;scheduledEnd:string;billableUnits:number;basePricePerPet:number;extraPetPrice:number;totalAmount:number;amountDueNow:number;paymentMode:SittingPaymentMode;expiresAt:number};

const packages=[
 {code:"sitting-visit-60",name:"Home Visit",mode:"visit",basePrice:399,extraPetPrice:149,maxPets:4},
 {code:"sitting-overnight",name:"Overnight Pet Sitting",mode:"overnight",basePrice:799,extraPetPrice:399,maxPets:4},
] as const;

async function ensureQuoteColumn(db:D1Database,column:string,definition:string){
 const columns=await db.prepare("PRAGMA table_info(sitting_commercial_quotes)").all<Row>();
 if(columns.results.some(row=>String(row.name)===column))return;
 try{await db.prepare(`ALTER TABLE sitting_commercial_quotes ADD COLUMN ${column} ${definition}`).run();}
 catch(error){const after=await db.prepare("PRAGMA table_info(sitting_commercial_quotes)").all<Row>();if(!after.results.some(row=>String(row.name)===column))throw error;}
}

export async function ensureSittingGovernanceTables(db:D1Database){
 const now=Date.now();
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS sitting_commercial_packages (package_code TEXT PRIMARY KEY,name TEXT NOT NULL,mode TEXT NOT NULL,base_price_per_pet REAL NOT NULL,extra_pet_price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',max_pets INTEGER NOT NULL DEFAULT 4,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS sitting_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,mode TEXT NOT NULL,pet_count INTEGER NOT NULL,city_id TEXT NOT NULL DEFAULT 'blr',zone_id TEXT NOT NULL DEFAULT 'blr-east',scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,billable_units INTEGER NOT NULL,payment_mode TEXT NOT NULL,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_sitting_quote_expiry ON sitting_commercial_quotes(status,expires_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS sitting_booking_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
 ]);
 await ensureQuoteColumn(db,"city_id","TEXT NOT NULL DEFAULT 'blr'");
 await ensureQuoteColumn(db,"zone_id","TEXT NOT NULL DEFAULT 'blr-east'");
 for(const item of packages)await db.prepare("INSERT OR IGNORE INTO sitting_commercial_packages (package_code,name,mode,base_price_per_pet,extra_pet_price,currency,max_pets,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,'INR',?,1,1,'2026-08-01',NULL,'founder_seed',?)").bind(item.code,item.name,item.mode,item.basePrice,item.extraPetPrice,item.maxPets,now).run();
}

function activePackage(row:Row,at:string){const date=at.slice(0,10);return Number(row.active)===1&&date>=String(row.effective_from)&&(!row.effective_to||date<=String(row.effective_to));}
function units(mode:SittingMode,start:string,end:string){const startMs=new Date(start).getTime(),endMs=new Date(end).getTime();if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)throw governedJsonError({error:"Sitting quote requires a valid future care window"},400);if(startMs<=Date.now())throw governedJsonError({error:"Sitting quote requires a future start"},400);const hours=(endMs-startMs)/3_600_000;if(mode==="visit"){if(hours>24)throw governedJsonError({error:"Home Visit quotes must cover a single service day"},409);return 1;}if(hours<=10)throw governedJsonError({error:"Overnight Sitting requires more than 10 hours"},409);return Math.max(1,Math.ceil(hours/24));}

export async function listSittingPackages(db:D1Database,at=new Date().toISOString()){await ensureSittingGovernanceTables(db);const date=at.slice(0,10);const rows=await db.prepare("SELECT package_code,name,mode,base_price_per_pet,extra_pet_price,currency,max_pets,version FROM sitting_commercial_packages WHERE active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY base_price_per_pet").bind(date,date).all<Row>();return rows.results;}

export async function createSittingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:SittingPaymentMode;couponCode?:string;cityId?:string;zoneId?:string}){
 await ensureSittingGovernanceTables(db);
 if(input.paymentMode!=="prepaid"&&input.paymentMode!=="split_50_50")throw governedJsonError({error:"Sitting supports full prepaid or the approved 50/50 split payment"},409);
 if(String(input.couponCode||"").trim())throw governedJsonError({error:"Sitting coupon policy is not enabled in the canonical catalogue"},409);
 const row=await db.prepare("SELECT * FROM sitting_commercial_packages WHERE package_code=?").bind(input.packageCode).first<Row>();
 if(!row||!activePackage(row,input.scheduledStart))throw governedJsonError({error:"Active Sitting package not found for this date"},404);
 const petCount=Math.floor(Number(input.petCount));if(petCount<1||petCount>Number(row.max_pets))throw governedJsonError({error:`Sitting supports 1-${Number(row.max_pets)} pets per booking`},409);
 const mode=String(row.mode) as SittingMode,cityId=String(input.cityId||"blr"),zoneId=String(input.zoneId||"blr-east"),billableUnits=units(mode,input.scheduledStart,input.scheduledEnd),basePricePerPet=Number(row.base_price_per_pet),extraPetPrice=Number(row.extra_pet_price),unitAmount=basePricePerPet+Math.max(0,petCount-1)*extraPetPrice,totalAmount=unitAmount*billableUnits,amountDueNow=input.paymentMode==="split_50_50"?splitPaymentPlan({totalAmount,scheduledStart:input.scheduledStart}).dueNow:totalAmount,now=Date.now(),expiresAt=now+15*60_000,id=`SQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT INTO sitting_commercial_quotes (id,package_code,package_version,mode,pet_count,city_id,zone_id,scheduled_start,scheduled_end,billable_units,payment_mode,total_amount,amount_due_now,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)").bind(id,row.package_code,row.version,mode,petCount,cityId,zoneId,input.scheduledStart,input.scheduledEnd,billableUnits,input.paymentMode,totalAmount,amountDueNow,expiresAt,now).run();
 return{quoteId:id,packageCode:String(row.package_code),packageName:String(row.name),packageVersion:Number(row.version),mode,petCount,cityId,zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,billableUnits,basePricePerPet,extraPetPrice,totalAmount,amountDueNow,paymentMode:input.paymentMode,expiresAt} satisfies SittingQuote;
}

export async function governSittingBooking(db:D1Database,input:{quoteId:string;packageCode:string;packageName:string;petCount:number;cityId?:string;zoneId?:string;scheduledStart:string;scheduledEnd:string;submittedTotal:number;submittedAmountDueNow:number;paymentMode:string;paymentStatus:string;reservationCount:number}){
 await ensureSittingGovernanceTables(db);
 const linked=await db.prepare("SELECT booking_id FROM sitting_booking_quote_links WHERE quote_id=?").bind(input.quoteId).first<Row>();if(linked)throw governedJsonError({error:"Sitting quote is already linked to a booking"},409);
 const quote=await db.prepare("SELECT q.*,p.name,p.base_price_per_pet,p.extra_pet_price FROM sitting_commercial_quotes q JOIN sitting_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=?").bind(input.quoteId).first<Row>();
 if(!quote)throw governedJsonError({error:"A valid server Sitting quote is required"},409);if(String(quote.status)!=="open")throw governedJsonError({error:"Sitting quote has already been used"},409);if(Number(quote.expires_at)<Date.now())throw governedJsonError({error:"Sitting quote expired; refresh price and availability"},409);
 if(String(quote.package_code)!==input.packageCode||String(quote.name)!==input.packageName)throw governedJsonError({error:"Sitting package does not match the server quote"},409);if(Number(quote.pet_count)!==input.petCount)throw governedJsonError({error:"Sitting pet count changed after quote"},409);if(String(quote.city_id)!==String(input.cityId||"blr")||String(quote.zone_id)!==String(input.zoneId||"blr-east"))throw governedJsonError({error:"Sitting quote city/zone does not match the scheduling reservation"},409);if(String(quote.scheduled_start)!==input.scheduledStart||String(quote.scheduled_end)!==input.scheduledEnd)throw governedJsonError({error:"Sitting care window changed after quote"},409);if(Number(quote.total_amount)!==input.submittedTotal||Number(quote.amount_due_now)!==input.submittedAmountDueNow)throw governedJsonError({error:"Sitting amount does not match the server quote"},409);if(String(quote.payment_mode)!==input.paymentMode)throw governedJsonError({error:"Sitting payment mode does not match the server quote"},409);if(input.paymentStatus!=="captured")throw governedJsonError({error:"Sitting payment must be captured in sandbox before confirmation"},409);if(input.reservationCount!==1)throw governedJsonError({error:"Sitting Gate 1 requires exactly one canonical care reservation"},409);
 return{quoteId:String(quote.id),packageCode:String(quote.package_code),packageName:String(quote.name),catalogueVersion:`sitting-v${Number(quote.package_version)}`,mode:String(quote.mode) as SittingMode,petCount:Number(quote.pet_count),scheduledStart:String(quote.scheduled_start),scheduledEnd:String(quote.scheduled_end),billableUnits:Number(quote.billable_units),basePricePerPet:Number(quote.base_price_per_pet),extraPetPrice:Number(quote.extra_pet_price),totalAmount:Number(quote.total_amount),amountDueNow:Number(quote.amount_due_now),paymentMode:String(quote.payment_mode)};
}

export function sittingQuoteLinkStatement(db:D1Database,quoteId:string,bookingId:string){return db.prepare("INSERT INTO sitting_booking_quote_links (quote_id,booking_id,created_at) VALUES (?,?,?)").bind(quoteId,bookingId,Date.now());}
export async function consumeSittingQuote(db:D1Database,quoteId:string,bookingId:string){const result=await db.prepare("UPDATE sitting_commercial_quotes SET status='used',used_at=?,used_booking_id=? WHERE id=? AND status='open'").bind(Date.now(),bookingId,quoteId).run();if(!result.meta.changes)throw governedJsonError({error:"Sitting quote could not be consumed"},409);}
