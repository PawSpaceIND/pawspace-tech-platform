import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import { defaultRoles, hasPermission, isFullAccessRole, parsePermissions, permissionCatalog, type Permission } from "../../../lib/platform-security";
import{authError,resolveActor,securityAudit}from"../../../lib/server-auth";

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
 * Roles that must never be granted through ordinary user management, resolved from the DATABASE rather
 * than from a list of names.
 *
 * update_user checked only whether the TARGET was already a founder - never what role was being
 * ASSIGNED - so any holder of users.manage could mint full authority for someone else or for
 * themselves. Guarding the literal "founder" was not enough either: `superuser` is also defined as
 * ["*"], so blocking one name left the other wide open. A role is protected here because of what it
 * can do, which means a new ["*"] role is covered the moment it exists.
 *
 * Codes are normalised before comparing so a padded or differently-cased value cannot slip past if a
 * collation or a lookup ever stops being case-sensitive.
 */
const normaliseCode=(value:unknown)=>String(value??"").trim().toLowerCase();
async function protectedRoleCodes(db:D1Database){
 const rows=await db.prepare("SELECT code,permissions_json FROM role_definitions").all<{code:string;permissions_json:string}>().catch(()=>({results:[]as Array<{code:string;permissions_json:string}>}));
 const codes=new Set(rows.results.filter(row=>isFullAccessRole(row.permissions_json)).map(row=>normaliseCode(row.code)));
 // Belt and braces: if role_definitions has not been seeded yet, fall back to the compiled defaults so
 // an unseeded database cannot be the window in which a protected role is assignable.
 for(const role of defaultRoles)if(isFullAccessRole(role.permissions))codes.add(normaliseCode(role.code));
 return codes;
}

/**
 * Record a refused mutation and return its response.
 *
 * Every refusal here is a security-relevant event, but only three paths wrote one: an attempt to edit an
 * existing protected holder, to assign an unknown role, or to edit a protected or built-in role all
 * returned silently. The audit trail therefore showed some attempts to escalate and not others, which is
 * worse than none - it reads as a complete record. None of these paths touch business state; the audit
 * row is the only write.
 */
async function denyAndAudit(db:D1Database,current:Awaited<ReturnType<typeof resolveActor>>,action:string,resourceType:string,resourceId:string|null,reason:string,detail:Record<string,unknown>,message:string,status=400){
 await securityAudit(db,current,action,resourceType,resourceId,"denied",{reason,...detail});
 return Response.json({error:message},{status});
}

export async function GET(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;
  try{await ensureTables(); const current=await resolveActor(request);
  const db=await database();
  const roles=await db.prepare("SELECT code,name,description,permissions_json,system_role FROM role_definitions ORDER BY CASE code WHEN 'founder' THEN 0 WHEN 'superuser' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,name").all();
  const users=hasPermission(current.permissions,"users.manage")?(await db.prepare("SELECT id,email,name,role_code,status,updated_at FROM app_users ORDER BY CASE role_code WHEN 'founder' THEN 0 ELSE 1 END,name").all()).results:[];
  const batches=(await db.prepare("SELECT id,file_name,row_count,imported_count,rejected_count,status,imported_by,created_at FROM data_import_batches ORDER BY created_at DESC LIMIT 10").all()).results;
  const communications=(await db.prepare("SELECT channel,outcome,provider,COUNT(*) AS total FROM communication_attempts GROUP BY channel,outcome,provider").all()).results;
  return Response.json({authenticated:true,current:{name:current.name,email:current.email,roleCode:current.roleCode,permissions:current.permissions},permissionCatalog,roles:roles.results.map((r)=>({...r,permissions:parsePermissions((r as Record<string,unknown>).permissions_json)})),users,batches,communications,security:{centralApiGateway:true,unknownUsersDenied:true,disabledUsersDenied:true,crossOriginWritesBlocked:true,maskingDefault:true,providerCanSeePhone:false,callsServerRouted:true,secondaryFallback:true,exportsRequirePermission:true,auditEnabled:true}});}catch(error){return authError(error,"Unable to load governance controls");}
}

