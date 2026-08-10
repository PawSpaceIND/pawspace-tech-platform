type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type SalesVertical="training"|"grooming_outbound"|"grooming_inbound"|"grooming_both";

const dailyTiers:Record<SalesVertical,Array<{target:number;incentive:number}>>={
 training:[{target:25000,incentive:500},{target:36000,incentive:1000},{target:48000,incentive:1500},{target:60000,incentive:2000},{target:75000,incentive:2500}],
 grooming_outbound:[{target:20000,incentive:1000},{target:35000,incentive:1500},{target:50000,incentive:2500},{target:65000,incentive:3500}],
 grooming_inbound:[{target:25000,incentive:1000},{target:40000,incentive:1500},{target:55000,incentive:2500},{target:70000,incentive:3500}],
 // Only "pure outbound" allocation gets the lower 20k ladder. An employee allocated to BOTH inbound
 // and outbound defaults to the same 25k-start ladder as pure inbound, per explicit instruction -
 // deliberately not a blended/dynamic ladder, to keep this simple rather than guess at a formula.
 grooming_both:[{target:25000,incentive:1000},{target:40000,incentive:1500},{target:55000,incentive:2500},{target:70000,incentive:3500}],
};
const monthlyTiers:Record<SalesVertical,Array<{target:number;incentive:number}>>={
 training:[{target:300000,incentive:4500},{target:650000,incentive:8500},{target:750000,incentive:5000},{target:900000,incentive:6000}],
 grooming_outbound:[{target:250000,incentive:4500},{target:500000,incentive:8500},{target:600000,incentive:5000},{target:700000,incentive:6000}],
 grooming_inbound:[{target:300000,incentive:4500},{target:600000,incentive:8500},{target:600000,incentive:5000},{target:700000,incentive:6000}],
 grooming_both:[{target:300000,incentive:4500},{target:600000,incentive:8500},{target:600000,incentive:5000},{target:700000,incentive:6000}],
};
const blitzMultiplier=2;
const crossSellServiceCodes=["grooming","dog_training","boarding","pet_sitting"];

function bestTierReached(tiers:Array<{target:number;incentive:number}>,achieved:number){
 let best:{target:number;incentive:number}|null=null;
 for(const t of tiers)if(achieved>=t.target&&(!best||t.incentive>best.incentive))best=t;
 return best;
}

export async function ensureSalesIncentiveTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS sales_employee_base (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,base_vertical TEXT NOT NULL,effective_from TEXT NOT NULL,effective_until TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_sales_base_employee ON sales_employee_base(employee_id,effective_from)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sales_attributed_bookings (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS sales_blitz_days (id TEXT PRIMARY KEY,blitz_date TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
]);}

export async function saveSalesEmployeeBase(db:Db,input:{employeeId:string;baseVertical:SalesVertical;effectiveFrom:string;reason:string;actorId:string}){
 await ensureSalesIncentiveTables(db);
 if(!text(input.employeeId))throw new Error("Employee is required");
 if(!(input.baseVertical in dailyTiers))throw new Error("Unsupported base vertical - no published rate sheet exists for it yet");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom))throw new Error("A real effective-from date is required");
 if(input.reason.trim().length<8)throw new Error("A real reason is required to set or change an employee's sales base vertical");
 const now=Date.now();
 await db.prepare("UPDATE sales_employee_base SET effective_until=? WHERE employee_id=? AND effective_until IS NULL").bind(input.effectiveFrom,input.employeeId).run();
 const id=uid("SEB");
 await db.prepare("INSERT INTO sales_employee_base (id,employee_id,base_vertical,effective_from,effective_until,reason,actor_id,created_at) VALUES (?,?,?,?,NULL,?,?,?)")
   .bind(id,input.employeeId,input.baseVertical,input.effectiveFrom,input.reason.trim(),input.actorId,now).run();
 return{id,employeeId:input.employeeId,baseVertical:input.baseVertical,effectiveFrom:input.effectiveFrom};
}

export async function currentSalesBase(db:Db,employeeId:string,atDate:string){
 await ensureSalesIncentiveTables(db);
 const row=await db.prepare("SELECT * FROM sales_employee_base WHERE employee_id=? AND effective_from<=? AND (effective_until IS NULL OR effective_until>?) ORDER BY effective_from DESC LIMIT 1")
   .bind(employeeId,atDate,atDate).first<Row>();
 if(!row)return null;
 return{employeeId:String(row.employee_id),baseVertical:String(row.base_vertical) as SalesVertical,effectiveFrom:String(row.effective_from)};
}

