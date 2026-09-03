import { defaultRoles, hasPermission, isFullAccessRole, parsePermissions, permissionCatalog, type Permission } from "../../../lib/platform-security";
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
 *
 * DEFAULTS TO 403, and that default is the point. Every refusal on this surface except one is an
 * AUTHORIZATION refusal - "you may not do this" - and they all used to answer 400 Bad Request, which
 * says "you sent something malformed" about a request that was well-formed and deliberate. A client
 * could not distinguish a deliberate escalation attempt from a typo, and the ordinary way an
 * authorization probe gets spotted - an alert on 403 volume - never fired. The one genuine bad-input
 * case, an unknown role code, still passes 400 explicitly.
 */
async function denyAndAudit(db:D1Database,current:Awaited<ReturnType<typeof resolveActor>>,action:string,resourceType:string,resourceId:string|null,reason:string,detail:Record<string,unknown>,message:string,status=403){
 await securityAudit(db,current,action,resourceType,resourceId,"denied",{reason,...detail});
 return Response.json({error:message},{status});
}

/**
 * The permissions a role actually carries, read from the DATABASE definition rather than from the
 * compiled defaults, so a role edited after deploy is measured as it currently is.
 */
async function roleGrants(db:D1Database,code:string){
 const row=await db.prepare("SELECT permissions_json FROM role_definitions WHERE lower(code)=?").bind(normaliseCode(code)).first<{permissions_json:string}>().catch(()=>null);
 return row?parsePermissions(row.permissions_json):null;
}

/**
 * Grants in `requested` that the actor does not itself hold. Empty means the actor has the clearance.
 *
 * THE RULE THIS IMPLEMENTS: you cannot hand out authority you do not have, to anyone, including
 * yourself. It is what closes the gap the protected-role set could never cover.
 *
 * The protected set is derived from the wildcard, so it stops escalation UPWARDS to founder/superuser.
 * It says nothing about SIDEWAYS: `admin` holds users.manage and not finance.manage, `finance` is not a
 * wildcard role, and update_user compared nothing against the acting identity - so an admin could PUT
 * its own row to roleCode:"finance" and come out of the request holding finance.manage,
 * payments.manage, payroll.manage and compensation.view. Neither role is "higher" than the other, which
 * is exactly why a rank-based guard would not have caught it.
 *
 * Deliberately NOT a self-check. Blocking only self-directed changes would leave the same escalation
 * available through a second account the actor also controls, and would wrongly permit handing a
 * colleague authority the actor cannot exercise. The question is about the GRANT, not about who is
 * receiving it - so it holds for self, for a colleague, and for a brand-new account alike.
 *
 * A wildcard actor (founder, superuser, the development preview) holds everything and is unaffected.
 */
function unheldGrants(current:Awaited<ReturnType<typeof resolveActor>>,requested:readonly string[]){
 if(current.permissions.includes("*"))return [] as string[];
 const held=new Set(current.permissions);
 return requested.filter(grant=>!held.has(grant));
}

