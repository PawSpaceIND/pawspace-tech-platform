import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";

async function getDatabase(){
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

async function ensureTables(){
  const db=await getDatabase();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Open', created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_name TEXT NOT NULL, action_name TEXT NOT NULL, enabled INTEGER DEFAULT 1, runs INTEGER DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
}

export async function GET(request:Request){try{
  await authorize(request,"customers.view"); await ensureTables();
  const db=await getDatabase();
  const result=await db.prepare("SELECT * FROM crm_contacts ORDER BY updated_at DESC LIMIT 100").all();
  return Response.json({contacts:result.results});
}catch(error){return authError(error,"Unable to load CRM");}}

export async function POST(request:Request){
  try{const actor=await authorize(request,"customers.manage"); await ensureTables(); const body=await request.json() as Record<string,string>; const now=Date.now(); const id=`CU-${Math.floor(10000+Math.random()*89999)}`;
  const db=await database();
  const roster=["Neha","Rahul","Priya","Sanjay"]; const loads=await db.prepare("SELECT owner,COUNT(*) count FROM lead_work_items WHERE status IN ('active','sla_breached','qualified') GROUP BY owner").all(); const loadMap=new Map((loads.results as Array<Record<string,unknown>>).map(row=>[String(row.owner),Number(row.count)])); const assignedOwner=body.owner&&body.owner!=="Unassigned"?body.owner:[...roster].sort((a,b)=>(loadMap.get(a)||0)-(loadMap.get(b)||0))[0];
  await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,body.name||"New customer",body.primaryPhone||"",body.secondaryPhone||null,body.email||null,body.area||"Bangalore",body.petNames||"Pet",body.petSummary||"Profile incomplete",body.stage||"New lead",assignedOwner,body.source||"Website",0,body.nextAction||"Call within 10 minutes",body.opportunity||body.service||"Discover requirement",now,now).run();
  await db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)").bind(`ACT-${now}`,id,"lead_created","Lead created",`Source: ${body.source||"Website"}`,now).run();
  await db.batch([
    db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`TASK-${now}`,id,"First response to new lead",assignedOwner,now+10*60*1000,"High","Open",now),
    db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?, ?,0,0,?,?)").bind(`LEAD-${now}`,id,body.source||"Website",body.service||"Discover requirement",assignedOwner,"Sales Manager",now,now+10*60000,now+30*60000,0,0,now+10*60000,now,now),
  ]);
  await securityAudit(db,actor,"create","crm_contact",id,"completed",{source:body.source||"Website",assignedOwner,firstResponseMinutes:10,managerAlertMinutes:30});
  return Response.json({ok:true,id,leadId:`LEAD-${now}`,assignedOwner},{status:201});}catch(error){return authError(error,"Unable to create CRM contact");}
}
