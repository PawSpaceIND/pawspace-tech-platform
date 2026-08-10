type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export async function ensureEmployeeRecognitionTables(db:Db){await db.batch([
 // Generic one-time special incentive for ANY employee or contract employee, any role - the
 // grooming-specific groomer_special_incentives table predates this and stays as-is for grooming's
 // own reporting; this is the general version for every other role (Trainer, and anyone else).
 db.prepare("CREATE TABLE IF NOT EXISTS employee_special_incentives (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,month_start TEXT NOT NULL,amount REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 // Google review bonus - a real range (100-200), not a fixed formula, so the actual amount is
 // always an explicit entry within that range, never invented or defaulted by code.
 db.prepare("CREATE TABLE IF NOT EXISTS employee_review_incentives (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,review_date TEXT NOT NULL,amount REAL NOT NULL,review_reference TEXT,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)"),
]);}

export async function recordEmployeeSpecialIncentive(db:Db,input:{employeeId:string;monthStart:string;amount:number;reason:string;actorId:string}){
 await ensureEmployeeRecognitionTables(db);
 if(!text(input.employeeId)||!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("Employee and a real month are required");
 if(!Number.isFinite(input.amount)||input.amount<=0)throw new Error("Special incentive amount must be an explicit positive number");
 if(input.reason.trim().length<8)throw new Error("A real reason is required for a special incentive - never auto-applied");
 const now=Date.now();
 await db.prepare("INSERT INTO employee_special_incentives (id,employee_id,month_start,amount,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?)")
   .bind(uid("ESI"),input.employeeId,input.monthStart,money(input.amount),input.reason.trim(),input.actorId,now).run();
 return{employeeId:input.employeeId,monthStart:input.monthStart,amount:money(input.amount)};
}

export async function monthlySpecialIncentiveTotal(db:Db,input:{employeeId:string;monthStart:string}){
 await ensureEmployeeRecognitionTables(db);
 const row=await db.prepare("SELECT COALESCE(SUM(amount),0) total FROM employee_special_incentives WHERE employee_id=? AND month_start=?").bind(input.employeeId,input.monthStart).first<Row>();
 return money(row?.total);
}

export async function recordGoogleReviewIncentive(db:Db,input:{employeeId:string;reviewDate:string;amount:number;reviewReference?:string;actorId:string}){
 await ensureEmployeeRecognitionTables(db);
 if(!text(input.employeeId)||!/^\d{4}-\d{2}-\d{2}$/.test(input.reviewDate))throw new Error("Employee and a real review date are required");
 if(!Number.isFinite(input.amount)||input.amount<100||input.amount>200)throw new Error("Google review incentive must be between ₹100 and ₹200, per the published policy");
 const now=Date.now();
 await db.prepare("INSERT INTO employee_review_incentives (id,employee_id,review_date,amount,review_reference,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?)")
   .bind(uid("ERI"),input.employeeId,input.reviewDate,money(input.amount),input.reviewReference||null,input.actorId,now).run();
 return{employeeId:input.employeeId,reviewDate:input.reviewDate,amount:money(input.amount)};
}

export async function monthlyReviewIncentiveTotal(db:Db,input:{employeeId:string;monthStartDate:string;monthEndDate:string}){
 await ensureEmployeeRecognitionTables(db);
 const row=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(amount),0) total FROM employee_review_incentives WHERE employee_id=? AND review_date>=? AND review_date<=?").bind(input.employeeId,input.monthStartDate,input.monthEndDate).first<Row>();
 return{count:Number(row?.n||0),total:money(row?.total)};
}
