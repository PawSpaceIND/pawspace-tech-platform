import { defaultRoles, hasPermission, parsePermissions, permissionCatalog, type Permission } from "../../../lib/platform-security";
import { authError, resolveActor, securityAudit } from "../../../lib/server-auth";

async function database(){const {env}=await import("cloudflare:workers");return env.DB;}
async function ensureTables(){
  const db=await database(); const now=Date.now();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS data_import_batches (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, row_count INTEGER NOT NULL, imported_count INTEGER NOT NULL, rejected_count INTEGER NOT NULL, status TEXT NOT NULL, imported_by TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS communication_attempts (id TEXT PRIMARY KEY, customer_key TEXT NOT NULL, booking_id TEXT, actor_email TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, provider TEXT NOT NULL, provider_reference TEXT, created_at INTEGER NOT NULL)"),
  ]);
  for(const role of defaultRoles){await db.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)").bind(role.code,role.name,role.description,JSON.stringify(role.permissions),1,now).run();}
}
function requirePermission(current:Awaited<ReturnType<typeof resolveActor>>,permission:Permission){if(!hasPermission(current.permissions,permission))throw new Response("Permission denied",{status:403});}

/**
 * The founder role carries ["*"] and must never be granted through ordinary user management.
 *
 * update_user checked only whether the TARGET was already a founder, never what role was being
 * ASSIGNED, so any holder of users.manage - an admin - could set a normal account's role_code to
 * "founder" and mint full authority, for someone else or for themselves. create_user got this right;
 * update_user did not, and the only test coverage was a grep for the create_user error string, which
 * is why the gap survived.
 *
 * Normalised before comparing so a padded or differently-cased value cannot slip past this guard if a
 * collation or a lookup ever stops being case-sensitive.
 */
const FOUNDER_ROLE="founder";
const isFounderRole=(value:unknown)=>String(value??"").trim().toLowerCase()===FOUNDER_ROLE;

export async function GET(request:Request){
  try{await ensureTables(); const current=await resolveActor(request);
  const db=await database();
  const roles=await db.prepare("SELECT code,name,description,permissions_json,system_role FROM role_definitions ORDER BY CASE code WHEN 'founder' THEN 0 WHEN 'superuser' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,name").all();
  const users=hasPermission(current.permissions,"users.manage")?(await db.prepare("SELECT id,email,name,role_code,status,updated_at FROM app_users ORDER BY CASE role_code WHEN 'founder' THEN 0 ELSE 1 END,name").all()).results:[];
  const batches=(await db.prepare("SELECT id,file_name,row_count,imported_count,rejected_count,status,imported_by,created_at FROM data_import_batches ORDER BY created_at DESC LIMIT 10").all()).results;
  const communications=(await db.prepare("SELECT channel,outcome,provider,COUNT(*) AS total FROM communication_attempts GROUP BY channel,outcome,provider").all()).results;
  return Response.json({authenticated:true,current:{name:current.name,email:current.email,roleCode:current.roleCode,permissions:current.permissions},permissionCatalog,roles:roles.results.map((r)=>({...r,permissions:parsePermissions((r as Record<string,unknown>).permissions_json)})),users,batches,communications,security:{centralApiGateway:true,unknownUsersDenied:true,disabledUsersDenied:true,crossOriginWritesBlocked:true,maskingDefault:true,providerCanSeePhone:false,callsServerRouted:true,secondaryFallback:true,exportsRequirePermission:true,auditEnabled:true}});}catch(error){return authError(error,"Unable to load governance controls");}
}

export async function POST(request:Request){
  try{
    await ensureTables(); const current=await resolveActor(request); const body=await request.json() as Record<string,unknown>; const action=String(body.action||""); const db=await database(); const now=Date.now();
    if(action==="create_user"){
      requirePermission(current,"users.manage"); const email=String(body.email||"").trim().toLowerCase(); const name=String(body.name||"").trim(); const roleCode=String(body.roleCode||"associate");
      if(!email.includes("@")||!name)return Response.json({error:"Name and valid email are required"},{status:400});
      if(isFounderRole(roleCode))return Response.json({error:"Founder is protected and cannot be assigned here"},{status:400});
      // This INSERT upserts on email, so passing an existing founder's address with any other role
      // would have edited that founder's record - the same protection update_user enforces, bypassed
      // through the create path.
      const existing=await db.prepare("SELECT role_code FROM app_users WHERE email=?").bind(email).first<{role_code:string}>();
      if(isFounderRole(existing?.role_code))return Response.json({error:"Founder access cannot be changed from user management"},{status:400});
      await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role_code=excluded.role_code,status='active',updated_at=excluded.updated_at").bind(crypto.randomUUID(),email,name,roleCode,"active",now,now).run(); await securityAudit(db,current,"create_user","identity",email,"completed",{roleCode});
      return Response.json({ok:true});
    }
    if(action==="update_user"){
      requirePermission(current,"users.manage"); const id=String(body.id||""); const target=await db.prepare("SELECT role_code FROM app_users WHERE id=?").bind(id).first<{role_code:string}>();
      if(isFounderRole(target?.role_code))return Response.json({error:"Founder access cannot be changed from user management"},{status:400});
      // The missing half: refuse ASSIGNING founder, not just refuse editing an existing founder.
      if(isFounderRole(body.roleCode)){await securityAudit(db,current,"update_user","identity",id,"denied",{reason:"founder_role_assignment_blocked",requestedRoleCode:String(body.roleCode??"")});return Response.json({error:"Founder is protected and cannot be assigned here"},{status:400});}
      await db.prepare("UPDATE app_users SET role_code=?,status=?,updated_at=? WHERE id=?").bind(String(body.roleCode||"associate"),String(body.status||"active"),now,id).run(); await securityAudit(db,current,"update_user","identity",id,"completed",{roleCode:body.roleCode,status:body.status});
      return Response.json({ok:true});
    }
    if(action==="save_role"){
      requirePermission(current,"roles.manage"); const code=String(body.code||""); if(code==="founder")return Response.json({error:"Founder permissions are protected"},{status:400});
      const permissions=parsePermissions(body.permissions).filter(p=>permissionCatalog.includes(p as Permission));
      await db.prepare("UPDATE role_definitions SET permissions_json=?,updated_at=? WHERE code=?").bind(JSON.stringify(permissions),now,code).run(); await securityAudit(db,current,"save_role","role",code,"completed",{permissions}); return Response.json({ok:true});
    }
    return Response.json({error:"Unknown action"},{status:400});
  }catch(error){if(error instanceof Response)return error;return Response.json({error:"Unable to update governance controls"},{status:500});}
}
