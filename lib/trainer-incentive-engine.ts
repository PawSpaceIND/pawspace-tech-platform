import { monthlyPetrolAllowance } from "./provider-daily-travel";
import { monthlySpecialIncentiveTotal, monthlyReviewIncentiveTotal } from "./employee-recognition-incentives";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export async function ensureTrainerIncentiveTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS trainer_meet_greet_conversions (id TEXT PRIMARY KEY,trainer_id TEXT NOT NULL,meet_greet_booking_id TEXT NOT NULL UNIQUE,converted_booking_id TEXT NOT NULL UNIQUE,converted_order_value REAL NOT NULL,incentive_amount REAL NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
]);}

export async function recordMeetGreetConversion(db:Db,input:{trainerId:string;meetGreetBookingId:string;convertedBookingId:string;actorId:string}){
 await ensureTrainerIncentiveTables(db);
 if(!text(input.trainerId)||!text(input.meetGreetBookingId)||!text(input.convertedBookingId))throw new Error("Trainer, the real Meet & Greet booking, and the real converted booking are all required");
 const meetGreet=await db.prepare("SELECT id,provider_id,customer_id,package_code FROM canonical_bookings WHERE id=?").bind(input.meetGreetBookingId).first<Row>();
 if(!meetGreet)throw new Error("Meet & Greet booking not found");
 if(String(meetGreet.provider_id)!==input.trainerId)throw new Error("Meet & Greet booking is not assigned to this trainer");
 if(String(meetGreet.package_code)!=="trainer-meet-greet")throw new Error("Referenced booking is not a real Meet & Greet package");
 const converted=await db.prepare("SELECT id,provider_id,customer_id,total_amount,package_code FROM canonical_bookings WHERE id=?").bind(input.convertedBookingId).first<Row>();
 if(!converted)throw new Error("Converted booking not found");
 if(String(converted.provider_id)!==input.trainerId)throw new Error("Converted booking is not assigned to this trainer");
 if(String(converted.customer_id)!==String(meetGreet.customer_id))throw new Error("Converted booking belongs to a different customer than the Meet & Greet - cannot record as a conversion");
 if(String(converted.package_code)==="trainer-meet-greet")throw new Error("The converted booking must be a real training programme, not another Meet & Greet");
 const orderValue=Number(converted.total_amount),incentiveAmount=orderValue>10000?1000:500,now=Date.now();
 await db.prepare("INSERT INTO trainer_meet_greet_conversions (id,trainer_id,meet_greet_booking_id,converted_booking_id,converted_order_value,incentive_amount,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?)")
   .bind(uid("TMG"),input.trainerId,input.meetGreetBookingId,input.convertedBookingId,orderValue,incentiveAmount,input.actorId,now).run();
 return{trainerId:input.trainerId,meetGreetBookingId:input.meetGreetBookingId,convertedBookingId:input.convertedBookingId,convertedOrderValue:orderValue,incentiveAmount};
}

async function monthlyOrderValue(db:Db,trainerId:string,monthStartDate:string,monthEndDate:string){
 const row=await db.prepare("SELECT COALESCE(SUM(total_amount),0) total FROM canonical_bookings WHERE provider_id=? AND service_code='dog_training' AND status='completed' AND package_code!='trainer-meet-greet' AND date(scheduled_start)>=? AND date(scheduled_start)<=?")
   .bind(trainerId,monthStartDate,monthEndDate).first<Row>();
 return money(row?.total);
}

export async function computeTrainerMonthlyIncentive(db:Db,input:{trainerId:string;monthStart:string;actorId:string}){
 await ensureTrainerIncentiveTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 const[year,month]=input.monthStart.split("-").map(Number);
 // Built in UTC. `new Date(year,month,0)` is midnight LOCAL, so in any timezone ahead of UTC (IST
 // included) toISOString() rolls back a day and the last day of the month silently dropped out of the
 // window: identical data returned achievedValue 500000 / incentive 8500 under TZ=UTC and 250000 / 4500
 // under TZ=Asia/Kolkata - a 47% underpayment, because the monthly ladder is tiered so the loss is a
 // step, not a shave. lib/grooming-incentive-engine.ts already carried this fix; its three siblings did
 // not.
 const monthEndDate=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);

 const orderValue=await monthlyOrderValue(db,input.trainerId,input.monthStart,monthEndDate);
 const revenueIncentive=orderValue>140000?money((orderValue-140000)*0.20):0;

 const conversions=await db.prepare("SELECT * FROM trainer_meet_greet_conversions WHERE trainer_id=? AND recorded_at>=? AND recorded_at<=?")
   .bind(input.trainerId,new Date(`${input.monthStart}T00:00:00Z`).getTime(),new Date(`${monthEndDate}T23:59:59Z`).getTime()).all<Row>();
 const meetGreetIncentive=money(conversions.results.reduce((s,c)=>s+Number(c.incentive_amount),0));

 const petrol=await monthlyPetrolAllowance(db,{providerId:input.trainerId,monthStartDate:input.monthStart,monthEndDate});
 const specialIncentive=await monthlySpecialIncentiveTotal(db,{employeeId:input.trainerId,monthStart:input.monthStart});
 const review=await monthlyReviewIncentiveTotal(db,{employeeId:input.trainerId,monthStartDate:input.monthStart,monthEndDate});

 const total=money(revenueIncentive+meetGreetIncentive+petrol.totalAllowance+specialIncentive+review.total);

 return{
   trainerId:input.trainerId,monthStart:input.monthStart,orderValue,
   revenueIncentive,meetGreetConversionCount:conversions.results.length,meetGreetIncentive,
   petrolAllowance:petrol.totalAllowance,petrolQualifyingDays:petrol.qualifyingDayCount,
   specialIncentive,reviewIncentive:review.total,reviewCount:review.count,
   total,
 };
}
