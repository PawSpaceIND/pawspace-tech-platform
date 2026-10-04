import {resolveUatStaffActor} from "./uat-staging-auth";
import {isVoiceAllowlisted} from "./voice-call-gate";
import {STAGING_PROVIDER_FIXTURES} from "./staging-fixture-provider-manifest";
import {samePhoneForms,samePhoneSql} from "./customer-phone";

type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
export const STAGING_FIXTURE_ISOLATION_PATH="/__staging/fixture-isolation";
const text=(value:unknown)=>String(value??"").trim();
const digits=(value:unknown)=>text(value).replace(/\D/g,"");
const list=(value:unknown)=>text(value).split(",").map(text).filter(Boolean);
const SHA=/^[0-9a-f]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_PROVIDERS=["uatcap_groom_ft","uatcap_train_ft","uatcap_train_ft_3","uatcap_train_ft_5","uatcap_host_cm","uatcap_sit_cm","uatcap_taxi_ft","uatcap_walk_ft"];
/** Versioned name of the revision-diagnostic response shape. A marker names a contract; it is not a bundle digest
 * and never proves which compiled artifact answered. Content identity is the publisher's separate module read. */
export const REVISION_DIAGNOSTIC_CONTRACT="atlas-revision-diagnostic-v2";
export type ObservedRevision={proven:boolean;checks:{buildShaValid:boolean;buildShaMatchesExpected:boolean;versionIdValid:boolean;versionTimestampValid:boolean};version:{buildSha:string|null;id:string|null;timestamp:string|null}};
/** Observed runtime identity, emitted only when well-formed. Anything malformed or absent is null (unknown):
 * null never satisfies a predicate, and a predicate is true only when the emitted value it describes is non-null. */
export function observeRevision(env:Env,expectedSha:string):ObservedRevision{
 const metadata=env.PAWSPACE_VERSION_METADATA as {id?:unknown;timestamp?:unknown}|undefined;
 const rawSha=text(env.PAWSPACE_STAGING_BUILD_SHA),rawId=text(metadata?.id),rawTimestamp=text(metadata?.timestamp);
 const buildSha=SHA.test(rawSha)?rawSha:null,id=UUID.test(rawId)?rawId:null,timestamp=Number.isFinite(Date.parse(rawTimestamp))?rawTimestamp:null;
 const checks={buildShaValid:buildSha!==null,buildShaMatchesExpected:buildSha!==null&&buildSha===expectedSha,versionIdValid:id!==null,versionTimestampValid:timestamp!==null};
 return {proven:Object.values(checks).every(Boolean),checks,version:{buildSha,id,timestamp}};
}
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store, private","pragma":"no-cache","x-content-type-options":"nosniff"}});

/** Conservative union of the actual generic exact-string boundary and normalized runtime boundary.
 * Meta uses raw truthiness BEFORE trimming for its own-list-or-generic fallback. Voice uses its
 * production pure predicate (last ten digits). No list or recipient is ever returned to callers. */
export function fixtureRecipientExclusion(env:Env,phones:unknown[],emails:unknown[]=[]){
 const generic=list(env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST);
 const meta=list(env.META_WHATSAPP_UAT_ALLOWLIST||env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST);
 const p=phones.map(text).filter(Boolean),e=emails.map(text).filter(Boolean);
 return {
  genericExcluded:p.every(phone=>!generic.some(entry=>entry===phone||(digits(phone)!==""&&digits(entry)===digits(phone))))&&e.every(email=>!generic.some(entry=>entry.toLowerCase()===email.toLowerCase())),
  metaExcluded:p.every(phone=>!meta.some(entry=>digits(entry)===digits(phone))),
  voiceExcluded:p.every(phone=>!isVoiceAllowlisted(env,phone)),
 };
}

/** Fixed-fixture read-only snapshot. No arbitrary recipient/identity input, provisioning, send,
 * API-gateway auth/DDL or audit writes. Missing tables/identity/config/version fail closed.
 * This is NOT an assignment lock, production signoff, or proof that Google Maps makes no requests. */
