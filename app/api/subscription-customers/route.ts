import { hasPermission, maskName, maskPhone, parsePermissions } from "../../../lib/platform-security";
import { customerDataAccessResolver } from "../../../lib/purpose-based-access";

async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
function parseCsv(text:string){
  const rows:string[][]=[]; let row:string[]=[]; let cell=""; let quoted=false;
  for(let i=0;i<text.length;i++){const char=text[i]; if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell="";}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value.trim()))rows.push(row);row=[];cell="";}else cell+=char;}
  if(cell||row.length){row.push(cell);if(row.some(value=>value.trim()))rows.push(row);}
  const headers=(rows.shift()||[]).map(value=>value.trim().replace(/^\uFEFF/,""));
  return rows.map(values=>Object.fromEntries(headers.map((header,index)=>[header,(values[index]||"").trim()])));
}
function numeric(value:string){const result=Number((value||"").replace(/[^0-9.-]/g,""));return Number.isFinite(result)?result:0;}
function phones(value:string){const matches=(value||"").match(/(?:\+?91[\s-]?)?[6-9]\d(?:[\s-]?\d){8}/g)||[];const normalized=[...new Set(matches.map(item=>item.replace(/\D/g,"").slice(-10)).filter(item=>/^[6-9]\d{9}$/.test(item)))];return [normalized[0]||null,normalized[1]||null] as const;}
function value(record:Record<string,string>,...keys:string[]){for(const key of keys){const found=record[key]?.trim();if(found)return found;}return "";}
function daysSince(dateText:string){if(!dateText)return 0;const time=Date.parse(`${dateText.slice(0,10)}T00:00:00Z`);if(Number.isNaN(time))return 0;return Math.max(0,Math.floor((Date.now()-time)/86_400_000));}
function dormancy(days:number){if(days<=30)return "0-30 days Active";if(days<=90)return "31-90 days Warm";if(days<=180)return "91-180 days Cool";if(days<=365)return "181-365 days Dormant";if(days<=730)return "1-2 years Lost";return "2+ years Deep Dormant";}
function yes(value:string){return ["yes","true","1"].includes((value||"").trim().toLowerCase());}
async function current(request:Request){
  const email=(request.headers.get("oai-authenticated-user-email")||"").trim().toLowerCase(); if(!email)return {email,roleCode:"",permissions:[] as string[]};
  const db=await database(); const user=await db.prepare("SELECT role_code FROM app_users WHERE email=? AND status='active'").bind(email).first<{role_code:string}>();
  if(!user)return {email,permissions:[] as string[]}; const role=await db.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").bind(user.role_code).first<{permissions_json:string}>();
  return {email,permissions:parsePermissions(role?.permissions_json)};
}
async function ensureTables(){const db=await database();await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS subscription_customers (customer_key TEXT PRIMARY KEY, customer_name TEXT NOT NULL, primary_phone TEXT, secondary_phone TEXT, segment TEXT NOT NULL, outbound_priority TEXT NOT NULL, next_best_action TEXT NOT NULL, first_service_date TEXT NOT NULL, last_service_date TEXT NOT NULL, days_since_last_service INTEGER NOT NULL, dormancy_bucket TEXT NOT NULL, orders INTEGER NOT NULL, gross_sales REAL NOT NULL, aov REAL NOT NULL, services_used TEXT NOT NULL, primary_service TEXT NOT NULL, grooming_orders INTEGER NOT NULL, grooming_subscription_orders INTEGER NOT NULL, training_orders INTEGER NOT NULL, boarding_orders INTEGER NOT NULL, pet_sitting_orders INTEGER NOT NULL, subscription_target_score REAL NOT NULL, import_batch_id TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS customer_demo_enrichment (customer_key TEXT PRIMARY KEY,data_as_of TEXT NOT NULL DEFAULT '',contactable INTEGER NOT NULL DEFAULT 0,current_orders INTEGER NOT NULL DEFAULT 0,current_customer_type TEXT NOT NULL DEFAULT '',current_last_service_date TEXT NOT NULL DEFAULT '',july_grooming_orders INTEGER NOT NULL DEFAULT 0,latest_grooming_order_date TEXT NOT NULL DEFAULT '',latest_grooming_package TEXT NOT NULL DEFAULT '',latest_pet_breed TEXT NOT NULL DEFAULT '',latest_grooming_payment_status TEXT NOT NULL DEFAULT '',latest_groomer_team TEXT NOT NULL DEFAULT '',latest_package_cost REAL,has_address INTEGER NOT NULL DEFAULT 0,service_address TEXT NOT NULL DEFAULT '',pincode TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',sub_area TEXT NOT NULL DEFAULT '',google_map_link TEXT NOT NULL DEFAULT '',latitude TEXT NOT NULL DEFAULT '',longitude TEXT NOT NULL DEFAULT '',historical_subscription_customer INTEGER NOT NULL DEFAULT 0,legacy_subscription_state TEXT NOT NULL DEFAULT 'no_legacy_subscription_history',subscription_followup_state TEXT NOT NULL DEFAULT 'no_subscription_action',import_batch_id TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS data_import_batches (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, row_count INTEGER NOT NULL, imported_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, status TEXT NOT NULL, imported_by TEXT NOT NULL, created_at INTEGER NOT NULL)"),
]);}

