/**
 * Runner-side acceptance for the staging fixture-isolation diagnostic.
 *
 * Three questions are answered separately and never collapsed into one boolean:
 *  - transportCaptured: a JSON object came back at all.
 *  - contractQualified: that object speaks the versioned contract completely and consistently.
 *  - operationalSuccess: the fixture was attested (HTTP200) under the expected identity.
 *
 * The historical runner (run 37181747899) set diagnosticCaptured=true and ok=true for ANY recognized code,
 * so a 409 with no predicates was recorded as success. Here every refusal stays ok:false, modelAdmission:false;
 * a complete refusal is VERIFIED_REFUSAL (captured, not successful); anything incomplete, foreign, mistyped or
 * self-contradictory is BLOCKED. Classification runs on the RAW payload: sanitization can turn a wrong type into
 * null and must never be the thing that makes evidence look plausible.
 *
 * Identity: the contract marker names a response shape. It is not a bundle digest. edgeIdentityProven requires
 * artifactContentVerified, which only the publisher's separate authenticated module-content read can supply.
 */
export const CONTRACT='atlas-revision-diagnostic-v2';
export const KEYS=['buildShaValid','buildShaMatchesExpected','versionIdValid','versionTimestampValid'];
export const DECISIONS=Object.freeze({BLOCKED:'BLOCKED',VERIFIED_REFUSAL:'VERIFIED_REFUSAL',FIXTURE_ATTESTED:'FIXTURE_ATTESTED'});
const SHA=/^[0-9a-f]{40}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,HEX64=/^[0-9a-f]{64}$/;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nullableMatch=(value,pattern)=>value===null||(typeof value==='string'&&pattern.test(value));

function blocked(reason,extra={}){return {ok:false,transportCaptured:extra.transportCaptured??true,contractQualified:false,diagnosticCaptured:false,operationalSuccess:false,decision:DECISIONS.BLOCKED,reason,modelAdmission:false,artifactContentVerified:false,edgeIdentityProven:false};}

/** Raw-type validation of the observed identity: string|null only, then well-formedness. */
export function validateObservedIdentity(version,{requireTimestamp=true}={}){
 if(!isObject(version))return 'observed_identity_absent';
 for(const key of ['buildSha','id',...(requireTimestamp?['timestamp']:[])])if(!Object.hasOwn(version,key))return `observed_${key}_missing`;
 for(const key of Object.keys(version)){const value=version[key];if(value!==null&&typeof value!=='string')return `observed_${key}_type_invalid`;}
 if(!nullableMatch(version.buildSha,SHA))return 'observed_sha_invalid';
 if(!nullableMatch(version.id,UUID))return 'observed_version_invalid';
 if(requireTimestamp&&version.timestamp!==null&&!Number.isFinite(Date.parse(version.timestamp)))return 'observed_timestamp_invalid';
 return null;
}

function validatePredicates(checks){
 if(!isObject(checks))return 'predicate_contract_absent';
 const keys=Object.keys(checks).sort();
 if(keys.join(',')!==[...KEYS].sort().join(','))return 'predicate_contract_incomplete';
 if(!KEYS.every(k=>typeof checks[k]==='boolean'))return 'predicate_type_invalid';
 return null;
}

/**
 * @param status HTTP status actually observed.
 * @param payload RAW parsed JSON body (not sanitized).
 * @param expectedSha the exact source revision the runner asked for (40 lowercase hex).
 * @param expectedVersion optional Worker version UUID the publisher read from deployment metadata.
 * @param artifactContentVerified publisher-supplied: served main-module hash equals the approved artifact hash.
 */
export function classifyDiagnostic(status,payload,{expectedSha,expectedVersion=null,artifactContentVerified=false}={}){
 if(!SHA.test(expectedSha??''))return blocked('expected_identity_invalid',{transportCaptured:false});
 if(expectedVersion!==null&&!(typeof expectedVersion==='string'&&UUID.test(expectedVersion)))return blocked('expected_identity_invalid',{transportCaptured:false});
 if(!isObject(payload))return blocked('response_not_object',{transportCaptured:false});
 if(payload.diagnosticContract!==CONTRACT)return blocked('artifact_contract_absent');
 const predicateProblem=validatePredicates(payload.checks);
 if(status===409&&payload.ok===false&&payload.code==='revision_unproven'){
  if(predicateProblem)return blocked(predicateProblem);
  const identityProblem=validateObservedIdentity(payload.version);
  if(identityProblem)return blocked(identityProblem);
  const {checks,version}=payload;
  if(KEYS.every(k=>checks[k]===true))return blocked('predicate_contradiction_all_true_refusal');
  if(checks.buildShaValid!==(version.buildSha!==null)||checks.buildShaMatchesExpected!==(version.buildSha!==null&&version.buildSha===expectedSha)||checks.versionIdValid!==(version.id!==null)||checks.versionTimestampValid!==(version.timestamp!==null))return blocked('predicate_identity_inconsistent');
  if(expectedVersion!==null&&version.id!==null&&version.id!==expectedVersion)return blocked('observed_version_drift');
  return {ok:false,transportCaptured:true,contractQualified:true,diagnosticCaptured:true,operationalSuccess:false,decision:DECISIONS.VERIFIED_REFUSAL,reason:'revision_unproven',checks:{...checks},version:{...version},modelAdmission:false,artifactContentVerified:artifactContentVerified===true,edgeIdentityProven:false};
 }
 if(status===200&&payload.ok===true&&payload.code==='fixed_fixture_snapshot_attested'){
  // Explicit HTTP200 contract: every emitted check is a boolean and true, the identity is well-formed and
  // non-null, the build SHA is the expected one, and the snapshot fingerprint is a 64-hex digest.
  if(!isObject(payload.checks)||Object.keys(payload.checks).length===0)return blocked('attestation_checks_absent');
  if(!Object.values(payload.checks).every(v=>typeof v==='boolean'))return blocked('attestation_checks_type_invalid');
  if(!Object.values(payload.checks).every(Boolean))return blocked('attestation_checks_contradict_ok');
  const identityProblem=validateObservedIdentity(payload.version);
  if(identityProblem)return blocked(identityProblem);
  const {version}=payload;
  if(version.buildSha===null||version.id===null||version.timestamp===null)return blocked('attestation_identity_unknown');
  if(version.buildSha!==expectedSha)return blocked('attestation_sha_mismatch');
  if(expectedVersion!==null&&version.id!==expectedVersion)return blocked('observed_version_drift');
  if(typeof payload.fixtureSnapshotId!=='string'||!HEX64.test(payload.fixtureSnapshotId))return blocked('fixture_snapshot_id_invalid');
  const contentVerified=artifactContentVerified===true;
  return {ok:true,transportCaptured:true,contractQualified:true,diagnosticCaptured:true,operationalSuccess:true,decision:DECISIONS.FIXTURE_ATTESTED,reason:'fixed_fixture_snapshot_attested',checks:{...payload.checks},version:{...version},fixtureSnapshotId:payload.fixtureSnapshotId,modelAdmission:false,artifactContentVerified:contentVerified,edgeIdentityProven:contentVerified&&expectedVersion!==null&&version.id===expectedVersion};
 }
 // Any other recognized refusal (runtime isolation, fixture isolation, auth, scope) is a captured refusal of a
 // different stage; it is still not success and still needs the contract marker to be attributable.
 return blocked('unexpected_response');
}