export async function GET(request:Request){
  // dashboard.view is what the gateway already declares for this path (lib/api-gateway.ts). The
  // handler enforced nothing, so any identity resolveActor accepted - including a customer or
  // provider platform session - could read the whole role catalogue, the permission vocabulary and
  // recent import batches. The user list was already gated on users.manage; the security model
  // describing who can do what was not.
  //
  // Order matters: authorization runs before this route's own ensureTables(), so a denied caller no
  // longer triggers route-owned DDL. resolveActor() still calls ensureSecurityTables(), which is
  // unavoidable - deciding who the caller is means reading app_users and role_definitions - but that
  // is the shared identity path every guarded route uses, not schema this route owns.
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
      if(!definedRole)return denyAndAudit(db,current,"create_user","identity",email,"unknown_role",{requestedRoleCode:roleCode},`Unknown role '${roleCode}'`,400);
      // create_user is the OTHER writer of role_code. A clearance rule applied only to update_user would
      // leave this door open: create the account already carrying the grant instead of promoting one
      // into it. Same rule, same wording, both actions.
      const createUnheld=unheldGrants(current,await roleGrants(db,roleCode)??[]);
      if(createUnheld.length)return denyAndAudit(db,current,"create_user","identity",email,"insufficient_clearance",{requestedRoleCode:roleCode,unheldGrants:createUnheld},`You cannot create an account holding ${createUnheld.join(", ")} — that is authority you do not hold yourself`);
      // This used to INSERT ... ON CONFLICT(email) DO UPDATE SET role_code=excluded.role_code, so
      // "create" silently behaved as "update" for any address that already existed - including a
      // founder's, whose record it would rewrite. Create now creates: an existing email is a conflict.
      const existing=await db.prepare("SELECT role_code FROM app_users WHERE email=?").bind(email).first<{role_code:string}>();
      if(existing)return denyAndAudit(db,current,"create_user","identity",email,"email_already_exists",{},"An account with that email already exists. Change its role from the user directory instead — create never edits an existing identity.",409);
      await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),email,name,roleCode,"active",now,now).run(); await securityAudit(db,current,"create_user","identity",email,"completed",{roleCode});
      return Response.json({ok:true});
    }
    if(action==="update_user"){
      // `email` is selected purely so the audit row can say whether the attempt was self-directed. It
      // is NOT what the clearance rule turns on - see unheldGrants for why a self-check would be the
      // wrong guard - but it is the single most useful fact when reading the trail afterwards.
      requirePermission(current,"users.manage"); const id=String(body.id||""); const target=await db.prepare("SELECT role_code,email FROM app_users WHERE id=?").bind(id).first<{role_code:string;email:string}>();
      const protectedCodes=await protectedRoleCodes(db);
      // A holder of a full-access role cannot be edited from here, and a full-access role cannot be
      // handed out from here. The first half existed; the second was missing entirely.
      if(protectedCodes.has(normaliseCode(target?.role_code)))return denyAndAudit(db,current,"update_user","identity",id,"protected_holder_edit_blocked",{targetRoleCode:normaliseCode(target?.role_code)},"Founder and Superuser access cannot be changed from user management");
      if(protectedCodes.has(normaliseCode(body.roleCode)))return denyAndAudit(db,current,"update_user","identity",id,"full_access_role_assignment_blocked",{requestedRoleCode:String(body.roleCode??"")},"Founder and Superuser carry full access and cannot be assigned from user management");
      // An unvalidated role_code produced an account that authenticates and then authorises nothing.
      const assigned=String(body.roleCode||"associate");
      const known=await db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(assigned).first();
      if(!known)return denyAndAudit(db,current,"update_user","identity",id,"unknown_role",{requestedRoleCode:assigned},`Unknown role '${assigned}'`,400);
      // The clearance rule. See unheldGrants: an actor may not move any account - its own included -
      // into a role carrying authority the actor cannot exercise itself.
      const unheld=unheldGrants(current,await roleGrants(db,assigned)??[]);
      if(unheld.length)return denyAndAudit(db,current,"update_user","identity",id,"insufficient_clearance",{requestedRoleCode:assigned,unheldGrants:unheld,selfDirected:normaliseCode(target?.email)===normaliseCode(current.email)},`'${assigned}' carries ${unheld.join(", ")}, which you do not hold — you cannot assign authority you do not have`);
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
      if(!definition)return denyAndAudit(db,current,"save_role","role",code,"unknown_role",{requestedRoleCode:code},`Unknown role '${code}'`,400);
      if(isFullAccessRole(definition.permissions_json))return denyAndAudit(db,current,"save_role","role",code,"full_access_role_edit_blocked",{},"Founder and Superuser permissions are protected");
      if(Number(definition.system_role)===1)return denyAndAudit(db,current,"save_role","role",code,"built_in_role_edit_blocked",{},"Built-in role permissions are immutable: they are restored from the platform definition on every deploy, so a change here would not survive. Create a custom role instead.");
      // TWO filters, in this order, and the order matters.
      //
      // First the catalogue, which drops anything the platform does not define - including "*", which
      // is deliberately absent from permissionCatalog. That is what stops the wildcard being smuggled
      // into a role definition, and it must run first so a caller submitting ["*"] gets a sanitised
      // empty role rather than a clearance refusal naming a permission that does not exist.
      const permissions=parsePermissions(body.permissions).filter(p=>permissionCatalog.includes(p as Permission));
      // Then clearance, against the ACTOR'S OWN grants rather than the global catalogue. Filtering only
      // against the catalogue meant "is this a real permission", never "may YOU give it away" - so a
      // custom role holding nothing but roles.manage could mint a role carrying finance.manage and have
      // somebody wear it. Two steps from a state a founder can legitimately create.
      const roleUnheld=unheldGrants(current,permissions);
      if(roleUnheld.length)return denyAndAudit(db,current,"save_role","role",code,"insufficient_clearance",{unheldGrants:roleUnheld},`You cannot grant ${roleUnheld.join(", ")} — that is authority you do not hold yourself`);
      await db.prepare("UPDATE role_definitions SET permissions_json=?,updated_at=? WHERE code=?").bind(JSON.stringify(permissions),now,code).run(); await securityAudit(db,current,"save_role","role",code,"completed",{permissions}); return Response.json({ok:true});
    }
    return Response.json({error:"Unknown action"},{status:400});
  }catch(error){if(error instanceof Response)return error;return Response.json({error:"Unable to update governance controls"},{status:500});}
}
