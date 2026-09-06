/**
 * The governed home for PawSpace business policy: rules that are DECIDED by the business and must be
 * changeable per vertical and per city without a code deploy.
 *
 * Why this exists. The audit kept finding business rules welded into code paths - a refund percentage
 * inside a cancellation handler, a verification list inside an onboarding module, a masking decision
 * inside a route. Each one was invisible to the people who own the decision, identical in every city,
 * and only changeable by an engineer. The approved policy set that closes PTJA W1-F24, F38, F53,
 * W2-08-F03, W2-B2-R04/R01/C01/C07 and W2-B4-M04/M06 explicitly says these differ by service type and
 * will differ by city, so they live here: one table, one resolution rule, one audit trail, one Control
 * Center surface.
 *
 * SHAPE. A policy row is (policy_domain, service_code, city_id) -> a typed JSON config, versioned, with
 * an effective window, an owner and a reason for every change. `*` in service_code or city_id means
 * "any", so a platform-wide default and a Bengaluru-only Boarding override coexist and the more
 * specific one wins.
 *
 * RESOLUTION, most specific first:
 *   1. this service, this city
 *   2. this service, any city
 *   3. any service, this city
 *   4. any service, any city   (the seeded platform default)
 * Ties break on the highest version. A domain with no resolvable row is an ERROR, never an empty
 * object: this whole audit's most common defect was "unknown or absent treated as satisfied", and a
 * policy engine that returns {} when nothing is configured is that defect with a config table attached.
 *
 * DEFAULTS MUST BE THE STRICT VALUE. `parse` fills any key a stored row is missing from the domain's
 * defaults, so a new field can be added without breaking rows already saved. That is only safe while
 * every default is the SAFE answer - refuse, mask, require, 0% - because a stored row written before
 * the field existed will silently adopt it.
 *
 * ONE VALIDATOR, BOTH PATHS. Every domain supplies `problem(config)`, and the Control Center route runs
 * it on create AND on update. PTJA-P0-03 was exactly this hole in the Grooming policy route: a policy
 * could be CREATED with values the update path would have refused, and the reader then coerced them
 * into something weaker than the operator believed they had saved.
 */
import type{Permission}from"./platform-security";

type Db=D1Database;
type Row=Record<string,unknown>;

/** `*` matches any service or any city. */
export const POLICY_ANY="*";

export type ServicePolicyScope={serviceCode?:string|null;cityId?:string|null};

export type ServicePolicyRecord<T>={
  id:string;domain:string;serviceCode:string;cityId:string;config:T;notes:string;
  active:boolean;version:number;effectiveFrom:string;effectiveTo:string|null;updatedBy:string;updatedAt:number;
};

export type ResolvedServicePolicy<T>=ServicePolicyRecord<T>&{
  /** How the row was matched, so a caller can say WHY this policy applied. */
  matchedBy:"service_and_city"|"service_any_city"|"any_service_and_city"|"platform_default";
  policyVersion:string;
};

/**
 * What a policy domain must declare to be storable. `defaults` is merged under every stored config, so
 * every value in it must be the strict/safe answer - see the module note above.
 */
export type ServicePolicyDomain<T extends Record<string,unknown>>={
  domain:string;
  label:string;
  /** Which permission may CHANGE this domain. Reads are governed by the Control Center route. */
  managePermission:Permission;
  defaults:T;
  /** A human-readable problem with the proposed config, or null. Run on create and on update alike. */
  problem(config:Record<string,unknown>):string|null;
};

const registry=new Map<string,ServicePolicyDomain<Record<string,unknown>>>();

/** Registers a policy domain. Called once at module load by each domain that owns a policy. */
export function registerServicePolicyDomain<T extends Record<string,unknown>>(spec:ServicePolicyDomain<T>){
  registry.set(spec.domain,spec as unknown as ServicePolicyDomain<Record<string,unknown>>);
  return spec;
}
export function servicePolicyDomain(domain:string){return registry.get(domain)??null;}
export function servicePolicyDomains(){return [...registry.values()].map(spec=>({domain:spec.domain,label:spec.label,managePermission:spec.managePermission,defaults:spec.defaults}));}