export async function handleStagingFixtureIsolation(request:Request,db:D1Database,env:Env):Promise<Response|null>{
 const url=new URL(request.url);
 if(url.pathname!==STAGING_FIXTURE_ISOLATION_PATH)return null;
 if(text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||text(env.PAWSPACE_ENV)!=="staging"||text(env.FORBID_PRODUCTION)!=="true"||text(env.PAWSPACE_PRODUCTION_ENFORCE)!=="false"||!/^pawspace-staging\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)||url.protocol!=="https:")return json({ok:false,code:"not_found"},404);
 if(request.method!=="GET")return json({ok:false,code:"method_not_allowed"},405);
 try{
  // This existing resolver verifies the signed staff cookie and reads active role/exit state only.
  // resolveActor/authorize would create security tables, so they must never be used here.
  const actor=await resolveUatStaffActor(db,request,env);
  if(!actor)return json({ok:false,code:"authentication_required"},401);
  if(actor.roleCode!=="founder"||!actor.permissions.includes("*"))return json({ok:false,code:"founder_required"},403);
  if([...url.searchParams.keys()].some(key=>!["expectedSha","scope"].includes(key))||url.searchParams.getAll("expectedSha").length!==1||!SHA.test(url.searchParams.get("expectedSha")||""))return json({ok:false,code:"expected_revision_required"},400);
  const scope=url.searchParams.get("scope")??"bengaluru_roster";
  if(url.searchParams.getAll("scope").length>1||!["bengaluru_roster","grooming_strict"].includes(scope))return json({ok:false,code:"fixed_scope_required"},400);
  const strictGrooming=scope==="grooming_strict";
  const expectedSha=url.searchParams.get("expectedSha")!;
  const revision=observeRevision(env,expectedSha);
  // The four predicates and the observed identity are always emitted on a revision refusal. A runner can
  // therefore distinguish "the artifact refused and said why" from "an artifact that never speaks this
  // contract answered", and a null identity field says "unknown here", never "matches".
  if(!revision.proven)return json({ok:false,code:"revision_unproven",diagnosticContract:REVISION_DIAGNOSTIC_CONTRACT,checks:revision.checks,version:revision.version},409);
  const gates={
   paymentSandbox:text(env.PAWSPACE_PAYMENT_ENV)==="sandbox"&&text(env.PAWSPACE_PAYMENT_LIVE_APPROVED)==="false",
   payoutsSandbox:text(env.PAWSPACE_RAZORPAYX_ENV)==="sandbox"&&text(env.PAWSPACE_RAZORPAYX_LIVE_APPROVED)==="false",
   communicationsUat:text(env.PAWSPACE_COMMUNICATION_ENV)==="uat",
   voiceNotLive:["uat","disabled"].includes(text(env.PAWSPACE_VOICE_ENV)),
   customerLiveOtpDisabled:text(env.PAWSPACE_STAGING_LIVE_CUSTOMER_OTP)==="false",
   productionOtpDisabled:text(env.PAWSPACE_DEPLOYMENT_ENV)==="staging",
   schedulerUat:text(env.PAWSPACE_SCHEDULING_ENV)==="uat",
  };
  if(!Object.values(gates).every(Boolean))return json({ok:false,code:"runtime_isolation_unproven",checks:gates},409);
  const customers=await db.prepare("SELECT id,city_id,primary_phone,secondary_phone,email,source FROM canonical_customers WHERE id='CUS0000'").all<Row>();
  const customer=customers.results?.[0];
  const customerProven=customers.results?.length===1&&customer?.city_id==="blr"&&customer?.source==="uat_seed"&&text(customer?.primary_phone)==="9100000000"&&!text(customer?.secondary_phone)&&!text(customer?.email);
  // OTP prefers a prior bound customer when one normalized phone appears on multiple records.
  // Refuse ambiguity rather than certifying one row while login could resolve to another account.
  const customerOtpTargets=await db.prepare(`SELECT id FROM canonical_customers WHERE ${samePhoneSql("primary_phone")} ORDER BY id LIMIT 2`).bind(...samePhoneForms("9100000000")).all<Row>();
  const customerOtpTargetUnambiguous=customerOtpTargets.results?.length===1&&customerOtpTargets.results[0].id==="CUS0000";
  // All Bengaluru profiles, including inactive/uat_ready, are a conservative SUPERSET, not a preview for one slot.
  // Unknown/extra providers cannot silently be ignored by narrowing to the eight chosen fixtures.
  // The narrow scope cannot accept an arbitrary provider or recipient. It proves only this explicit
  // full-time Grooming choice; other roster/host/recovery rows are deliberately outside its claim.
  const roster=await db.prepare(strictGrooming
   ?"SELECT p.id,p.city_id capacity_city_id,p.updated_by,p.services_json,p.live,p.status,p.provider_model,c.id canonical_id,c.city_id,c.phone,c.email,c.source FROM provider_capacity_profiles p LEFT JOIN canonical_providers c ON c.id=p.id WHERE p.id='uatcap_groom_ft' ORDER BY p.id LIMIT 2"
   :"SELECT p.id,p.city_id capacity_city_id,p.updated_by,p.services_json,c.id canonical_id,c.city_id,c.phone,c.email,c.source FROM provider_capacity_profiles p LEFT JOIN canonical_providers c ON c.id=p.id WHERE p.city_id='blr' OR EXISTS (SELECT 1 FROM boarding_host_profiles h WHERE h.provider_id=p.id AND h.city_id='blr') ORDER BY p.id LIMIT 257").all<Row>();
  const rows=roster.results||[];
  const providerProven=(row:Row)=>Object.hasOwn(STAGING_PROVIDER_FIXTURES,text(row.id))&&row.canonical_id===row.id&&row.capacity_city_id==="blr"&&row.city_id==="blr"&&row.source==="uat_staging_seed"&&row.updated_by==="founder_seed"&&text(row.phone)===STAGING_PROVIDER_FIXTURES[text(row.id)]&&!text(row.email);
  const fixedProvidersProven=REQUIRED_PROVIDERS.every(id=>rows.some(row=>row.id===id&&providerProven(row)));
  const rosterProven=rows.length>0&&rows.length<=256&&new Set(rows.map(row=>row.id)).size===rows.length&&rows.every(providerProven);
  const recipients=[...(customer?[customer.primary_phone,customer.secondary_phone]:[]),...rows.map(row=>row.phone)];
  const emails=[...(customer?[customer.email]:[]),...rows.map(row=>row.email)];
  const exclusion=fixtureRecipientExclusion(env,recipients,emails);
  let groomingServiceProven=false;
  if(strictGrooming&&rows.length===1){try{const services:unknown=JSON.parse(text(rows[0].services_json));groomingServiceProven=Array.isArray(services)&&services.includes("grooming");}catch{/* malformed service scope fails closed */}}
  const strictGroomerProven=strictGrooming&&rows.length===1&&providerProven(rows[0])&&rows[0].id==="uatcap_groom_ft"&&rows[0].provider_model==="full_time"&&Number(rows[0].live)===1&&rows[0].status==="active"&&groomingServiceProven;
  const groomerOtpTargets=strictGrooming?await db.prepare("SELECT id FROM canonical_providers WHERE phone='9000000901' ORDER BY id LIMIT 2").all<Row>():null;
  const groomerOtpTargetUnambiguous=groomerOtpTargets?.results?.length===1&&groomerOtpTargets.results[0].id==="uatcap_groom_ft";
  const checks={...gates,customerFixtureProven:customerProven,customerOtpTargetUnambiguous,...(strictGrooming?{specificGroomerFixtureProven:strictGroomerProven,groomerOtpTargetUnambiguous}:{fixedProviderFixturesProven:fixedProvidersProven,bengaluruCapacityRosterProven:rosterProven}),...exclusion};
  const ok=Object.values(checks).every(Boolean);
  const fixtureSnapshotId=ok?Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({scope,customer,roster:rows,checks})))),byte=>byte.toString(16).padStart(2,"0")).join(""):null;
  return json({ok,fixtureSnapshotId,code:ok?"fixed_fixture_snapshot_attested":"fixed_fixture_isolation_unproven",scope:strictGrooming?"grooming_strict":"documented_synthetic_customer_and_bengaluru_capacity_roster",checks,diagnosticContract:REVISION_DIAGNOSTIC_CONTRACT,version:revision.version,observedAt:new Date().toISOString(),strictProviderSelectionRequired:strictGrooming,automaticAssignmentCovered:false,reassignmentRecoveryCovered:false,assignmentLock:false,bookingMutationAuthorized:false,staffFallbackRecipientsCovered:false,alternateProviderTablesCovered:false,productionReadiness:false,requiresMatchingDeploymentIsolationCertificate:true},ok?200:409);
 }catch{return json({ok:false,code:"read_only_evidence_unavailable"},503);}
}
