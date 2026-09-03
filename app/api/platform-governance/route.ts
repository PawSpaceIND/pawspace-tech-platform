import { defaultRoles, hasPermission, isFullAccessRole, parsePermissions, permissionCatalog, type Permission } from "../../../lib/platform-security";
import { authError, resolveActor, securityAudit, securityAuditStatement } from "../../../lib/server-auth";

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
const normaliseCode=(value:unknown)=>String(value??"").trim().toLowerCase();

async function protectedRoleCodes(db:D1Database){
 const rows=await db.prepare("SELECT code,permissions_json FROM role_definitions").all<{code:string;permissions_json:string}>().catch(()=>({results:[]as Array<{code:string;permissions_json:string}>}));
 const codes=new Set(rows.results.filter(row=>isFullAccessRole(row.permissions_json)).map(row=>normaliseCode(row.code)));
 for(const role of defaultRoles)if(isFullAccessRole(role.permissions))codes.add(normaliseCode(role.code));
 return codes;
}

function actorMayGrantPermissions(current:Awaited<ReturnType<typeof resolveActor>>,permissions:readonly string[]){
 if(current.permissions.includes("*"))return true;
 const held=new Set(current.permissions);
 return permissions.every(permission=>held.has(permission));
}
async function roleGrant(db:D1Database,roleCode:string){
 const row=await db.prepare("SELECT code,permissions_json FROM role_definitions WHERE lower(code)=?").bind(normaliseCode(roleCode)).first<{code:string;permissions_json:string}>();
 return row?{code:normaliseCode(row.code),permissions:parsePermissions(row.permissions_json)}:null;
}

async function denyAndAudit(db:D1Database,current:Awaited<ReturnType<typeof resolveActor>>,action:string,resourceType:string,resourceId:string|null,reason:string,detail:Record<string,unknown>,message:string,status=400){
 await securityAudit(db,current,action,resourceType,resourceId,"denied",{reason,...detail});
 return Response.json({error:message},{status});
}