export async function attributeBookingToSalesEmployee(db:Db,input:{bookingId:string;employeeId:string;actorId:string}){
 await ensureSalesIncentiveTables(db);
 if(!text(input.bookingId)||!text(input.employeeId))throw new Error("Booking and employee code are required");
 const booking=await db.prepare("SELECT id,service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
 if(!booking)throw new Error("Canonical booking not found");
 if(!crossSellServiceCodes.includes(String(booking.service_code)))throw new Error("This service is not eligible for sales-team attribution (Pet Taxi and other excluded services never credit an individual's sales number)");
 const existing=await db.prepare("SELECT employee_id FROM sales_attributed_bookings WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(existing)throw new Error("This booking is already attributed to an employee and cannot be reattributed");
 const now=Date.now();
 await db.prepare("INSERT INTO sales_attributed_bookings (id,booking_id,employee_id,recorded_by,recorded_at) VALUES (?,?,?,?,?)")
   .bind(uid("SAB"),input.bookingId,input.employeeId,input.actorId,now).run();
 return{bookingId:input.bookingId,employeeId:input.employeeId};
}

export async function saveSalesBlitzDay(db:Db,input:{blitzDate:string;reason:string;actorId:string}){
 await ensureSalesIncentiveTables(db);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.blitzDate))throw new Error("A real Blitz date is required");
 if(input.reason.trim().length<8)throw new Error("A real reason is required to announce a Blitz day");
 const now=Date.now();
 await db.prepare("INSERT INTO sales_blitz_days (id,blitz_date,reason,actor_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(blitz_date) DO NOTHING")
   .bind(uid("BLZ"),input.blitzDate,input.reason.trim(),input.actorId,now).run();
 return{blitzDate:input.blitzDate};
}

async function isBlitzDay(db:Db,date:string){
 const row=await db.prepare("SELECT 1 FROM sales_blitz_days WHERE blitz_date=?").bind(date).first<Row>();
 return Boolean(row);
}

async function attributedValueForDay(db:Db,employeeId:string,date:string){
 const row=await db.prepare("SELECT COALESCE(SUM(b.total_amount),0) total FROM sales_attributed_bookings s JOIN canonical_bookings b ON b.id=s.booking_id WHERE s.employee_id=? AND date(b.scheduled_start)=?")
   .bind(employeeId,date).first<Row>();
 return money(row?.total);
}

export async function computeDailySalesIncentive(db:Db,input:{employeeId:string;date:string;actorId:string}){
 await ensureSalesIncentiveTables(db);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date))throw new Error("A real date is required");
 const base=await currentSalesBase(db,input.employeeId,input.date);
 if(!base)throw new Error("This employee has no sales base vertical configured for this date");
 const achievedValue=await attributedValueForDay(db,input.employeeId,input.date);
 const tier=bestTierReached(dailyTiers[base.baseVertical],achievedValue);
 const blitz=await isBlitzDay(db,input.date);
 const incentive=tier?money(tier.incentive*(blitz?blitzMultiplier:1)):0;
 return{employeeId:input.employeeId,date:input.date,baseVertical:base.baseVertical,achievedValue,tierTarget:tier?.target??null,baseIncentive:tier?.incentive??0,blitz,incentive};
}

export async function computeMonthlySalesIncentive(db:Db,input:{employeeId:string;monthStart:string;actorId:string}){
 await ensureSalesIncentiveTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 const base=await currentSalesBase(db,input.employeeId,input.monthStart);
 if(!base)throw new Error("This employee has no sales base vertical configured for this month");
 const[year,month]=input.monthStart.split("-").map(Number);
 const monthEndDate=new Date(year,month,0).toISOString().slice(0,10);
 const row=await db.prepare("SELECT COALESCE(SUM(b.total_amount),0) total FROM sales_attributed_bookings s JOIN canonical_bookings b ON b.id=s.booking_id WHERE s.employee_id=? AND date(b.scheduled_start)>=? AND date(b.scheduled_start)<=?")
   .bind(input.employeeId,input.monthStart,monthEndDate).first<Row>();
 const achievedValue=money(row?.total);
 const tier=bestTierReached(monthlyTiers[base.baseVertical],achievedValue);
 return{employeeId:input.employeeId,monthStart:input.monthStart,baseVertical:base.baseVertical,achievedValue,tierTarget:tier?.target??null,incentive:tier?.incentive??0};
}