export async function GET(request:Request){
  await ensureTables(); const actor=await current(request); if(!actor.email||!hasPermission(actor.permissions,"customers.view"))return Response.json({error:"Permission denied"},{status:403});
  const db=await database(); const url=new URL(request.url); const q=(url.searchParams.get("q")||"").trim(); const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||25)));
  const summary=await db.prepare(`SELECT COUNT(*) AS customers,COALESCE(SUM(s.gross_sales),0) AS gross_sales,COALESCE(SUM(s.grooming_orders),0) AS grooming_orders,COALESCE(SUM(s.grooming_subscription_orders),0) AS subscription_orders,COALESCE(AVG(s.subscription_target_score),0) AS average_score,
    COALESCE(SUM(CASE WHEN COALESCE(NULLIF(e.current_customer_type,''),CASE WHEN s.orders>1 THEN 'Repeat' ELSE 'One-Time' END)='Repeat' THEN 1 ELSE 0 END),0) AS repeat_customers,
    COALESCE(SUM(CASE WHEN s.grooming_subscription_orders>0 THEN 1 ELSE 0 END),0) AS historical_subscribers,
    COALESCE(SUM(CASE WHEN e.legacy_subscription_state='legacy_balance_pending_migration' THEN 1 ELSE 0 END),0) AS legacy_balance_pending,
    COALESCE(SUM(CASE WHEN e.subscription_followup_state='subscription_candidate' THEN 1 ELSE 0 END),0) AS subscription_candidates,
    COALESCE(SUM(CASE WHEN e.july_grooming_orders>0 THEN 1 ELSE 0 END),0) AS july_matched,
    COALESCE(SUM(CASE WHEN julianday('now')-julianday(COALESCE(NULLIF(e.current_last_service_date,''),NULLIF(s.last_service_date,''))) BETWEEN 0 AND 30 THEN 1 ELSE 0 END),0) AS active_30
    FROM subscription_customers s LEFT JOIN customer_demo_enrichment e ON e.customer_key=s.customer_key`).first();
  const select=`SELECT s.*,e.data_as_of,e.contactable,e.current_orders,e.current_customer_type,e.current_last_service_date,e.july_grooming_orders,e.latest_grooming_order_date,e.latest_grooming_package,e.latest_pet_breed,e.latest_grooming_payment_status,e.latest_groomer_team,e.latest_package_cost,e.has_address,e.service_address,e.pincode,e.city,e.sub_area,e.google_map_link,e.latitude,e.longitude,e.historical_subscription_customer,e.legacy_subscription_state,e.subscription_followup_state FROM subscription_customers s LEFT JOIN customer_demo_enrichment e ON e.customer_key=s.customer_key`;
  const result=q?await db.prepare(`${select} WHERE s.customer_key LIKE ? OR s.customer_name LIKE ? OR s.primary_phone LIKE ? ORDER BY s.subscription_target_score DESC LIMIT ?`).bind(`%${q}%`,`%${q}%`,`%${q.replace(/\D/g,"")}%`,limit).all():await db.prepare(`${select} ORDER BY s.subscription_target_score DESC LIMIT ?`).bind(limit).all();
  /*
   * Purpose-based access. [PTJA-W2-B2-C07]
   *
   * What this replaced: one `customers.view_full_phone` boolean gating maskName/maskPhone. This list is
   * the one that carries the WIDEST personal data on the platform - the enrichment join brings
   * service_address, pincode, a Google Maps link and latitude/longitude - and none of that was ever
   * touched by the boolean. It was published in full to every actor who could open the screen.
   *
   * The policy is resolved ONCE for the page. The area and city survive so the segmentation work stays
   * possible; the doorstep and the coordinates do not.
   */
  const access=await customerDataAccessResolver(db);
  const listActor={email:actor.email,roleCode:String(actor.roleCode||""),permissions:actor.permissions};
  return Response.json({summary,customers:result.results.map(row=>{const r=row as Record<string,unknown>;const last=String(r.current_last_service_date||r.last_service_date||"");const days=daysSince(last);
    const view=access.view({actor:listActor,purpose:"sales",
      subject:{customerId:String(r.customer_key),name:String(r.customer_name||""),phone:r.primary_phone?String(r.primary_phone):null,email:null,
        address:{line1:r.service_address?String(r.service_address):null,area:r.sub_area?String(r.sub_area):null,city:r.city?String(r.city):null,pincode:r.pincode?String(r.pincode):null}}});
    const full=view.address.precision==="full";
    return {...r,current_last_service_date:last,current_days_since_last_service:days,current_dormancy_bucket:dormancy(days),
      customer_name:maskName(String(r.customer_name)),primary_phone:view.contact.phone,secondary_phone:r.secondary_phone?maskPhone(String(r.secondary_phone)):null,
      service_address:full?r.service_address:"",pincode:full?r.pincode:"",
      google_map_link:full?r.google_map_link:"",latitude:full?r.latitude:"",longitude:full?r.longitude:"",
      addressPrecision:view.address.precision};}),masked:true,policyVersion:access.policyVersion});
}