export async function GET(request:Request){
  try{const current=await resolveActor(request);
  requirePermission(current,"dashboard.view");
  await ensureTables();
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
      requirePermission(current,"users.manage"); const email=String(body.email||"").trim().toLowerCase(); const name=String(body.name||"").trim(); const roleCode=normaliseCode(String(body.roleCode||"associate"));
      if(!email.includes("@")||!name)return Response.json({error:"Name and valid email are required"},{status:400});
      const protectedCodes=await protectedRoleCodes(db);
      if(protectedCodes.has(roleCode))return denyAndAudit(db,current,"create_user","identity",email,"full_access_role_assignment_blocked",{requestedRoleCode:roleCode},"Founder and Superuser carry full access and cannot be assigned from user management");
      const grant=await roleGrant(db,roleCode);
      if(!grant)return denyAndAudit(db,current,"create_user","identity",email,"unknown_role",{requestedRoleCode:roleCode},`Unknown role '${roleCode}'`);
      if(!actorMayGrantPermissions(current,grant.permissions))return denyAndAudit(db,current,"create_user","identity",email,"delegation_exceeds_actor_grants",{requestedRoleCode:roleCode,requestedPermissions:grant.permissions},"You cannot assign a role containing permissions you do not currently hold",403);
      const existing=await db.prepare("SELECT role_code FROM app_users WHERE email=?").bind(email).first<{role_code:string}>();
      if(existing)return denyAndAudit(db,current,"create_user","identity",email,"email_already_exists",{},"An account with that email already exists. Change its role from the user directory instead — create never edits an existing identity.",409);
      const id=crypto.randomUUID();
      await db.batch([
        db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(id,email,name,roleCode,"active",now,now),
        securityAuditStatement(db,current,"create_user","identity",email,"completed",{roleCode}),
      ]);
      return Response.json({ok:true});
    }
    if(action==="update_user"){
      requirePermission(current,"users.manage"); const id=String(body.id||""); const target=await db.prepare("SELECT id,email,role_code,status FROM app_users WHERE id=?").bind(id).first<{id:string;email:string;role_code:string;status:string}>();
      if(!target)return denyAndAudit(db,current,"update_user","identity",id,"target_not_found",{},"User not found",404);
      const assigned=normaliseCode(body.roleCode||"associate"),currentTargetRole=normaliseCode(target.role_code);
      const protectedCodes=await protectedRoleCodes(db);
      if(protectedCodes.has(currentTargetRole))return denyAndAudit(db,current,"update_user","identity",id,"protected_holder_edit_blocked",{targetRoleCode:currentTargetRole},"Founder and Superuser access cannot be changed from user management");
      if(protectedCodes.has(assigned))return denyAndAudit(db,current,"update_user","identity",id,"full_access_role_assignment_blocked",{requestedRoleCode:assigned},"Founder and Superuser carry full access and cannot be assigned from user management");
      if(String(target.email).trim().toLowerCase()===current.email.trim().toLowerCase()&&assigned!==currentTargetRole)return denyAndAudit(db,current,"update_user","identity",id,"self_role_change_blocked",{currentRoleCode:currentTargetRole,requestedRoleCode:assigned},"Administrative actors cannot change their own role",403);
      const grant=await roleGrant(db,assigned);
      if(!grant)return denyAndAudit(db,current,"update_user","identity",id,"unknown_role",{requestedRoleCode:assigned},`Unknown role '${assigned}'`);
      if(!actorMayGrantPermissions(current,grant.permissions))return denyAndAudit(db,current,"update_user","identity",id,"delegation_exceeds_actor_grants",{requestedRoleCode:assigned,requestedPermissions:grant.permissions},"You cannot assign a role containing permissions you do not currently hold",403);
      const status=String(body.status||"active");
      await db.batch([
        db.prepare("UPDATE app_users SET role_code=?,status=?,updated_at=? WHERE id=?").bind(assigned,status,now,id),
        securityAuditStatement(db,current,"update_user","identity",id,"completed",{roleCode:assigned,status}),
      ]);
      return Response.json({ok:true});
    }
    if(action==="save_role"){
      requirePermission(current,"roles.manage"); const code=normaliseCode(body.code||"");
      const definition=await db.prepare("SELECT system_role,permissions_json FROM role_definitions WHERE lower(code)=?").bind(code).first<{system_role:number;permissions_json:string}>();
      if(!definition)return denyAndAudit(db,current,"save_role","role",code,"unknown_role",{requestedRoleCode:code},`Unknown role '${code}'`);
      if(isFullAccessRole(definition.permissions_json))return denyAndAudit(db,current,"save_role","role",code,"full_access_role_edit_blocked",{},"Founder and Superuser permissions are protected");
      if(Number(definition.system_role)===1)return denyAndAudit(db,current,"save_role","role",code,"built_in_role_edit_blocked",{},"Built-in role permissions are immutable: they are restored from the platform definition on every deploy, so a change here would not survive. Create a custom role instead.");
      const permissions=parsePermissions(body.permissions).filter(p=>permissionCatalog.includes(p as Permission));
      if(!actorMayGrantPermissions(current,permissions))return denyAndAudit(db,current,"save_role","role",code,"delegation_exceeds_actor_grants",{requestedPermissions:permissions},"You cannot grant permissions you do not currently hold",403);
      await db.batch([
        db.prepare("UPDATE role_definitions SET permissions_json=?,updated_at=? WHERE code=?").bind(JSON.stringify(permissions),now,code),
        securityAuditStatement(db,current,"save_role","role",code,"completed",{permissions}),
      ]);
      return Response.json({ok:true});
    }
    return Response.json({error:"Unknown action"},{status:400});
  }catch(error){if(error instanceof Response)return error;return Response.json({error:"Unable to update governance controls"},{status:500});}
}
