import * as leave from "../lib/attendance-leave";
import * as capacity from "../lib/provider-capacity-governance";
import * as linkage from "../lib/workforce-person-linkage";
export async function seedBridgeWorld(db:D1Database){
 await leave.ensureAttendanceLeaveTables(db);await capacity.ensureProviderCapacityTables(db);await linkage.ensureWorkforcePersonLinkTables(db);
 await db.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,customer_id TEXT,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT UNIQUE,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
 const now=Date.now();await db.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,ended_at,created_at,updated_at) VALUES ('EMP-P',NULL,'EMP-P','Provider Person','provider@test',NULL,'contract_active',?,NULL,?,?)").bind(now-86400000,now,now).run();
 await db.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('PROV-P','blr','Provider P','full_time','[\"grooming\"]','[\"blr-east\"]',1,5,100,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)").bind(now).run();
 await db.prepare("INSERT INTO provider_people_links (provider_id,employee_id,engagement_kind,status,source,created_by,created_at,updated_at) VALUES ('PROV-P','EMP-P','contract','active','test','test',?,?)").bind(now,now).run();
 await leave.saveLeavePolicy(db,{name:"Casual",leaveCode:"CL",allowNegative:false,entitlementUnits:10,effectiveFrom:now-86400000,actorId:"hr@test"});
 await db.prepare("INSERT INTO employee_leave_balances (employee_id,leave_code,balance,updated_at) VALUES ('EMP-P','CL',10,?)").bind(now).run();
 await db.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','idem-1','CUS-1','[]','[]','blr','blr-east','grooming','pkg','Package','GRP-1','PROV-P','2030-10-05T04:30:00.000Z','2030-10-05T06:30:00.000Z','confirmed','customer_app',1000,'INR','{}','test',?,?)").bind(now,now).run();
 return{db};
}
