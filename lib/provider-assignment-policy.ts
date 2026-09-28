import{registerServicePolicyDomain,resolveServicePolicy,seedServicePolicyScopes}from"./service-policy-governance";

export const ASSIGNMENT_POLICY_DOMAIN="provider_assignment_policy";
export type AssignmentMode="auto"|"customer_select"|"ops_select"|"manual_workflow";
export type PreferredProviderMode="strict"|"preference"|"disabled";
export type AssignmentPolicyConfig={assignmentMode:AssignmentMode;preferredProviderMode:PreferredProviderMode;qualityWeight:number;fullTimeBonus:number;preferredProviderBonus:number;repeatProviderBonus:number;distanceWeight:number;residualCapacityWeight:number;workloadPenalty:number;fallbackAttempts:number;opsEscalationMinutes:number};

const defaults:AssignmentPolicyConfig&Record<string,unknown>={assignmentMode:"ops_select",preferredProviderMode:"disabled",qualityWeight:1,fullTimeBonus:5,preferredProviderBonus:20,repeatProviderBonus:12,distanceWeight:.5,residualCapacityWeight:1,workloadPenalty:2,fallbackAttempts:3,opsEscalationMinutes:10};
const modes=new Set(["auto","customer_select","ops_select","manual_workflow"]),preferred=new Set(["strict","preference","disabled"]);
const schedulerServices=new Set(["grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking","vet_consult"]);
const manualServices=new Set(["food","relocation","funeral_memorial"]);
export function assignmentModesForService(serviceCode:string):AssignmentMode[]{return schedulerServices.has(serviceCode)?["auto","customer_select","ops_select"]:manualServices.has(serviceCode)?["ops_select","manual_workflow"]:["ops_select"]; }
export function assignmentModeSupported(serviceCode:string,mode:AssignmentMode){return assignmentModesForService(serviceCode).includes(mode);}
export function assignmentEscalationDueAt(config:AssignmentPolicyConfig,at=Date.now()){return at+Math.max(0,config.opsEscalationMinutes)*60_000;}
export function assignmentAttemptAllowed(config:AssignmentPolicyConfig,nextAttempt:number){return config.fallbackAttempts>0&&nextAttempt<=config.fallbackAttempts;}
function problem(config:Record<string,unknown>){if(!modes.has(String(config.assignmentMode)))return"assignmentMode must be auto, customer_select, ops_select or manual_workflow";if(!preferred.has(String(config.preferredProviderMode)))return"preferredProviderMode must be strict, preference or disabled";for(const key of["qualityWeight","fullTimeBonus","preferredProviderBonus","repeatProviderBonus","distanceWeight","residualCapacityWeight","workloadPenalty"]){const n=Number(config[key]);if(!Number.isFinite(n)||n<0||n>100)return`${key} must be between 0 and 100`;}for(const key of["fallbackAttempts","opsEscalationMinutes"]){const n=Number(config[key]);if(!Number.isInteger(n)||n<0||n>120)return`${key} must be a whole number between 0 and 120`;}return null;}
registerServicePolicyDomain<AssignmentPolicyConfig&Record<string,unknown>>({domain:ASSIGNMENT_POLICY_DOMAIN,label:"Provider assignment policy",managePermission:"settings.manage",defaults,problem});

