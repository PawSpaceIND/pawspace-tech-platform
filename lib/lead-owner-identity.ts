/**
 * Who owns a lead. [PTJA-W3-CO]
 *
 * THE APPROVED RULE, in the business's own words:
 *   Replace roster first names with stable application user IDs. Ownership must reference a real
 *   app_users/staff identity. Do not guess that "Neha" corresponds to a particular login. Until
 *   Operations provides the mapping, leave those records unassigned and report the mapping exception.
 *   Do not weaken masking because the owner could not be resolved.
 */
import{ensureLeadAssignmentTables}from"./lead-assignment-governance";
import{normalizeLeadServiceCode}from"./lead-lifecycle-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const UNASSIGNED_OWNER="Unassigned";

const ownerTablesReady=new WeakSet<Db>();
export async function ensureLeadOwnerTables(db:Db){
  if(ownerTablesReady.has(db))return;
  await ensureLeadAssignmentTables(db).catch(()=>{});
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_owner_mapping_exceptions (id TEXT PRIMARY KEY,scope TEXT NOT NULL,customer_id TEXT,lead_id TEXT,requested_owner TEXT,reason TEXT NOT NULL,resolved_at INTEGER,resolved_by TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_owner_exceptions ON lead_owner_mapping_exceptions(resolved_at,created_at)"),
  ]);
  ownerTablesReady.add(db);
}

export async function resolveLeadOwner(db:Db,hint:string|null|undefined):Promise<string|null>{
  const value=text(hint);
  if(!value||value===UNASSIGNED_OWNER)return null;
  const row=await db.prepare("SELECT email FROM app_users WHERE status='active' AND (lower(email)=lower(?) OR id=?)").bind(value,value).first<Row>().catch(()=>null);
  return row?String(row.email):null;
}

export type LeadOwnerAssignment={owner:string;resolved:boolean;reason?:string};
type LeadOwnerScope={serviceCode:string;cityId:string;teamCode:string};
function scopeList(value:unknown):string[]{let parsed:unknown;try{parsed=JSON.parse(String(value??"[]"));}catch{throw new Error("Lead assignment membership scope could not be read");}if(!Array.isArray(parsed)||!parsed.every(v=>typeof v==="string"&&v.trim()))throw new Error("Lead assignment membership scope is malformed");return parsed as string[];}
function scopeCity(value:unknown){const key=text(value).toLowerCase();const aliases:Record<string,string>={bangalore:"blr",bengaluru:"blr",hyderabad:"hyd",chennai:"maa",mumbai:"mum",pune:"pnq"};return aliases[key]??key;}
function matchesLeadScope(row:Row,scope:LeadOwnerScope){
 return text(row.team_code).toLowerCase()===text(scope.teamCode).toLowerCase()
  &&scopeList(row.service_codes_json).some(service=>normalizeLeadServiceCode(service)===normalizeLeadServiceCode(scope.serviceCode))
  &&scopeList(row.city_ids_json).some(city=>scopeCity(city)===scopeCity(scope.cityId));
}

/**
 * Picks the least-loaded active member of the lead-assignment roster, or leaves the lead unassigned.
 * When a creation path supplies scope, only a member whose team, service and city all match can own it.
 */
export async function assignLeadOwner(db:Db,input:{customerId:string;service?:string|null;leadId?:string|null;preferred?:string|null;recordException?:boolean;scope?:LeadOwnerScope}):Promise<LeadOwnerAssignment>{
  await ensureLeadOwnerTables(db);
  const preferred=await resolveLeadOwner(db,input.preferred);
  if(preferred&&!input.scope)return{owner:preferred,resolved:true};

  const candidates=await db.prepare(
    `SELECT u.email email,m.service_codes_json,m.city_ids_json,m.team_code,(SELECT COUNT(*) FROM lead_work_items w WHERE w.owner=u.email AND w.status IN ('active','sla_breached','qualified')) load
     FROM lead_assignment_memberships m JOIN app_users u ON lower(u.email)=lower(m.employee_email)
     WHERE m.active=1 AND u.status='active'
     ORDER BY load ASC, u.email ASC`).all<Row>().catch(()=>({results:[] as Row[]}));
  const eligible=input.scope?candidates.results.filter(row=>matchesLeadScope(row,input.scope!)):candidates.results;
  const chosen=input.scope&&preferred?eligible.find(row=>text(row.email)===preferred):eligible[0];
  if(chosen)return{owner:String(chosen.email),resolved:true};

  if(input.recordException!==false)await db.prepare("INSERT INTO lead_owner_mapping_exceptions (id,scope,customer_id,lead_id,requested_owner,reason,resolved_at,resolved_by,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)")
    .bind(`LOE-${crypto.randomUUID().slice(0,10).toUpperCase()}`,"assignment_at_creation",text(input.customerId)||null,text(input.leadId)||null,
      text(input.preferred)||null,"No active lead-assignment member could be resolved for this lead",Date.now()).run();
  return{owner:UNASSIGNED_OWNER,resolved:false,reason:"no_active_lead_assignment_member"};
}

export async function leadOwnerMappingExceptions(db:Db){
  await ensureLeadOwnerTables(db);
  const owners=await db.prepare("SELECT DISTINCT owner FROM lead_work_items WHERE owner IS NOT NULL AND trim(owner)!='' AND owner!=? AND status NOT IN ('closed','converted')").bind(UNASSIGNED_OWNER).all<Row>().catch(()=>({results:[] as Row[]}));
  const unresolvedOwners:string[]=[];
  for(const row of owners.results){
    const owner=text(row.owner);
    if(!owner)continue;
    if(!await resolveLeadOwner(db,owner))unresolvedOwners.push(owner);
  }
  const open=await db.prepare("SELECT COUNT(*) n FROM lead_owner_mapping_exceptions WHERE resolved_at IS NULL").first<Row>().catch(()=>null);
  const unassigned=await db.prepare("SELECT COUNT(*) n FROM lead_work_items WHERE owner=? AND status NOT IN ('closed','converted')").bind(UNASSIGNED_OWNER).first<Row>().catch(()=>null);
  return{
    unresolvedOwners:unresolvedOwners.sort(),
    unassignedAtCreation:Number(open?.n||0),
    unassignedLeads:Number(unassigned?.n||0),
    backfilled:false,
    guidance:"Operations must map each unresolved owner label to a real staff login. Nothing is rewritten automatically: a guess that is right today is wrong the first time two people share a first name.",
  };
}
