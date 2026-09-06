import{ensureLeadAssignmentTables}from"./lead-assignment-governance";
import type{AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;

/**
 * Canonical row-level authority for staff conversations.
 *
 * `communication_threads.assigned_to` is deliberately absent. It is an inbox/work-state projection
 * written by AI handoff and takeover flows, not an ownership grant.
 */
export type ConversationAccessActor=Pick<AuthenticatedActor,"email"|"roleCode"|"permissions"|"developmentPreview">;

const accessEnsured=new WeakSet<D1Database>();
const accessEnsuring=new WeakMap<D1Database,Promise<void>>();
export async function ensureConversationAccessTables(db:D1Database){
 if(accessEnsured.has(db))return;
 const pending=accessEnsuring.get(db);if(pending)return pending;
 const operation=(async()=>{
  await ensureLeadAssignmentTables(db);
  // CRM contacts are the canonical lead-city source. Some older environments create this table from
  // a route rather than a shared migration, so guarantee the same additive schema before access SQL.
  await db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  const columns=await db.prepare("PRAGMA table_info(crm_contacts)").all<Row>();
  if(!columns.results.some(column=>String(column.name)==="area")){
   try{await db.prepare("ALTER TABLE crm_contacts ADD COLUMN area TEXT").run();}
   catch(error){
    const refreshed=await db.prepare("PRAGMA table_info(crm_contacts)").all<Row>();
    if(!refreshed.results.some(column=>String(column.name)==="area"))throw error;
   }
  }
  accessEnsured.add(db);
 })();
 accessEnsuring.set(db,operation);
 try{await operation;}finally{accessEnsuring.delete(db);}
}

export function hasPlatformConversationAccess(actor:ConversationAccessActor){
 return actor.developmentPreview||actor.permissions.includes("*")||actor.roleCode==="admin";
}

/** Shared by list, detail and handoff queues so scope cannot drift between endpoints. */
export function conversationAccessPredicate(actor:ConversationAccessActor,threadAlias="t",asOf=Date.now()){
 if(hasPlatformConversationAccess(actor))return{sql:"1=1",binds:[]as unknown[]};
 const manager=actor.roleCode==="manager"?1:0;
 const sql=`EXISTS (
  SELECT 1
  FROM lead_work_items access_lead
  JOIN crm_contacts access_contact ON access_contact.id=access_lead.customer_id
  JOIN lead_assignment_memberships access_member
    ON lower(access_member.employee_email)=lower(?)
   AND access_member.active=1
  WHERE access_lead.customer_id=${threadAlias}.customer_id
    AND (
      ${threadAlias}.lead_id=access_lead.id
      OR (
        ${threadAlias}.lead_id IS NULL
        AND access_lead.converted_booking_id IS NULL
        AND access_lead.status NOT IN ('closed','converted')
        AND NOT EXISTS (
          SELECT 1 FROM lead_work_items access_other_lead
          WHERE access_other_lead.customer_id=${threadAlias}.customer_id
            AND access_other_lead.id!=access_lead.id
            AND access_other_lead.converted_booking_id IS NULL
            AND access_other_lead.status NOT IN ('closed','converted')
        )
      )
    )
    AND EXISTS (
      SELECT 1 FROM json_each(access_member.service_codes_json) member_service
      WHERE lower(trim(CAST(member_service.value AS TEXT)))=lower(trim(access_lead.service))
    )
    AND EXISTS (
      SELECT 1 FROM json_each(access_member.city_ids_json) member_city
      WHERE lower(COALESCE(access_contact.area,'')) LIKE '%'||lower(trim(CAST(member_city.value AS TEXT)))||'%'
    )
    AND (
      EXISTS (
        SELECT 1 FROM lead_assignments access_assignment
        WHERE access_assignment.lead_id=access_lead.id
          AND access_assignment.status='current'
          AND lower(access_assignment.team_code)=lower(access_member.team_code)
          AND (
            lower(COALESCE(access_assignment.employee_email,''))=lower(?)
            OR (?=1)
            OR (access_assignment.employee_email IS NULL AND COALESCE(access_assignment.fallback_queue,'')!='')
          )
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM lead_assignments current_assignment
          WHERE current_assignment.lead_id=access_lead.id AND current_assignment.status='current'
        )
        AND EXISTS (
          SELECT 1 FROM lead_assignment_policies access_policy
          WHERE access_policy.status='active_uat'
            AND access_policy.effective_from<=?
            AND (access_policy.effective_until IS NULL OR access_policy.effective_until>=?)
            AND lower(access_policy.team_code)=lower(access_member.team_code)
            AND EXISTS (
              SELECT 1 FROM json_each(access_policy.service_codes_json) policy_service
              WHERE lower(trim(CAST(policy_service.value AS TEXT)))=lower(trim(access_lead.service))
            )
            AND EXISTS (
              SELECT 1 FROM json_each(access_policy.city_ids_json) policy_city
              WHERE lower(COALESCE(access_contact.area,'')) LIKE '%'||lower(trim(CAST(policy_city.value AS TEXT)))||'%'
            )
        )
      )
    )
 )`;
 return{sql,binds:[actor.email,actor.email,manager,asOf,asOf]as unknown[]};
}

export async function actorCanAccessConversation(db:D1Database,actor:ConversationAccessActor,threadId:string){
 await ensureConversationAccessTables(db);
 const access=conversationAccessPredicate(actor,"t");
 const row=await db.prepare(`SELECT 1 allowed FROM communication_threads t WHERE t.id=? AND ${access.sql} LIMIT 1`).bind(threadId,...access.binds).first<Row>();
 return Boolean(row);
}
