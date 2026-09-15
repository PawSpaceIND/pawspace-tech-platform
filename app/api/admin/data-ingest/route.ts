import{authError,authorize,database,securityAudit}from"../../../../lib/server-auth";
import{canonicalizeHeaders,normalizeIngestRow,parseCsvStream,rowFromValues,type NormalizedIngestRow}from"../../../../lib/data-ingest-normalizer";
import{ensureIngestPropensityTables,runPropensityModelRefresh}from"../../../../lib/data-ingest-propensity";
import{assignLeadOwner}from"../../../../lib/lead-owner-identity";

const MAX_ROWS=100_000,ROWS_PER_BATCH=25;
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin CRM data ingestion blocked",{status:403});}
const REQUIRED_HEADER_GROUPS=[["primary_phone","phone","mobile","mobile_number","phone_number"]];
type Db=D1Database;
async function ensureTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS canonical_pets_customer_idx ON canonical_pets(customer_id,created_at)"),
 db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,source TEXT NOT NULL,service TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',stage TEXT NOT NULL DEFAULT 'day_1',work_day INTEGER NOT NULL DEFAULT 1,assigned_at INTEGER NOT NULL,first_action_due_at INTEGER NOT NULL,manager_alert_at INTEGER NOT NULL,first_action_at INTEGER,call_attempts INTEGER NOT NULL DEFAULT 0,whatsapp_attempts INTEGER NOT NULL DEFAULT 0,last_outcome TEXT,next_action_at INTEGER,recycle_at INTEGER,recycle_cycle INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,converted_booking_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS crm_data_ingest_runs (id TEXT PRIMARY KEY,filename TEXT NOT NULL,status TEXT NOT NULL,total_rows INTEGER NOT NULL DEFAULT 0,accepted_rows INTEGER NOT NULL DEFAULT 0,rejected_rows INTEGER NOT NULL DEFAULT 0,error_json TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER)"),
]);await ensureIngestPropensityTables(db)}
/*
 * AN INGESTED LEAD IS A LEAD. [R3-C/F10]
 *
 * Every row of a CSV import was written with owner 'Unassigned' on BOTH crm_contacts and
 * lead_work_items and never went near assignLeadOwner - the function app/api/crm's POST calls for a
 * lead a rep types in. lib/lead-owner-identity.ts compares an owner to an ACTOR'S EMAIL, so a lead
 * owned by the literal string "Unassigned" is owned by nobody: it never appears in a rep's worklist,
 * never starts an SLA clock against a person, and is never chased. An import of ten thousand
 * prospects produced ten thousand of them.
 *
 * ONE assignment decision PER BATCH rather than per row, deliberately. assignLeadOwner runs a
 * candidate query ordered by each member's current open-lead load; the load cannot change until the
 * batch it is choosing for has been written, so twenty-five calls inside one batch would return the
 * same answer twenty-five times at twenty-five times the cost. Between batches it does change - each
 * flush awaits its own write - so a large file still spreads across the team, and a 100,000-row import
 * costs 4,000 extra reads rather than 100,000.
 *
 * recordException:false: an unresolved owner is one fact about the IMPORT, not one row-level incident
 * per prospect, and the row-level writer would have minted an exception row per lead.
 */
