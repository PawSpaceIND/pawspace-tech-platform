/**
 * Who owns a lead. [PTJA-W3-CO]
 *
 * THE APPROVED RULE, in the business's own words:
 *   Replace roster first names with stable application user IDs. Ownership must reference a real
 *   app_users/staff identity. Do not guess that "Neha" corresponds to a particular login. Until
 *   Operations provides the mapping, leave those records unassigned and report the mapping exception.
 *   Do not weaken masking because the owner could not be resolved.
 *
 * WHAT WAS MEASURED BEFORE. Three lead-creation paths assigned ownership from a hardcoded list of first
 * names - app/api/crm, app/api/revenue-crm and app/api/public-contact each carried the same four-name
 * array, and lib/app-to-revenue-funnel carried it as SALES_OWNERS and picked one by hashing the
 * customer id. None of those strings is a login.
 *
 * The array itself is not reproduced anywhere in this file on purpose: the sweep in
 * tests/ptja-w3-lead-owner-identity.test.mjs looks for that literal shape across lib and app/api, and a
 * comment quoting it would trip the guard exactly as a real one would - a control that exempts prose is
 * a control somebody eventually writes their roster into a comment to dodge. Nothing could tell which human "Neha" is, so the lead
 * had no owner anybody could page, no owner whose permissions could be checked, and no owner an
 * assignment could be handed over FROM. The governed path in lib/lead-assignment-governance.ts already
 * writes a real employee email or 'Unassigned'; these three never went through it.
 *
 * WHY NOTHING IS BACKFILLED. Deciding that the "Neha" on a two-year-old lead is neha.verma@ is a guess,
 * and a guess that happens to be right today is wrong the first time two Nehas exist. Legacy rows are
 * REPORTED so Operations can supply the mapping, and left exactly as they are until they do.
 */
import{ensureLeadAssignmentTables}from"./lead-assignment-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

/** What an unowned lead carries. The same literal lib/lead-assignment-governance.ts already writes. */
export const UNASSIGNED_OWNER="Unassigned";

const ownerTablesReady=new WeakSet<Db>();
export async function ensureLeadOwnerTables(db:Db){
  if(ownerTablesReady.has(db))return;
  await ensureLeadAssignmentTables(db).catch(()=>{});
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    /*
     * The queue Operations works from. A lead that could not be given a real owner is not a silent
     * failure - somebody has to either name the human or accept that the lead is unowned, and neither
     * happens if the only record is the string 'Unassigned' sitting in a column.
     */
    db.prepare("CREATE TABLE IF NOT EXISTS lead_owner_mapping_exceptions (id TEXT PRIMARY KEY,scope TEXT NOT NULL,customer_id TEXT,lead_id TEXT,requested_owner TEXT,reason TEXT NOT NULL,resolved_at INTEGER,resolved_by TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_owner_exceptions ON lead_owner_mapping_exceptions(resolved_at,created_at)"),
  ]);
  ownerTablesReady.add(db);
}

/**
 * Turns a hint into a real staff identity, or returns null.
 *
 * EXACT MATCHES ONLY - an email or a user id. Deliberately NOT a name match: "Neha" is a roster label,
 * and resolving it against a staff member whose display name begins with it is the guess the rule
 * forbids. It would even look correct today, which is what makes it dangerous: it becomes wrong the
 * first time a second Neha joins, and nothing would announce that it had.
 */
export async function resolveLeadOwner(db:Db,hint:string|null|undefined):Promise<string|null>{
  const value=text(hint);
  if(!value||value===UNASSIGNED_OWNER)return null;
  // Positional, with the value repeated. See the note in lib/service-policy-governance.ts: node:sqlite's
  // numbered-parameter handling differs between the Node CI pins and the one this container runs.
  const row=await db.prepare("SELECT email FROM app_users WHERE status='active' AND (lower(email)=lower(?) OR id=?)").bind(value,value).first<Row>().catch(()=>null);
  return row?String(row.email):null;
}

export type LeadOwnerAssignment={owner:string;resolved:boolean;reason?:string};

/**
 * Picks the least-loaded active member of the lead-assignment roster, or leaves the lead unassigned.
 *
 * The candidate list is lead_assignment_memberships INNER JOINed to app_users, so a membership row for
 * somebody whose login has since been disabled cannot receive work - the membership table alone would
 * happily keep naming them.
 */
export async function assignLeadOwner(db:Db,input:{customerId:string;service?:string|null;leadId?:string|null;preferred?:string|null}):Promise<LeadOwnerAssignment>{
  await ensureLeadOwnerTables(db);
  const preferred=await resolveLeadOwner(db,input.preferred);
  if(preferred)return{owner:preferred,resolved:true};

  const candidates=await db.prepare(
    `SELECT u.email email,(SELECT COUNT(*) FROM lead_work_items w WHERE w.owner=u.email AND w.status IN ('active','sla_breached','qualified')) load
     FROM lead_assignment_memberships m JOIN app_users u ON lower(u.email)=lower(m.employee_email)
     WHERE m.active=1 AND u.status='active'
     ORDER BY load ASC, u.email ASC`).all<Row>().catch(()=>({results:[] as Row[]}));
  const chosen=candidates.results[0];
  if(chosen)return{owner:String(chosen.email),resolved:true};

  // Nobody to give it to. Recorded so Operations sees a queue rather than a column full of 'Unassigned'.
  await db.prepare("INSERT INTO lead_owner_mapping_exceptions (id,scope,customer_id,lead_id,requested_owner,reason,resolved_at,resolved_by,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)")
    .bind(`LOE-${crypto.randomUUID().slice(0,10).toUpperCase()}`,"assignment_at_creation",text(input.customerId)||null,text(input.leadId)||null,
      text(input.preferred)||null,"No active lead-assignment member could be resolved for this lead",Date.now()).run();
  return{owner:UNASSIGNED_OWNER,resolved:false,reason:"no_active_lead_assignment_member"};
}

/**
 * What Operations still has to map.
 *
 * `unresolvedOwners` are owner strings sitting on live leads that are not a real active identity - the
 * legacy roster labels. They are listed, never rewritten.
 */
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
    // Said out loud so a reader of this report does not assume the platform will fix itself.
    backfilled:false,
    guidance:"Operations must map each unresolved owner label to a real staff login. Nothing is rewritten automatically: a guess that is right today is wrong the first time two people share a first name.",
  };
}