const seeded=new WeakSet<D1Database>();
export async function seedAssignmentPolicies(db:D1Database){if(seeded.has(db))return;// One batch for every scope (it was two sequential calls per scope, 22 on a cold isolate's first reserve).
await seedServicePolicyScopes(db,ASSIGNMENT_POLICY_DOMAIN,[
 {serviceCode:"grooming",cityId:"*",config:{assignmentMode:"auto",preferredProviderMode:"preference"},notes:"Grooming uses ranked automatic assignment"},
 {serviceCode:"dog_training",cityId:"*",config:{assignmentMode:"auto",preferredProviderMode:"strict"},notes:"Training auto-matches unless the customer explicitly selects a trainer; never silently substitute"},
 {serviceCode:"boarding",cityId:"*",config:{assignmentMode:"customer_select",preferredProviderMode:"strict"},notes:"Boarding host is customer-selected and revalidated"},
 {serviceCode:"pet_sitting",cityId:"*",config:{assignmentMode:"customer_select",preferredProviderMode:"strict"},notes:"Sitting caregiver is customer-selected and revalidated"},
 {serviceCode:"pet_taxi",cityId:"*",config:{assignmentMode:"auto",preferredProviderMode:"preference"},notes:"Taxi uses ranked automatic driver assignment"},
 {serviceCode:"dog_walking",cityId:"*",config:{assignmentMode:"auto",preferredProviderMode:"preference"},notes:"Walking uses ranked automatic walker assignment"},
 {serviceCode:"vet_consult",cityId:"*",config:{assignmentMode:"auto",preferredProviderMode:"preference"},notes:"Doorstep Vet uses ranked automatic assignment after mandatory VCI verification"},
 ...["food","relocation","funeral_memorial"].map(service=>({serviceCode:service,cityId:"*",config:{assignmentMode:"manual_workflow",preferredProviderMode:"disabled"},notes:`${service} uses governed Operations workflow`})),
]);await upgradeUntouchedTrainingSeed(db);seeded.add(db);}
export async function resolveAssignmentPolicy(db:D1Database,serviceCode:string,cityId:string,at=new Date(),options:{readOnly?:boolean}={}){if(!options.readOnly)await seedAssignmentPolicies(db);return resolveServicePolicy<AssignmentPolicyConfig&Record<string,unknown>>(db,ASSIGNMENT_POLICY_DOMAIN,{serviceCode,cityId},at,options);}


/** Approved V1 capability restoration, restricted to the exact untouched historical seed.
 * Never overwrite operator-authored, disabled, future-dated, scoped or otherwise edited policies.
 * The guarded audit INSERT and UPDATE are one D1 batch: no unrecorded or partially applied upgrade.
 */
export async function upgradeUntouchedTrainingSeed(db: D1Database): Promise<void> {
  const id="spolicy_provider_assignment_policy_dog_training_any";
  const before=JSON.stringify({...defaults,assignmentMode:"customer_select",preferredProviderMode:"strict"});
  const after=JSON.stringify({...defaults,assignmentMode:"auto",preferredProviderMode:"strict"});
  const actor="system:v2-training-choice-upgrade",auditId=`v2-training-choice:${id}`,now=Date.now();
  const note="Training customer selection is strict; never silently substitute";
  const newNote="Training auto-matches unless the customer explicitly selects a trainer; never silently substitute";
  const predicate="id=? AND policy_domain=? AND service_code='dog_training' AND city_id='*' AND config_json=? AND notes=? AND updated_by='founder_seed' AND version=1 AND active=1 AND effective_from='2026-08-01' AND effective_to IS NULL AND NOT EXISTS (SELECT 1 FROM service_policy_configs other WHERE other.policy_domain=? AND other.service_code='dog_training' AND other.city_id='*' AND other.id!=?)";
  const binds=[id,ASSIGNMENT_POLICY_DOMAIN,before,note,ASSIGNMENT_POLICY_DOMAIN,id];
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO service_policy_audit (id,policy_id,policy_domain,service_code,city_id,action,before_json,after_json,actor_id,reason,created_at) SELECT ?,id,policy_domain,service_code,city_id,'seed_upgrade',json_object('config',json(config_json),'version',version,'updatedBy',updated_by),?,?,'Restore approved automatic Training choice only for the untouched original seed',? FROM service_policy_configs WHERE ${predicate}`)
      .bind(auditId,JSON.stringify({config:JSON.parse(after),version:2,updatedBy:actor}),actor,now,...binds),
    db.prepare(`UPDATE service_policy_configs SET config_json=?,notes=?,version=2,updated_by=?,updated_at=? WHERE ${predicate} AND EXISTS (SELECT 1 FROM service_policy_audit WHERE id=?)`)
      .bind(after,newNote,actor,now,...binds,auditId),
  ]);
}