export async function POST(request:Request){
  await ensureTables(); const actor=await current(request); if(!actor.email||!hasPermission(actor.permissions,"data.import"))return Response.json({error:"Data import permission required"},{status:403});
  const text=await request.text(); if(text.length>8_000_000)return Response.json({error:"CSV exceeds the 8 MB limit"},{status:413});
  const records=parseCsv(text); if(!records.length)return Response.json({error:"CSV has no customer rows"},{status:400});
  const required=["Customer Name","Customer Key"]; const missing=required.filter(column=>!Object.prototype.hasOwnProperty.call(records[0],column)); if(missing.length)return Response.json({error:`Missing required columns: ${missing.join(", ")}`},{status:400});
  const db=await database(); const batchId=`IMP-${Date.now()}`; const now=Date.now(); let imported=0,rejected=0,flagged=0; const statements=[];
  for(const record of records){
    const key=value(record,"Customer Key"),name=value(record,"Customer Name");if(!key||!name){rejected++;continue;}
    const phoneText=value(record,"Phone(s)","All Phone Numbers","Phone Number");const[primary,secondary]=phones(phoneText);if(!primary)flagged++;
    const lastService=value(record,"Current Last Service Date","Last Service Date","Latest Grooming Order Date");const days=daysSince(lastService);const historicalOrders=numeric(value(record,"Orders","Total Orders (Truth)"));const currentOrders=numeric(value(record,"Current Orders Approx"))||historicalOrders+numeric(value(record,"July Grooming Orders Matched"));const subOrders=numeric(value(record,"Grooming Subscription Orders"));const score=numeric(value(record,"Subscription Target Score"));
    const legacyState=value(record,"Legacy Subscription State")||(subOrders>0?"legacy_balance_pending_migration":"no_legacy_subscription_history");const followup=value(record,"Subscription Follow-up State")||(subOrders>0?"renewal_review_from_history":score>=50?"subscription_candidate":"no_subscription_action");
    statements.push(
      db.prepare("INSERT INTO subscription_customers (customer_key,customer_name,primary_phone,secondary_phone,segment,outbound_priority,next_best_action,first_service_date,last_service_date,days_since_last_service,dormancy_bucket,orders,gross_sales,aov,services_used,primary_service,grooming_orders,grooming_subscription_orders,training_orders,boarding_orders,pet_sitting_orders,subscription_target_score,import_batch_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_key) DO UPDATE SET customer_name=excluded.customer_name,primary_phone=excluded.primary_phone,secondary_phone=excluded.secondary_phone,segment=excluded.segment,outbound_priority=excluded.outbound_priority,next_best_action=excluded.next_best_action,first_service_date=excluded.first_service_date,last_service_date=excluded.last_service_date,days_since_last_service=excluded.days_since_last_service,dormancy_bucket=excluded.dormancy_bucket,orders=excluded.orders,gross_sales=excluded.gross_sales,aov=excluded.aov,services_used=excluded.services_used,primary_service=excluded.primary_service,grooming_orders=excluded.grooming_orders,grooming_subscription_orders=excluded.grooming_subscription_orders,training_orders=excluded.training_orders,boarding_orders=excluded.boarding_orders,pet_sitting_orders=excluded.pet_sitting_orders,subscription_target_score=excluded.subscription_target_score,import_batch_id=excluded.import_batch_id,updated_at=excluded.updated_at")
        .bind(key,name,primary,secondary,value(record,"Segment")||"Unknown",value(record,"Outbound Priority")||"Normal",value(record,"Next Best Action")||"Review",value(record,"First Service Date"),lastService,days,dormancy(days),historicalOrders,numeric(value(record,"Gross Sales","Revenue So Far (Truth)")),numeric(value(record,"AOV")),value(record,"Services Used"),value(record,"Primary Service"),numeric(value(record,"Grooming Orders")),subOrders,numeric(value(record,"Training Orders")),numeric(value(record,"Boarding Orders")),numeric(value(record,"Pet Sitting Orders")),score,batchId,now),
      db.prepare("INSERT INTO customer_demo_enrichment (customer_key,data_as_of,contactable,current_orders,current_customer_type,current_last_service_date,july_grooming_orders,latest_grooming_order_date,latest_grooming_package,latest_pet_breed,latest_grooming_payment_status,latest_groomer_team,latest_package_cost,has_address,service_address,pincode,city,sub_area,google_map_link,latitude,longitude,historical_subscription_customer,legacy_subscription_state,subscription_followup_state,import_batch_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_key) DO UPDATE SET data_as_of=excluded.data_as_of,contactable=excluded.contactable,current_orders=excluded.current_orders,current_customer_type=excluded.current_customer_type,current_last_service_date=excluded.current_last_service_date,july_grooming_orders=excluded.july_grooming_orders,latest_grooming_order_date=excluded.latest_grooming_order_date,latest_grooming_package=excluded.latest_grooming_package,latest_pet_breed=excluded.latest_pet_breed,latest_grooming_payment_status=excluded.latest_grooming_payment_status,latest_groomer_team=excluded.latest_groomer_team,latest_package_cost=excluded.latest_package_cost,has_address=excluded.has_address,service_address=excluded.service_address,pincode=excluded.pincode,city=excluded.city,sub_area=excluded.sub_area,google_map_link=excluded.google_map_link,latitude=excluded.latitude,longitude=excluded.longitude,historical_subscription_customer=excluded.historical_subscription_customer,legacy_subscription_state=excluded.legacy_subscription_state,subscription_followup_state=excluded.subscription_followup_state,import_batch_id=excluded.import_batch_id,updated_at=excluded.updated_at")
        .bind(key,value(record,"Data As Of")||new Date(now).toISOString().slice(0,10),primary?1:0,currentOrders,value(record,"Current Customer Type")||(currentOrders>1?"Repeat":"One-Time"),lastService,numeric(value(record,"July Grooming Orders Matched")),value(record,"Latest Grooming Order Date"),value(record,"Latest Grooming Package","Latest Grooming Package From Master"),value(record,"Latest Pet Breed","Latest Pet Breed From Master"),value(record,"Latest Grooming Payment Status","Latest Payment Status From Master"),value(record,"Latest Groomer / Team"),numeric(value(record,"Latest Package Cost Parsed","Latest Package Cost From Master"))||null,yes(value(record,"Has Address","Has_Address"))?1:0,value(record,"Latest / Best Service Address"),value(record,"Pincode"),value(record,"City"),value(record,"Sub Area / Locality"),value(record,"Google Map Link"),value(record,"Latitude"),value(record,"Longitude"),subOrders>0?1:0,legacyState,followup,batchId,now)
    );imported++;
  }
  for(let index=0;index<statements.length;index+=40)await db.batch(statements.slice(index,index+40));
  await db.prepare("INSERT INTO data_import_batches (id,file_name,row_count,imported_count,rejected_count,status,imported_by,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(batchId,request.headers.get("x-pawspace-file-name")||"customer-demo-cohort.csv",records.length,imported,rejected+flagged,"completed",actor.email,now).run();
  return Response.json({ok:true,batchId,rows:records.length,imported,rejected,flagged},{status:201});
}
