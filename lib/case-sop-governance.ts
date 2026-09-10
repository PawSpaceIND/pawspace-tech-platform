type Db=D1Database;
type Row=Record<string,unknown>;

const text=(value:unknown)=>String(value??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const CASE_TYPES_REQUIRING_SOP=new Set(["customer_complaint","provider_issue","safety_incident","operations","rebooking"]);

async function tableExists(db:Db,name:string){
  const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

export async function ensureCaseSopTables(db:Db){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS unified_case_sop_requirements (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,module_id TEXT NOT NULL,module_version INTEGER NOT NULL,title TEXT NOT NULL,service_code TEXT NOT NULL,provider_id TEXT,status TEXT NOT NULL DEFAULT 'pending',evidence_note TEXT,completed_by TEXT,completed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(case_id,module_id,module_version))"),
    db.prepare("CREATE INDEX IF NOT EXISTS unified_case_sop_case_idx ON unified_case_sop_requirements(case_id,status,module_id,module_version)"),
  ]);
}

async function caseContext(db:Db,row:Row){
  let serviceCode=text(row.service_code),providerId=text(row.provider_id)||null;
  if(row.booking_id&&await tableExists(db,"canonical_bookings")){
    const booking=await db.prepare("SELECT service_code,provider_id FROM canonical_bookings WHERE id=?").bind(row.booking_id).first<Row>();
    if(booking){serviceCode=text(booking.service_code)||serviceCode;providerId=text(booking.provider_id)||providerId;}
  }
  return{serviceCode,providerId};
}

/**
 * Materialises the currently published required SOP modules that apply to an open provider/service case.
 * A new LMS module version creates a new pending requirement; an old completion never satisfies a newly
 * published SOP version. This is a CASE-resolution checklist, separate from provider training completion.
 */
export async function syncCaseSopRequirements(db:Db,input:{caseId?:string;actorId:string}){
  await ensureCaseSopTables(db);
  if(!(await tableExists(db,"unified_cases"))||!(await tableExists(db,"lms_modules")))return{created:0,scanned:0,unavailable:true};
  const rows=input.caseId
    ?await db.prepare("SELECT * FROM unified_cases WHERE id=?").bind(input.caseId).all<Row>()
    :await db.prepare("SELECT * FROM unified_cases WHERE status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 500").all<Row>();
  let created=0,eligible=0,skippedNoService=0;
  for(const row of rows.results){
    if(!CASE_TYPES_REQUIRING_SOP.has(text(row.case_type)))continue;
    const{serviceCode,providerId}=await caseContext(db,row);
    if(!serviceCode){skippedNoService++;continue;}
    eligible++;
    const modules=await db.prepare("SELECT id,title,service_code,version FROM lms_modules WHERE status='published' AND required=1 AND service_code IN ('all',?) ORDER BY created_at").bind(serviceCode).all<Row>();
    for(const moduleRow of modules.results){
      const now=Date.now();
      const result=await db.prepare("INSERT OR IGNORE INTO unified_case_sop_requirements (id,case_id,module_id,module_version,title,service_code,provider_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)")
        .bind(uid("CSOP"),row.id,moduleRow.id,Number(moduleRow.version),text(moduleRow.title),text(moduleRow.service_code),providerId,now,now).run();
      if(Number(result.meta?.changes||0)===1){
        created++;
        if(await tableExists(db,"unified_case_events"))await db.prepare("INSERT OR IGNORE INTO unified_case_events (id,idempotency_key,case_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
          .bind(uid("CASEE"),`sop-required:${text(row.id)}:${text(moduleRow.id)}:${Number(moduleRow.version)}`,row.id,"sop_required",input.actorId,JSON.stringify({moduleId:text(moduleRow.id),moduleVersion:Number(moduleRow.version),title:text(moduleRow.title),serviceCode:text(moduleRow.service_code)}),now).run();
      }
    }
  }
  return{created,scanned:rows.results.length,eligible,skippedNoService,unavailable:false};
}

export async function listCaseSopRequirements(db:Db,caseId:string){
  await ensureCaseSopTables(db);
  const rows=await db.prepare("SELECT * FROM unified_case_sop_requirements WHERE case_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,created_at").bind(caseId).all<Row>();
  return rows.results;
}

export async function updateCaseSopRequirement(db:Db,input:{caseId:string;requirementId:string;action:"complete"|"waive";note:string;actorId:string}){
  await ensureCaseSopTables(db);
  const note=text(input.note);
  if(note.length<8)throw new Response("SOP completion or waiver needs an evidence note of at least 8 characters",{status:400});
  const row=await db.prepare("SELECT * FROM unified_case_sop_requirements WHERE id=? AND case_id=?").bind(input.requirementId,input.caseId).first<Row>();
  if(!row)throw new Response("SOP requirement not found",{status:404});
  const target=input.action==="complete"?"completed":"waived";
  if(text(row.status)===target)return{requirementId:input.requirementId,status:target,duplicatePrevented:true};
  if(text(row.status)!=="pending")throw new Response("This SOP requirement has already been decided",{status:409});
  const now=Date.now();
  const result=await db.prepare("UPDATE unified_case_sop_requirements SET status=?,evidence_note=?,completed_by=?,completed_at=?,updated_at=? WHERE id=? AND case_id=? AND status='pending'")
    .bind(target,note,input.actorId,now,now,input.requirementId,input.caseId).run();
  if(Number(result.meta?.changes||0)!==1)throw new Response("SOP requirement changed concurrently; reload before retrying",{status:409});
  if(await tableExists(db,"unified_case_events"))await db.prepare("INSERT OR IGNORE INTO unified_case_events (id,idempotency_key,case_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(uid("CASEE"),`sop-${target}:${input.requirementId}`,input.caseId,target==="completed"?"sop_completed":"sop_waived",input.actorId,JSON.stringify({requirementId:input.requirementId,moduleId:text(row.module_id),moduleVersion:Number(row.module_version),title:text(row.title),note}),now).run();
  return{requirementId:input.requirementId,status:target,duplicatePrevented:false};
}

export async function assertCaseSopClosureReady(db:Db,caseId:string){
  if(!(await tableExists(db,"unified_case_sop_requirements")))return{ready:true,pending:0};
  const row=await db.prepare("SELECT COUNT(*) pending FROM unified_case_sop_requirements WHERE case_id=? AND status='pending'").bind(caseId).first<Row>();
  const pending=Number(row?.pending||0);
  if(pending>0)throw new Response(`Complete or explicitly waive ${pending} required SOP action(s) before resolving this case`,{status:409});
  return{ready:true,pending:0};
}