export async function POST(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;
  try{
    await ensureTables(); const current=await resolveActor(request); const body=await request.json() as Record<string,unknown>; const action=String(body.action||""); const db=await database(); const now=Date.now();
    if(action==="create_user"){
      requirePermission(current,"users.manage"); const email=String(body.email||"").trim().toLowerCase(); const name=String(body.name||"").trim();
      // Normalised ONCE, then used for the protection check, the existence check and the row that is
      // written. It was previously normalised only for the comparison and stored raw, so a padded or
      // differently-cased value was refused correctly when protected but persisted verbatim otherwise -
      // producing a role_code matching no definition, i.e. an account that authenticates and then
      // authorises nothing.
      const roleCode=normaliseCode(String(body.roleCode||"associate"));
      if(!email.includes("@")||!name)return Response.json({error:"Name and valid email are required"},{status:400});
      const protectedCodes=await protectedRoleCodes(db);
      if(protectedCodes.has(roleCode))return denyAndAudit(db,current,"create_user","identity",email,"full_access_role_assignment_blocked",{requestedRoleCode:roleCode},"Founder and Superuser carry full access and cannot be assigned from user management");
      // create_user never validated the role, while update_user did. An unknown role was accepted and a
      // row written for it; the guard is applied on the normalised code so it cannot be dodged by case
      // or padding. Refused BEFORE any INSERT, so no app_users row exists for a rejected role.
      const definedRole=await db.prepare("SELECT code FROM role_definitions WHERE lower(code)=?").bind(roleCode).first();
      if(!definedRole)return denyAndAudit(db,current,"create_user","identity",email,"unknown_role",{requestedRoleCode:roleCode},`Unknown role '${roleCode}'`);
      // This used to INSERT ... ON CONFLICT(email) DO UPDATE SET role_code=excluded.role_code, so
      // "create" silently behaved as "update" for any address that already existed - including a
      // founder's, whose record it would rewrite. Create now creates: an existing email is a conflict.
      const existing=await db.prepare("SELECT role_code FROM app_users WHERE email=?").bind(email).first<{role_code:string}>();
      if(existing)return denyAndAudit(db,current,"create_user","identity",email,"email_already_exists",{},"An account with that email already exists. Change its role from the user directory instead — create never edits an existing identity.",409);
      await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),email,name,roleCode,"active",now,now).run(); await securityAudit(db,current,"create_user","identity",email,"completed",{roleCode});
      return Response.json({ok:true});
    }
    if(action==="update_user"){
      requirePermission(current,"users.manage"); const id=String(body.id||""); const target=await db.prepare("SELECT role_code FROM app_users WHERE id=?").bind(id).first<{role_code:string}>();
      const protectedCodes=await protectedRoleCodes(db);
      // A holder of a full-access role cannot be edited from here, and a full-access role cannot be
      // handed out from here. The first half existed; the second was missing entirely.
      if(protectedCodes.has(normaliseCode(target?.role_code)))return denyAndAudit(db,current,"update_user","identity",id,"protected_holder_edit_blocked",{targetRoleCode:normaliseCode(target?.role_code)},"Founder and Superuser access cannot be changed from user management");
      if(protectedCodes.has(normaliseCode(body.roleCode)))return denyAndAudit(db,current,"update_user","identity",id,"full_access_role_assignment_blocked",{requestedRoleCode:String(body.roleCode??"")},"Founder and Superuser carry full access and cannot be assigned from user management");
      // An unvalidated role_code produced an account that authenticates and then authorises nothing.
      const assigned=String(body.roleCode||"associate");
      const known=await db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(assigned).first();
      if(!known)return denyAndAudit(db,current,"update_user","identity",id,"unknown_role",{requestedRoleCode:assigned},`Unknown role '${assigned}'`);
      await db.prepare("UPDATE app_users SET role_code=?,status=?,updated_at=? WHERE id=?").bind(String(body.roleCode||"associate"),String(body.status||"active"),now,id).run(); await securityAudit(db,current,"update_user","identity",id,"completed",{roleCode:body.roleCode,status:body.status});
      return Response.json({ok:true});
    }
    if(action==="save_role"){
      requirePermission(current,"roles.manage"); const code=String(body.code||"");
      // Previously guarded only "founder", which left superuser's ["*"] editable and said nothing about
      // the other built-ins. Built-in roles are seeded system_role=1 and are restored by
      // ensureSecurityTables, so an edit to one was silently reverted on the next Worker isolate — the
      // UI appeared to accept a change that did not survive. They are now refused explicitly rather
      // than accepted and quietly undone.
      const definition=await db.prepare("SELECT system_role,permissions_json FROM role_definitions WHERE code=?").bind(code).first<{system_role:number;permissions_json:string}>();
      if(!definition)return denyAndAudit(db,current,"save_role","role",code,"unknown_role",{requestedRoleCode:code},`Unknown role '${code}'`);
      if(isFullAccessRole(definition.permissions_json))return denyAndAudit(db,current,"save_role","role",code,"full_access_role_edit_blocked",{},"Founder and Superuser permissions are protected");
      if(Number(definition.system_role)===1)return denyAndAudit(db,current,"save_role","role",code,"built_in_role_edit_blocked",{},"Built-in role permissions are immutable: they are restored from the platform definition on every deploy, so a change here would not survive. Create a custom role instead.");
      const permissions=parsePermissions(body.permissions).filter(p=>permissionCatalog.includes(p as Permission));
      await db.prepare("UPDATE role_definitions SET permissions_json=?,updated_at=? WHERE code=?").bind(JSON.stringify(permissions),now,code).run(); await securityAudit(db,current,"save_role","role",code,"completed",{permissions}); return Response.json({ok:true});
    }
    return Response.json({error:"Unknown action"},{status:400});
  }catch(error){if(error instanceof Response)return error;return Response.json({error:"Unable to update governance controls"},{status:500});}
}