function statements(db:Db,r:NormalizedIngestRow,now:number,owner:string){return[
 db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,owner=CASE WHEN COALESCE(TRIM(crm_contacts.owner),'') IN ('','Unassigned') THEN excluded.owner ELSE crm_contacts.owner END,primary_phone=excluded.primary_phone,secondary_phone=COALESCE(excluded.secondary_phone,crm_contacts.secondary_phone),email=COALESCE(excluded.email,crm_contacts.email),area=excluded.area,pet_names=excluded.pet_names,pet_summary=excluded.pet_summary,source=excluded.source,next_action=excluded.next_action,opportunity=excluded.opportunity,updated_at=excluded.updated_at").bind(r.customerId,r.name,r.primaryPhone,r.secondaryPhone,r.email,r.area,r.pet?.name||null,r.pet?`${r.pet.species} · ${r.pet.breed}`:null,"New lead",owner,r.source,"AI propensity seeded",r.service,now,now),
 db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'{}',?,?) ON CONFLICT(id) DO UPDATE SET city_id=excluded.city_id,name=excluded.name,primary_phone=excluded.primary_phone,secondary_phone=COALESCE(excluded.secondary_phone,canonical_customers.secondary_phone),email=COALESCE(excluded.email,canonical_customers.email),source=excluded.source,updated_at=excluded.updated_at").bind(r.customerId,r.cityId,r.name,r.primaryPhone,r.secondaryPhone,r.email,r.source,now,now),
 ...(r.pet?[db.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,'not_provided',?, ?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,species=excluded.species,breed=excluded.breed,updated_at=excluded.updated_at").bind(r.pet.id,r.customerId,r.pet.name,r.pet.species,r.pet.breed,r.pet.id,now,now)]:[]),
 db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,'Sales Manager','active','day_1',1,?,?,?,0,0,?,0,0,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,service=excluded.service,owner=CASE WHEN COALESCE(TRIM(lead_work_items.owner),'') IN ('','Unassigned') THEN excluded.owner ELSE lead_work_items.owner END,updated_at=excluded.updated_at").bind(r.leadId,r.customerId,r.source,r.service,owner,now,now,now+30*60_000,now,now,now),
 ]}
async function flush(db:Db,rows:NormalizedIngestRow[],batchId:string){if(!rows.length)return;const now=Date.now();
 const ownership=await assignLeadOwner(db,{customerId:rows[0].customerId,leadId:rows[0].leadId,service:rows[0].service,recordException:false}).catch(()=>null);
 const owner=ownership?.owner||"Unassigned";
 await db.batch(rows.flatMap(r=>statements(db,r,now,owner)));await runPropensityModelRefresh(db,rows,batchId,now);
 return{owner,resolved:Boolean(ownership?.resolved)};}
export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"customers.manage");const type=request.headers.get("content-type")||"";if(!type.includes("text/csv")&&!type.includes("application/csv")&&!type.includes("application/octet-stream"))return Response.json({error:"Upload must be CSV (text/csv)"},{status:415});if(!request.body)return Response.json({error:"CSV body is required"},{status:400});const db=await database();await ensureTables(db);const batchId=`INGEST-${crypto.randomUUID().slice(0,12).toUpperCase()}`,filename=(request.headers.get("x-file-name")||"raw-customer-export.csv").slice(0,180),createdAt=Date.now();await db.prepare("INSERT INTO crm_data_ingest_runs (id,filename,status,created_by,created_at) VALUES (?,?,'processing',?,?)").bind(batchId,filename,actor.email,createdAt).run();
 let headers:string[]|null=null,total=0,accepted=0,rejected=0;const errors:string[]=[],pending:NormalizedIngestRow[]=[];let ownership:{owner:string;resolved:boolean}|null=null;for await(const values of parseCsvStream(request.body)){if(!headers){headers=canonicalizeHeaders(values);const missing=REQUIRED_HEADER_GROUPS.filter(group=>!group.some(h=>headers!.includes(h)));if(missing.length)throw new Response("CSV requires a primary phone column",{status:400});continue}total++;if(total>MAX_ROWS)throw new Response(`CSV exceeds ${MAX_ROWS} row limit`,{status:413});try{pending.push(normalizeIngestRow(rowFromValues(headers,values),total+1));accepted++;if(pending.length>=ROWS_PER_BATCH){ownership=await flush(db,pending.splice(0),batchId)??ownership}}catch(error){rejected++;if(errors.length<100)errors.push(error instanceof Error?error.message:`row_${total+1}: normalization_failed`)}}
 ownership=await flush(db,pending,batchId)??ownership;await db.prepare("UPDATE crm_data_ingest_runs SET status='completed',total_rows=?,accepted_rows=?,rejected_rows=?,error_json=?,completed_at=? WHERE id=?").bind(total,accepted,rejected,JSON.stringify(errors),Date.now(),batchId).run();await securityAudit(db,actor,"crm.data_ingest","crm_data_ingest_run",batchId,"completed",{totalRows:total,acceptedRows:accepted,rejectedRows:rejected,propensitySeeded:true,financialSystemsTouched:false});/* The import says who it assigned these leads to. An import that lands unowned is a real outcome the
 * operator has to act on - it is not "imported successfully". */
 return Response.json({ok:true,batchId,totalRows:total,acceptedRows:accepted,rejectedRows:rejected,errorSample:errors,propensitySeeded:true,petTarget:"canonical_pets",leadOwner:ownership?.owner??null,leadOwnerResolved:Boolean(ownership?.resolved),leadOwnerNote:ownership&&!ownership.resolved?"No active lead-assignment member matched these leads; they are imported unowned and nobody will be chased until an assignment member is configured.":undefined,financialSystemsTouched:false},{status:201});
 }catch(error){if(error instanceof Response)return error;return authError(error,"Unable to ingest CRM CSV")}}
