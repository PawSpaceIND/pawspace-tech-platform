import { hasPermission, maskName, maskPhone, parsePermissions } from "../../../lib/platform-security";

async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
function parseCsv(text:string){
  const rows:string[][]=[]; let row:string[]=[]; let cell=""; let quoted=false;
  for(let i=0;i<text.length;i++){const char=text[i]; if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell="";}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value.trim()))rows.push(row);row=[];cell="";}else cell+=char;}
  if(cell||row.length){row.push(cell);if(row.some(value=>value.trim()))rows.push(row);}
  const headers=(rows.shift()||[]).map(value=>value.trim().replace(/^\uFEFF/,""));
  return rows.map(values=>Object.fromEntries(headers.map((header,index)=>[header,(values[index]||"").trim()])));
}
function numeric(value:string){const result=Number((value||"").replace(/[^0-9.-]/g,""));return Number.isFinite(result)?result:0;}
function phones(value:string){const matches=(value||"").match(/(?:\+?91[\s-]?)?[6-9]\d(?:[\s-]?\d){8}/g)||[];const normalized=matches.map(item=>item.replace(/\D/g,"").slice(-10));return [normalized[0]||null,normalized[1]||null] as const;}
async function current(request:Request){
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase(); if(!email)return {email,permissions:[] as string[]};
  const db=await database(); const user=await db.prepare("SELECT role_code FROM app_users WHERE email=? AND status='active'").bind(email).first<{role_code:string}>();
  if(!user)return {email,permissions:[] as string[]}; const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(user.role_code).first<{permissions_json:string}>();
  return {email,permissions:parsePermissions(role?.permissions_json)};
}
async function ensureTables(){const db=await database();await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS subscription_customers (customer_key TEXT PRIMARY KEY, customer_name TEXT NOT NULL, primary_phone TEXT, secondary_phone TEXT, segment TEXT NOT NULL, outbound_priority TEXT NOT NULL, next_best_action TEXT NOT NULL, first_service_date TEXT NOT NULL, last_service_date TEXT NOT NULL, days_since_last_service INTEGER NOT NULL, dormancy_bucket TEXT NOT NULL, orders INTEGER NOT NULL, gross_sales REAL NOT NULL, aov REAL NOT NULL, services_used TEXT NOT NULL, primary_service TEXT NOT NULL, grooming_orders INTEGER NOT NULL, grooming_subscription_orders INTEGER NOT NULL, training_orders INTEGER NOT NULL, boarding_orders INTEGER NOT NULL, pet_sitting_orders INTEGER NOT NULL, subscription_target_score REAL NOT NULL, import_batch_id TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS data_import_batches (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, row_count INTEGER NOT NULL, imported_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, status TEXT NOT NULL, imported_by TEXT NOT NULL, created_at INTEGER NOT NULL)"),
]);}

export async function GET(request:Request){
  await ensureTables(); const actor=await current(request); if(!actor.email||!hasPermission(actor.permissions,"customers.view"))return Response.json({error:"Permission denied"},{status:403});
  const db=await database(); const url=new URL(request.url); const q=(url.searchParams.get("q")||"").trim(); const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||25)));
  const summary=await db.prepare("SELECT COUNT(*) AS customers, COALESCE(SUM(gross_sales),0) AS gross_sales, COALESCE(SUM(grooming_orders),0) AS grooming_orders, COALESCE(SUM(grooming_subscription_orders),0) AS subscription_orders, COALESCE(AVG(subscription_target_score),0) AS average_score FROM subscription_customers").first();
  const result=q?await db.prepare("SELECT * FROM subscription_customers WHERE customer_key LIKE ? OR customer_name LIKE ? OR primary_phone LIKE ? ORDER BY subscription_target_score DESC LIMIT ?").bind(`%${q}%`,`%${q}%`,`%${q.replace(/\D/g,"")}%`,limit).all():await db.prepare("SELECT * FROM subscription_customers ORDER BY subscription_target_score DESC LIMIT ?").bind(limit).all();
  const reveal=hasPermission(actor.permissions,"customers.view_full_phone");
  return Response.json({summary,customers:result.results.map(row=>{const r=row as Record<string,unknown>;return {...r,customer_name:reveal?r.customer_name:maskName(String(r.customer_name)),primary_phone:reveal?r.primary_phone:maskPhone(String(r.primary_phone||"")),secondary_phone:reveal?r.secondary_phone:maskPhone(String(r.secondary_phone||""))};}),masked:!reveal});
}

