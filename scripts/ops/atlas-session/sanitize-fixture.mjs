const CODES=new Set(['revision_unproven','runtime_isolation_unproven','fixed_fixture_isolation_unproven','fixed_fixture_snapshot_attested','authentication_required','founder_required','expected_revision_required','fixed_scope_required','read_only_evidence_unavailable']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
/** Persist only the fixed guard vocabulary, boolean predicates and public revision identifiers. */
export function sanitizeFixtureResponse(httpStatus,payload){
 const object=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{};
 const checks=Object.fromEntries(Object.entries(object.checks&&typeof object.checks==='object'?object.checks:{}).slice(0,64).filter(([key,value])=>/^[a-z][a-z0-9]{0,63}$/i.test(key)&&typeof value==='boolean'));
 const version=object.version&&typeof object.version==='object'?object.version:{};
 return {httpStatus,ok:object.ok===true,code:CODES.has(object.code)?object.code:null,checks,version:{id:UUID.test(version.id??'')?version.id:null,buildSha:SHA.test(version.buildSha??'')?version.buildSha:null}};
}
