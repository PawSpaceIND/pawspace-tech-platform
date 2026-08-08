type Row=Record<string,unknown>;
export type WalkingDuration=30|60;
export type WalkingQuote={quoteId:string;packageCode:string;packageName:string;packageVersion:number;durationMinutes:WalkingDuration;petCount:number;scheduledStart:string;scheduledEnd:string;totalAmount:number;amountDueNow:number;paymentMode:"prepaid";expiresAt:number};

const packages=[
 {code:"walking-solo-30",name:"Solo Dog Walk · 30 min",durationMinutes:30,basePrice:349,extraPetPrice:149,maxPets:2},
 {code:"walking-solo-60",name:"Solo Dog Walk · 60 min",durationMinutes:60,basePrice:549,extraPetPrice:199,maxPets:2},
] as const;

export async function ensureWalkingGovernanceTables(db:D1Database){const now=Date.now();await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS walking_commercial_packages (package_code TEXT PRIMARY KEY,name TEXT NOT NULL,duration_minutes INTEGER NOT NULL,base_price REAL NOT NULL,extra_pet_price REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',max_pets INTEGER NOT NULL DEFAULT 2,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS walking_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,duration_minutes INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,payment_mode TEXT NOT NULL,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_walking_quote_expiry ON walking_commercial_quotes(status,expires_at)"),
 db.prepare("CREATE TABLE IF NOT EXISTS walking_booking_quote_links (quote_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
 ]);for(const item of packages)await db.prepare("INSERT OR IGNORE INTO walking_commercial_packages (package_code,name,duration_minutes,base_price,extra_pet_price,currency,max_pets,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,'INR',?,1,1,'2026-08-01',NULL,'uat_seed',?)").bind(item.code,item.name,item.durationMinutes,item.basePrice,item.extraPetPrice,item.maxPets,now).run();}

function activePackage(row:Row,at:string){const date=at.slice(0,10);return Number(row.active)===1&&date>=String(row.effective_from)&&(!row.effective_to||date<=String(row.effective_to));}
export async function listWalkingPackages(db:D1Database,at=new Date().toISOString()){await ensureWalkingGovernanceTables(db);const date=at.slice(0,10);const rows=await db.prepare("SELECT package_code,name,duration_minutes,base_price,extra_pet_price,currency,max_pets,version FROM walking_commercial_packages WHERE active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY duration_minutes").bind(date,date).all<Row>();return rows.results;}

export async function createWalkingQuote(db:D1Database,input:{packageCode:string;petCount:number;scheduledStart:string;scheduledEnd:string;paymentMode:"prepaid";recurring?:boolean;couponCode?:string}){
 await ensureWalkingGovernanceTables(db);
 if(input.recurring)throw new Response("Recurring Walking billing and cadence policy is not approved; Gate 1 supports one-time UAT walks only",{status:409});
 if(input.paymentMode!=="prepaid")throw new Response("Walking post-service charging is not approved; use full prepaid UAT payment",{status:409});
 if(String(input.couponCode||"").trim())throw new Response("Walking coupon policy is not enabled in the canonical catalogue",{status:409});
 const row=await db.prepare("SELECT * FROM walking_commercial_packages WHERE package_code=?").bind(input.packageCode).first<Row>();if(!row||!activePackage(row,input.scheduledStart))throw new Response("Active Walking package not found for this date",{status:404});
 const petCount=Math.floor(Number(input.petCount));if(petCount<1||petCount>Number(row.max_pets))throw new Response(`Walking supports 1-${Number(row.max_pets)} same-family pets per booking`,{status:409});
 const startMs=new Date(input.scheduledStart).getTime(),endMs=new Date(input.scheduledEnd).getTime(),durationMinutes=Number(row.duration_minutes) as WalkingDuration;if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<=Date.now()||endMs-startMs!==durationMinutes*60_000)throw new Response(`Walking ${durationMinutes}-minute package requires an exact future ${durationMinutes}-minute window`,{status:409});
 const base=Number(row.base_price),extra=Number(row.extra_pet_price),totalAmount=base+Math.max(0,petCount-1)*extra,now=Date.now(),expiresAt=now+15*60_000,id=`WQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.prepare("INSERT INTO walking_commercial_quotes (id,package_code,package_version,duration_minutes,pet_count,scheduled_start,scheduled_end,payment_mode,total_amount,amount_due_now,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?)").bind(id,row.package_code,row.version,durationMinutes,petCount,input.scheduledStart,input.scheduledEnd,input.paymentMode,totalAmount,totalAmount,expiresAt,now).run();
 return{quoteId:id,packageCode:String(row.package_code),packageName:String(row.name),packageVersion:Number(row.version),durationMinutes,petCount,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,totalAmount,amountDueNow:totalAmount,paymentMode:input.paymentMode,expiresAt} satisfies WalkingQuote;
}
