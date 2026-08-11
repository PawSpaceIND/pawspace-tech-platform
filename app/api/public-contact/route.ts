// Public, unauthenticated lead-capture endpoint for the marketing site's contact form.
// This intentionally does NOT reuse the staff-only /api/crm route directly - that route
// requires "customers.manage" and also exposes broader staff capability. This route creates
// the same real crm_contacts + lead_work_items records (so leads captured here are real, and
// correctly flow into the same conversion-attribution pipeline as any other lead), but is
// scoped to create-only, with no way to read, list or manage existing contacts.
async function getDatabase(){
  const{env}=await import("cloudflare:workers");
  return env.DB;
}

async function ensureTables(db:D1Database){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Open', created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
}

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const roster=["Neha","Rahul","Priya","Sanjay"];

export async function POST(request:Request){
  try{
    const body=await request.json() as Record<string,string>;
    const name=String(body.name||"").trim(),phone=String(body.phone||"").trim();
    if(!name||name.length<2)return json({error:"Please enter your name"},400);
    if(!/^[0-9+\s-]{10,15}$/.test(phone))return json({error:"Please enter a valid phone number"},400);
    const db=await getDatabase();
    await ensureTables(db);
    const now=Date.now(),id=`CU-${Math.floor(10000+Math.random()*89999)}`;
    const loads=await db.prepare("SELECT owner,COUNT(*) count FROM lead_work_items WHERE status IN ('active','sla_breached','qualified') GROUP BY owner").all<Record<string,unknown>>();
    const loadMap=new Map(loads.results.map(row=>[String(row.owner),Number(row.count)]));
    const assignedOwner=[...roster].sort((a,b)=>(loadMap.get(a)||0)-(loadMap.get(b)||0))[0];
    const service=String(body.service||"General enquiry"),message=String(body.message||"").slice(0,500);
    await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id,name,phone,null,body.email||null,body.area||"Bangalore",body.petNames||"Not shared",message||"No message left",body.stage||"New lead",assignedOwner,"Website contact form",0,"Call within 10 minutes",service,now,now).run();
    await db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)")
      .bind(`ACT-${now}`,id,"lead_created","Contact form submission",`Service interest: ${service}`,now).run();
    await db.batch([
      db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`TASK-${now}`,id,"First response to new website lead",assignedOwner,now+10*60*1000,"High","Open",now),
      db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,?,0,0,?,?)").bind(`LEAD-${now}`,id,"Website contact form",service,assignedOwner,"Sales Manager",now,now+10*60000,now+30*60000,now+10*60000,now,now),
    ]);
    return json({ok:true,leadId:`LEAD-${now}`},201);
  }catch(error){return json({error:error instanceof Error?error.message:"Unable to submit your enquiry - please try again"},500);}
}
