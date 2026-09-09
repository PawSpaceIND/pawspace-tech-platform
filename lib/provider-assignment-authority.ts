/** Snapshot the database authority used by providerAssignmentBlock, before re-evaluating it.
 * The returned predicate must be checked in the same transaction as the assignment writes.
 */
export async function captureProviderAssignmentAuthority(db:D1Database,providerId:string){
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('provider_capacity_profiles','provider_onboarding_applications','provider_verifications','service_policy_configs')").all<{name:string}>();
 const present=new Set(tables.results.map(row=>row.name));
 const predicates:string[]=["date('now')=?"],values:unknown[]=[new Date().toISOString().slice(0,10)];
 const specs=[
  {table:"provider_capacity_profiles",columns:"id,city_id,provider_model,updated_by",where:"id=?",binds:[providerId]},
  {table:"provider_onboarding_applications",columns:"id,vertical_key,updated_at",where:"provider_id=?",binds:[providerId]},
  {table:"provider_verifications",columns:"id,application_id,verification_type,status,expires_at",where:present.has("provider_onboarding_applications")?"application_id IN (SELECT id FROM provider_onboarding_applications WHERE provider_id=?)":"0",binds:present.has("provider_onboarding_applications")?[providerId]:[]},
  {table:"service_policy_configs",columns:"id,service_code,city_id,config_json,active,version,effective_from,effective_to,updated_at",where:"policy_domain='provider_verification_policy'",binds:[]},
 ];
 for(const spec of specs){
  if(!present.has(spec.table)){predicates.push("NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)");values.push(spec.table);continue;}
  const sql=`SELECT json_group_array(json(row)) value FROM (SELECT json_array(${spec.columns}) row FROM ${spec.table} WHERE ${spec.where} ORDER BY id)`;
  const snapshot=await db.prepare(sql).bind(...spec.binds).first<{value:string}>();
  predicates.push(`(${sql}) IS ?`);values.push(...spec.binds,snapshot?.value??"[]");
 }
 return {sql:predicates.join(" AND "),values};
}
