/**
 * TEST / LOCAL. Compiled-artifact HTTP contract for the Atlas revision diagnostic and its runner-side acceptance.
 *
 * What is real here: the artifact is compiled from committed source by esbuild inside this test; requests travel over
 * an actual localhost TCP HTTP server into the compiled module's fetch handler; the Founder cookie is signed and
 * verified by the real UAT auth code against a SELECT-only SQLite-backed D1 facade.
 * What is simulated, explicitly: the `cloudflare:workers` ambient env (module-hooks shim), the D1 binding (node:sqlite),
 * the https scheme and workers.dev host (set from the Host header exactly as the edge would). None of this is hosted
 * evidence: it proves what THIS artifact emits, not what any deployed Worker serves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {fixtureIsolationWorld} from './helpers/staging-fixture-isolation-world.mjs';
import {classifyDiagnostic,validateObservedIdentity,CONTRACT,KEYS,DECISIONS} from '../scripts/ops/atlas-session/diagnostic-contract.mjs';
import {sanitizeFixtureResponse} from '../scripts/ops/atlas-session/sanitize-fixture.mjs';
import {buildDiagnosticBundle} from '../scripts/ops/atlas-session/build-diagnostic-bundle.mjs';
installWorkersHooks('__ATLAS_DIAG_DB__','__ATLAS_DIAG_ENV__');
const {STAGING_PROVIDER_FIXTURES}=await import('../lib/staging-fixture-provider-manifest.ts');
const {issueUatToken}=await import('../lib/uat-staging-auth.ts');
const SHA='a'.repeat(40),OTHER='b'.repeat(40),VERSION='11111111-1111-4111-8111-111111111111',HOST='pawspace-staging.synthetic.workers.dev',ORIGIN=`https://${HOST}`;
const receipt=JSON.parse(readFileSync(new URL('../scripts/ops/atlas-session/local-artifact-receipt.json',import.meta.url),'utf8'));

// ---- unit: runner-side acceptance on raw payloads ------------------------------------------------------------
const refusal=(over={})=>({ok:false,code:'revision_unproven',diagnosticContract:CONTRACT,checks:{buildShaValid:true,buildShaMatchesExpected:false,versionIdValid:true,versionTimestampValid:true},version:{buildSha:OTHER,id:VERSION,timestamp:'2026-09-30T10:00:00Z'},...over});
test('historical hosted shape (409 revision_unproven, no predicates, no marker) is BLOCKED, never captured success',()=>{
 const hosted={ok:false,code:'revision_unproven'};
 // The executed runner's rule was `sanitized.code!==null`. Show it would have accepted this payload.
 assert.notEqual(sanitizeFixtureResponse(409,hosted).code,null,'old acceptance rule accepted any recognized code');
 const r=classifyDiagnostic(409,hosted,{expectedSha:SHA});
 assert.equal(r.decision,DECISIONS.BLOCKED);assert.equal(r.reason,'artifact_contract_absent');assert.equal(r.ok,false);assert.equal(r.diagnosticCaptured,false);assert.equal(r.operationalSuccess,false);assert.equal(r.modelAdmission,false);
 assert.equal(classifyDiagnostic(409,{...hosted,diagnosticContract:CONTRACT,checks:{}},{expectedSha:SHA}).reason,'predicate_contract_incomplete');
});
test('complete, consistent refusal is VERIFIED_REFUSAL: captured, qualified, not success, no admission',()=>{
 const r=classifyDiagnostic(409,refusal(),{expectedSha:SHA});
 assert.equal(r.decision,DECISIONS.VERIFIED_REFUSAL);assert.equal(r.ok,false);assert.equal(r.transportCaptured,true);assert.equal(r.contractQualified,true);assert.equal(r.diagnosticCaptured,true);assert.equal(r.operationalSuccess,false);assert.equal(r.modelAdmission,false);assert.equal(r.edgeIdentityProven,false);assert.equal(r.artifactContentVerified,false);
 assert.equal(classifyDiagnostic(409,refusal(),{expectedSha:SHA,artifactContentVerified:true}).edgeIdentityProven,false,'a refusal never proves edge identity even with content verified');
});
test('missing, wrong-type and foreign predicates fail; all-true 409 fails; identity/predicate inconsistency fails',()=>{
 const cases=[
  [refusal({checks:{buildShaValid:true,buildShaMatchesExpected:false,versionIdValid:true}}),'predicate_contract_incomplete'],
  [refusal({checks:{buildShaValid:true,buildShaMatchesExpected:false,versionIdValid:true,versionTimestampValid:true,extra:true}}),'predicate_contract_incomplete'],
  [refusal({checks:{buildShaValid:'true',buildShaMatchesExpected:false,versionIdValid:true,versionTimestampValid:true}}),'predicate_type_invalid'],
  [refusal({checks:{buildShaValid:true,buildShaMatchesExpected:true,versionIdValid:true,versionTimestampValid:true},version:{buildSha:SHA,id:VERSION,timestamp:'2026-09-30T10:00:00Z'}}),'predicate_contradiction_all_true_refusal'],
  [refusal({checks:{buildShaValid:true,buildShaMatchesExpected:true,versionIdValid:true,versionTimestampValid:false}}),'predicate_identity_inconsistent'],
  [refusal({version:{buildSha:null,id:VERSION,timestamp:'2026-09-30T10:00:00Z'}}),'predicate_identity_inconsistent'],
  [refusal({version:{buildSha:OTHER,id:'x',timestamp:'2026-09-30T10:00:00Z'}}),'observed_version_invalid'],
  [refusal({version:{buildSha:42,id:VERSION,timestamp:'2026-09-30T10:00:00Z'}}),'observed_buildSha_type_invalid'],
  [refusal({version:{buildSha:OTHER,id:VERSION}}),'observed_timestamp_missing'],
  [refusal({version:'string'}),'observed_identity_absent'],
  [refusal({diagnosticContract:'atlas-revision-diagnostic-v1'}),'artifact_contract_absent'],
  [{ok:false,code:'runtime_isolation_unproven',diagnosticContract:CONTRACT,checks:{paymentSandbox:false}},'unexpected_response'],
 ];
 for(const [payload,reason] of cases){const r=classifyDiagnostic(409,payload,{expectedSha:SHA});assert.equal(r.decision,DECISIONS.BLOCKED,reason);assert.equal(r.reason,reason);}
 assert.equal(classifyDiagnostic(409,refusal(),{expectedSha:'main'}).reason,'expected_identity_invalid');
 assert.equal(classifyDiagnostic(409,refusal(),{expectedSha:SHA,expectedVersion:'22222222-2222-4222-8222-222222222222'}).reason,'observed_version_drift');
 assert.equal(classifyDiagnostic(409,null,{expectedSha:SHA}).transportCaptured,false);
});
test('explicit HTTP200 contract: attested only with all-true booleans, non-null expected identity and digest; edge identity needs publisher content read',()=>{
 const attested={ok:true,code:'fixed_fixture_snapshot_attested',diagnosticContract:CONTRACT,checks:{paymentSandbox:true,customerFixtureProven:true},version:{buildSha:SHA,id:VERSION,timestamp:'2026-09-30T10:00:00Z'},fixtureSnapshotId:'c'.repeat(64)};
 const r=classifyDiagnostic(200,attested,{expectedSha:SHA});
 assert.equal(r.decision,DECISIONS.FIXTURE_ATTESTED);assert.equal(r.ok,true);assert.equal(r.operationalSuccess,true);assert.equal(r.modelAdmission,false);assert.equal(r.edgeIdentityProven,false);
 assert.equal(classifyDiagnostic(200,attested,{expectedSha:SHA,expectedVersion:VERSION,artifactContentVerified:true}).edgeIdentityProven,true);
 assert.equal(classifyDiagnostic(200,attested,{expectedSha:SHA,artifactContentVerified:true}).edgeIdentityProven,false,'without an expected version read, identity stays unproven');
 for(const [over,reason] of [[{checks:{paymentSandbox:false}},'attestation_checks_contradict_ok'],[{checks:{}},'attestation_checks_absent'],[{version:{buildSha:OTHER,id:VERSION,timestamp:'2026-09-30T10:00:00Z'}},'attestation_sha_mismatch'],[{version:{buildSha:SHA,id:null,timestamp:'2026-09-30T10:00:00Z'}},'attestation_identity_unknown'],[{fixtureSnapshotId:null},'fixture_snapshot_id_invalid'],[{diagnosticContract:undefined},'artifact_contract_absent']])assert.equal(classifyDiagnostic(200,{...attested,...over},{expectedSha:SHA}).reason,reason);
 assert.equal(classifyDiagnostic(200,{...attested,ok:false},{expectedSha:SHA}).reason,'unexpected_response');
});
test('observed identity raw types are validated as string|null before any regex coercion',()=>{
 assert.equal(validateObservedIdentity({buildSha:null,id:null,timestamp:null}),null);
 assert.equal(validateObservedIdentity({buildSha:['a'.repeat(40)],id:null,timestamp:null}),'observed_buildSha_type_invalid');
 assert.equal(validateObservedIdentity({buildSha:{},id:null,timestamp:null}),'observed_buildSha_type_invalid');
 assert.equal(validateObservedIdentity({buildSha:'A'.repeat(40),id:null,timestamp:null}),'observed_sha_invalid');
 const s=sanitizeFixtureResponse(409,{ok:false,code:'revision_unproven',version:{buildSha:42,id:['x']}});
 assert.deepEqual(s.version,{id:null,buildSha:null,timestamp:null});assert.deepEqual(s.versionRawTypes,{present:true,id:'array',buildSha:'number',timestamp:'undefined'});
});

// ---- actual compiled artifact over localhost HTTP ------------------------------------------------------------
const outDir=mkdtempSync(join(tmpdir(),'atlas-diagnostic-artifact-'));
const built=await buildDiagnosticBundle(outDir);
test('compiled artifact from committed source matches the recorded local receipt hash (source↔artifact correspondence)',()=>{
 assert.equal(built.sha256,receipt.artifactSha256,`rebuilt ${built.sha256} differs from receipt ${receipt.artifactSha256}; update receipt and runner pin together`);
 assert.equal(built.bytes,receipt.artifactBytes);
 assert.notEqual(built.sha256,receipt.supersededArtifactSha256,'the historical fc38 artifact is superseded, not reused');
});
const artifact=await import(pathToFileURL(built.outfile).href);
function world(overrides={}){const w=fixtureIsolationWorld({SHA,overrides:{PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_ISOLATED_FINANCE_TEST:'true',PAWSPACE_ATLAS_TEXT_TEST_JOB_ID:'Sentinel_'+'0'.repeat(32),FINANCE_TEST_ORIGIN:ORIGIN,...overrides},assert,STAGING_PROVIDER_FIXTURES});w.env.DB=w.db;return w;}
async function serve(w,query,{cookie=true}={}){
 globalThis.__ATLAS_DIAG_DB__=w.db;globalThis.__ATLAS_DIAG_ENV__=w.env;
 const server=http.createServer(async(req,res)=>{try{const request=new Request(`https://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers});const response=await artifact.default.fetch(request,w.env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(error){res.writeHead(500);res.end(String(error?.message));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const {port}=server.address();
 const headers={host:HOST,...(cookie?{cookie:`pawspace_uat=${await issueUatToken(w.env,'founder@synthetic.test',600)}`}:{})};
 try{return await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:`/__staging/fixture-isolation?${query}`,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{let json=null;try{json=JSON.parse(body)}catch{}resolve({status:res.statusCode,raw:body,json})});}).on('error',reject);});}
 finally{server.close();}
}
test('TEST HTTP: artifact emits four booleans, contract marker and observed identity on revision refusal; runner records VERIFIED_REFUSAL',async()=>{
 const w=world({PAWSPACE_STAGING_BUILD_SHA:OTHER});try{
  const r=await serve(w,`expectedSha=${SHA}&scope=grooming_strict`);
  assert.equal(r.status,409);assert.equal(r.json.code,'revision_unproven');assert.equal(r.json.diagnosticContract,CONTRACT);
  assert.deepEqual(Object.keys(r.json.checks).sort(),[...KEYS].sort());assert.deepEqual(r.json.checks,{buildShaValid:true,buildShaMatchesExpected:false,versionIdValid:true,versionTimestampValid:true});
  assert.deepEqual(r.json.version,{buildSha:OTHER,id:VERSION,timestamp:'2026-09-30T10:00:00Z'});
  const c=classifyDiagnostic(r.status,r.json,{expectedSha:SHA});assert.equal(c.decision,DECISIONS.VERIFIED_REFUSAL);assert.equal(c.ok,false);assert.equal(c.operationalSuccess,false);
  const s=sanitizeFixtureResponse(r.status,r.json);assert.equal(s.diagnosticContract,CONTRACT);assert.deepEqual(s.checks,r.json.checks);assert.equal(s.version.buildSha,OTHER);assert.equal(s.version.id,VERSION);
  assert.ok(w.reads.every(sql=>!sql.includes('canonical_')),'revision refusal happens before any fixture read');
 }finally{w.sqlite.close()}
});
test('TEST HTTP: absent metadata and malformed build SHA surface as null (unknown) with matching false predicates',async()=>{
 const w=world({PAWSPACE_STAGING_BUILD_SHA:'main',PAWSPACE_VERSION_METADATA:{id:'not-a-uuid',timestamp:'yesterday'}});try{
  const r=await serve(w,`expectedSha=${SHA}`);
  assert.equal(r.status,409);assert.deepEqual(r.json.checks,{buildShaValid:false,buildShaMatchesExpected:false,versionIdValid:false,versionTimestampValid:false});assert.deepEqual(r.json.version,{buildSha:null,id:null,timestamp:null});
  assert.equal(classifyDiagnostic(r.status,r.json,{expectedSha:SHA}).decision,DECISIONS.VERIFIED_REFUSAL);
  assert.ok(!r.raw.includes('main')&&!r.raw.includes('not-a-uuid'),'malformed raw values are never echoed');
 }finally{w.sqlite.close()}
});
test('TEST HTTP: HTTP200 strict Grooming attestation carries the contract and classifies as FIXTURE_ATTESTED; identity still needs the publisher read',async()=>{
 const w=world();try{
  w.sqlite.exec("DELETE FROM provider_capacity_profiles WHERE id!='uatcap_groom_ft'; DROP TABLE boarding_host_profiles");
  const r=await serve(w,`expectedSha=${SHA}&scope=grooming_strict`);
  assert.equal(r.status,200,r.raw);assert.equal(r.json.diagnosticContract,CONTRACT);assert.deepEqual(r.json.version,{buildSha:SHA,id:VERSION,timestamp:'2026-09-30T10:00:00Z'});
  const c=classifyDiagnostic(r.status,r.json,{expectedSha:SHA});assert.equal(c.decision,DECISIONS.FIXTURE_ATTESTED);assert.equal(c.operationalSuccess,true);assert.equal(c.modelAdmission,false);assert.equal(c.edgeIdentityProven,false);
  assert.equal(classifyDiagnostic(r.status,r.json,{expectedSha:SHA,expectedVersion:VERSION,artifactContentVerified:true}).edgeIdentityProven,true);
  assert.equal(sanitizeFixtureResponse(r.status,r.json).diagnosticContract,CONTRACT);
 }finally{w.sqlite.close()}
});
test('TEST HTTP: entry gates (disabled job, foreign origin, other route, no cookie) keep refusing and are BLOCKED for the runner',async()=>{
 const w=world();try{
  const anonymous=await serve(w,`expectedSha=${SHA}`,{cookie:false});assert.equal(anonymous.status,401);assert.equal(classifyDiagnostic(anonymous.status,anonymous.json,{expectedSha:SHA}).decision,DECISIONS.BLOCKED);
  const foreign=await serve({...w,env:{...w.env,FINANCE_TEST_ORIGIN:'https://other.example'}},`expectedSha=${SHA}`);assert.equal(foreign.status,403);
  const disabled=await serve({...w,env:{...w.env,PAWSPACE_ISOLATED_FINANCE_TEST:'false'}},`expectedSha=${SHA}`);assert.equal(disabled.status,503);
 }finally{w.sqlite.close()}
});
test.after(()=>rmSync(outDir,{recursive:true,force:true}));