const tablesEnsured=new WeakSet<Db>();
const tablesEnsuring=new WeakMap<Db,Promise<void>>();
async function servicePolicySchemaReady(db:Db){
  try{const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('service_policy_configs','idx_service_policy_lookup','service_policy_audit','idx_service_policy_audit_domain')").all<Row>();return new Set(rows.results.map(row=>String(row.name))).size===4;}catch{return false;}
}
async function ensureServicePolicyTablesUncached(db:Db){
  if(await servicePolicySchemaReady(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS service_policy_configs (id TEXT PRIMARY KEY,policy_domain TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT '*',city_id TEXT NOT NULL DEFAULT '*',config_json TEXT NOT NULL DEFAULT '{}',notes TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_policy_lookup ON service_policy_configs(policy_domain,service_code,city_id,active,effective_from,effective_to)"),
    db.prepare("CREATE TABLE IF NOT EXISTS service_policy_audit (id TEXT PRIMARY KEY,policy_id TEXT NOT NULL,policy_domain TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_service_policy_audit_domain ON service_policy_audit(policy_domain,created_at)"),
  ]);
}
export async function ensureServicePolicyTables(db:Db){
  if(tablesEnsured.has(db))return;const running=tablesEnsuring.get(db);if(running)return running;
  const pending=ensureServicePolicyTablesUncached(db).then(()=>{tablesEnsured.add(db);});tablesEnsuring.set(db,pending);
  try{await pending;}finally{if(tablesEnsuring.get(db)===pending)tablesEnsuring.delete(db);}
}

const normalise=(value:unknown)=>{const text=String(value??"").trim().toLowerCase();return text||POLICY_ANY;};
function parseJson<T>(value:unknown,fallback:T):T{try{return JSON.parse(String(value??""))as T;}catch{return fallback;}}

/**
 * Seeds the platform default for a domain: (domain, *, *). INSERT OR IGNORE, so an operator's own edit
 * is never overwritten - the same rule seedDefaultCityLaunchConfigs and seedDefaultGroomingPolicy
 * already follow.
 */
const defaultPolicySeedsReady=new WeakMap<Db,Set<string>>();
export async function seedServicePolicyDefault(db:Db,domain:string,effectiveFrom="2026-08-01"){
  const spec=registry.get(domain);if(!spec)throw new Error(`Unknown policy domain ${domain}`);await ensureServicePolicyTables(db);
  let ready=defaultPolicySeedsReady.get(db);if(!ready){ready=new Set();defaultPolicySeedsReady.set(db,ready);}if(ready.has(domain))return;
  const existing=await db.prepare("SELECT id FROM service_policy_configs WHERE policy_domain=? AND service_code='*' AND city_id='*' LIMIT 1").bind(domain).first<Row>();
  if(!existing)await db.prepare("INSERT OR IGNORE INTO service_policy_configs (id,policy_domain,service_code,city_id,config_json,notes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,1,?,NULL,'founder_seed',?)")
    .bind(`spolicy_${domain}_default`,domain,POLICY_ANY,POLICY_ANY,JSON.stringify(spec.defaults),`${spec.label} - platform default`,effectiveFrom,Date.now()).run();
  ready.add(domain);
}

/**
 * Seeds one NON-default scope, e.g. (domain, "boarding", "*"). Same INSERT OR IGNORE contract as
 * seedServicePolicyDefault: an operator's own edit is never overwritten. Used by domains whose approved
 * answer genuinely differs per service, where a single platform default would be a fiction.
 * [PTJA-W3-BT]
 */
export async function seedServicePolicyScope(db:Db,domain:string,serviceCode:string,cityId:string,config:Record<string,unknown>,notes:string,effectiveFrom="2026-08-01"){
  const spec=registry.get(domain);
  if(!spec)throw new Error(`Unknown policy domain ${domain}`);
  const problem=spec.problem({...spec.defaults,...config});
  // A seed that fails the domain's own validator would be refused the moment anybody READ it, so it is
  // refused here instead - loudly, at startup, rather than as a 409 on a customer's booking.
  if(problem)throw new Error(`Seed for ${domain}/${serviceCode}/${cityId} is invalid: ${problem}`);
  await ensureServicePolicyTables(db);
  const service=normalise(serviceCode),city=normalise(cityId);
  await db.prepare("INSERT OR IGNORE INTO service_policy_configs (id,policy_domain,service_code,city_id,config_json,notes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,1,?,NULL,'founder_seed',?)")
    .bind(`spolicy_${domain}_${service}_${city}`.replace(/\*/g,"any"),domain,service,city,JSON.stringify({...spec.defaults,...config}),notes,effectiveFrom,Date.now()).run();
}

function rowToRecord<T extends Record<string,unknown>>(spec:ServicePolicyDomain<T>,row:Row):ServicePolicyRecord<T>{
  // Missing keys come from the domain defaults, so adding a field does not break a stored row. Every
  // default is the strict answer, which is what makes that safe.
  const stored=parseJson<Record<string,unknown>>(row.config_json,{});
  return{
    id:String(row.id),domain:String(row.policy_domain),serviceCode:String(row.service_code),cityId:String(row.city_id),
    config:{...spec.defaults,...stored} as T,notes:String(row.notes||""),active:Number(row.active)===1,version:Number(row.version||1),
    effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to?String(row.effective_to):null,
    updatedBy:String(row.updated_by||""),updatedAt:Number(row.updated_at||0),
  };
}

const MATCHED_BY=["service_and_city","service_any_city","any_service_and_city","platform_default"] as const;

/**
 * The policy in force for a domain at a scope. Throws a 409 naming the domain when nothing resolves,
 * and a 409 naming the row when what resolved does not satisfy its own domain's validator - a policy
 * nobody can vouch for must not be silently evaluated.
 */
export async function resolveServicePolicy<T extends Record<string,unknown>>(db:Db,domain:string,scope:ServicePolicyScope={},at=new Date()):Promise<ResolvedServicePolicy<T>>{
  const spec=registry.get(domain) as ServicePolicyDomain<T>|undefined;
  if(!spec)throw new Error(`Unknown policy domain ${domain}`);
  await seedServicePolicyDefault(db,domain);
  const serviceCode=normalise(scope.serviceCode),cityId=normalise(scope.cityId),date=at.toISOString().slice(0,10);
  /*
   * POSITIONAL placeholders, with each value repeated, rather than numbered ?1/?2 reused across the
   * statement. Numbered parameters are valid SQLite, but node:sqlite's handling of them changed between
   * Node 22.13 (which CI pins) and 22.22 (which this container runs): CI failed 344 tests with
   * "column index out of range" on a query that passed locally. Repeating the bind is portable across
   * both, and a query that only works on the developer's Node is not a working query. [PTJA-W3-CI]
   */
  const row=await db.prepare(
    `SELECT *, CASE WHEN service_code=? AND city_id=? THEN 0 WHEN service_code=? AND city_id='*' THEN 1 WHEN service_code='*' AND city_id=? THEN 2 ELSE 3 END rank
     FROM service_policy_configs
     WHERE policy_domain=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
       AND (service_code=? OR service_code='*') AND (city_id=? OR city_id='*')
     ORDER BY rank ASC, version DESC, updated_at DESC LIMIT 1`)
    .bind(serviceCode,cityId,serviceCode,cityId,domain,date,date,serviceCode,cityId).first<Row>();
  if(!row)throw Response.json({error:`${spec.label} is not configured for this service and city`,code:"service_policy_configuration_required",domain,serviceCode,cityId},{status:409});
  const record=rowToRecord(spec,row);
  const problem=spec.problem(record.config as Record<string,unknown>);
  if(problem)throw Response.json({error:`${spec.label} configuration is invalid: ${problem}`,code:"service_policy_configuration_invalid",domain,policyId:record.id},{status:409});
  const matchedBy=MATCHED_BY[Number(row.rank??3)]??"platform_default";
  return{...record,matchedBy,policyVersion:`${domain}:${record.serviceCode}:${record.cityId}:v${record.version}`};
}

/** Every stored row for a domain, most specific first. The Control Center list. */
export async function listServicePolicies(db:Db,domain:string){
  await ensureServicePolicyTables(db);
  const spec=registry.get(domain);
  if(!spec)throw new Error(`Unknown policy domain ${domain}`);
  await seedServicePolicyDefault(db,domain);
  const rows=await db.prepare("SELECT * FROM service_policy_configs WHERE policy_domain=? ORDER BY service_code,city_id,version DESC").bind(domain).all<Row>();
  return rows.results.map(row=>rowToRecord(spec,row));
}

export async function servicePolicyAudit(db:Db,domain:string,limit=50){
  await ensureServicePolicyTables(db);
  const rows=await db.prepare("SELECT * FROM service_policy_audit WHERE policy_domain=? ORDER BY created_at DESC LIMIT ?").bind(domain,Math.max(1,Math.min(200,limit))).all<Row>();
  return rows.results;
}

export type PolicyWriteInput={domain:string;serviceCode?:string|null;cityId?:string|null;config:Record<string,unknown>;notes?:string;effectiveFrom?:string;effectiveTo?:string|null;active?:boolean};

/**
 * Creates or replaces the policy at one scope, validated by the domain's own rules and audited with the
 * actor's reason. Returns the stored record. The caller is responsible for authorization; the domain
 * names the permission it requires in `managePermission`.
 */
export async function writeServicePolicy(db:Db,input:PolicyWriteInput,actorId:string,reason:string){
  const spec=registry.get(input.domain);
  if(!spec)throw Response.json({error:`Unknown policy domain ${input.domain}`,code:"unknown_policy_domain"},{status:400});
  await ensureServicePolicyTables(db);
  await seedServicePolicyDefault(db,input.domain);
  if(!reason||reason.trim().length<5)throw Response.json({error:"A clear change reason is required"},{status:400});
  const serviceCode=normalise(input.serviceCode),cityId=normalise(input.cityId);
  // The merged config is what will be READ back, so it is what gets validated - not the patch fragment.
  const existing=await db.prepare("SELECT * FROM service_policy_configs WHERE policy_domain=? AND service_code=? AND city_id=? ORDER BY version DESC LIMIT 1").bind(input.domain,serviceCode,cityId).first<Row>();
  const previous=existing?parseJson<Record<string,unknown>>(existing.config_json,{}):{};
  const merged={...spec.defaults,...previous,...input.config};
  const problem=spec.problem(merged);
  if(problem)throw Response.json({error:problem,code:"service_policy_invalid"},{status:400});
  const now=Date.now(),effectiveFrom=String(input.effectiveFrom||new Date().toISOString().slice(0,10));
  const effectiveTo=input.effectiveTo?String(input.effectiveTo):null;
  const active=input.active===false?0:1;
  const notes=String(input.notes??existing?.notes??"");
  const id=existing?String(existing.id):`spolicy_${input.domain}_${serviceCode}_${cityId}_${crypto.randomUUID().slice(0,8)}`.replace(/\*/g,"any");
  if(existing){
    await db.prepare("UPDATE service_policy_configs SET config_json=?,notes=?,active=?,version=version+1,effective_from=?,effective_to=?,updated_by=?,updated_at=? WHERE id=?")
      .bind(JSON.stringify(merged),notes,active,effectiveFrom,effectiveTo,actorId,now,id).run();
  }else{
    await db.prepare("INSERT INTO service_policy_configs (id,policy_domain,service_code,city_id,config_json,notes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)")
      .bind(id,input.domain,serviceCode,cityId,JSON.stringify(merged),notes,active,effectiveFrom,effectiveTo,actorId,now).run();
  }
  const after=await db.prepare("SELECT * FROM service_policy_configs WHERE id=?").bind(id).first<Row>();
  await db.prepare("INSERT INTO service_policy_audit (id,policy_id,policy_domain,service_code,city_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),id,input.domain,serviceCode,cityId,existing?"updated":"created",existing?JSON.stringify(existing):null,JSON.stringify(after),actorId,reason.trim(),now).run();
  return rowToRecord(spec,after as Row);
}