export async function POST(request:Request){
  await ensureTables(); const actor=await current(request); if(!actor.email||!hasPermission(actor.permissions,"data.import"))return Response.json({error:"Data import permission required"},{status:403});
  const text=await request.text(); if(text.length>8_000_000)return Response.json({error:"CSV exceeds the 8 MB limit"},{status:413});
  const records=parseCsv(text); const required=["Customer Name","Phone(s)","Segment","Last Service Date","Gross Sales","Customer Key"]; const missing=required.filter(column=>!Object.prototype.hasOwnProperty.call(records[0]||{},column)); if(missing.length)return Response.json({error:`Missing required columns: ${missing.join(", ")}`},{status:400});
  const db=await database(); const batchId=`IMP-${Date.now()}`; const now=Date.now(); let imported=0,rejected=0; const statements=[];
  for(const record of records){const key=record["Customer Key"]?.trim(); const name=record["Customer Name"]?.trim(); if(!key||!name){rejected++;continue;} const [primary,secondary]=phones(record["Phone(s)"]); if(!primary)rejected++;
    statements.push(db.prepare("INSERT INTO subscription_customers (customer_key,customer_name,primary_phone,secondary_phone,segment,outbound_priority,next_best_action,first_service_date,last_service_date,days_since_last_service,dormancy_bucket,orders,gross_sales,aov,services_used,primary_service,grooming_orders,grooming_subscription_orders,training_orders,boarding_orders,pet_sitting_orders,subscription_target_score,import_batch_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_key) DO UPDATE SET customer_name=excluded.customer_name,primary_phone=excluded.primary_phone,secondary_phone=excluded.secondary_phone,segment=excluded.segment,outbound_priority=excluded.outbound_priority,next_best_action=excluded.next_best_action,first_service_date=excluded.first_service_date,last_service_date=excluded.last_service_date,days_since_last_service=excluded.days_since_last_service,dormancy_bucket=excluded.dormancy_bucket,orders=excluded.orders,gross_sales=excluded.gross_sales,aov=excluded.aov,services_used=excluded.services_used,primary_service=excluded.primary_service,grooming_orders=excluded.grooming_orders,grooming_subscription_orders=excluded.grooming_subscription_orders,training_orders=excluded.training_orders,boarding_orders=excluded.boarding_orders,pet_sitting_orders=excluded.pet_sitting_orders,subscription_target_score=excluded.subscription_target_score,import_batch_id=excluded.import_batch_id,updated_at=excluded.updated_at")
      .bind(key,name,primary,secondary,record.Segment||"Unknown",record["Outbound Priority"]||"Normal",record["Next Best Action"]||"Review",record["First Service Date"]||"",record["Last Service Date"]||"",numeric(record["Days Since Last Service Today"]),record["Dormancy Bucket"]||"Unknown",numeric(record.Orders),numeric(record["Gross Sales"]),numeric(record.AOV),record["Services Used"]||"",record["Primary Service"]||"",numeric(record["Grooming Orders"]),numeric(record["Grooming Subscription Orders"]),numeric(record["Training Orders"]),numeric(record["Boarding Orders"]),numeric(record["Pet Sitting Orders"]),numeric(record["Subscription Target Score"]),batchId,now)); imported++;}
  for(let index=0;index<statements.length;index+=50)await db.batch(statements.slice(index,index+50));
  await db.prepare("INSERT INTO data_import_batches (id,file_name,row_count,imported_count,rejected_count,status,imported_by,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(batchId,request.headers.get("x-pawspace-file-name")||"subscription-customers.csv",records.length,imported,rejected,"completed",actor.email,now).run();
  return Response.json({ok:true,batchId,rows:records.length,imported,rejected},{status:201});
}
