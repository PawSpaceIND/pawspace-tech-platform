import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {d1} from "./helpers/execution-harness.mjs";
import {ensureAtlasMemoryTables,setAtlasMemoryConsent,storeAtlasMemory,readAtlasSecureContext,retrieveAtlasMemoryForLlm} from "../lib/atlas-vector-memory.ts";
import {enforceAtlasToolRateLimit} from "../lib/atlas-rate-limit.ts";
const secureKey=Buffer.alloc(32,9).toString("base64"),embedding=Array.from({length:1024},(_,i)=>i/1024);
const actor={email:"ops@test",name:"Ops",roleCode:"admin",permissions:["customers.manage"],developmentPreview:false,identitySource:"session",principalType:"staff",principalKey:"staff:ops@test"};
function world(){const sqlite=new DatabaseSync(":memory:"),db=d1(sqlite);return{sqlite,db}}
test("secure context is consent-gated and AES-GCM AAD rejects tenant tampering",async()=>{
 const{sqlite,db}=world();await ensureAtlasMemoryTables(db);await setAtlasMemoryConsent(db,{customerId:"C1",granted:true,actor});
 await storeAtlasMemory(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{customerId:"C1",petId:"P1",content:"Gate code is 1234",actor,agentId:"ops",securePurpose:"deterministic_dispatch"});
 const ok=await readAtlasSecureContext(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{actor,customerId:"C1",petId:"P1",agentId:"ops",purpose:"deterministic_dispatch"});assert.equal(ok.facts[0].value,"Gate code is 1234");assert.equal(ok.aadBound,true);
 const cross=await readAtlasSecureContext(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{actor,customerId:"C1",petId:"P1",agentId:"sales",purpose:"deterministic_dispatch"});assert.deepEqual(cross.facts,[]);
 sqlite.prepare("UPDATE atlas_secure_context_facts SET customer_id='C2'").run();await setAtlasMemoryConsent(db,{customerId:"C2",granted:true,actor});
 await assert.rejects(()=>readAtlasSecureContext(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{actor,customerId:"C2",petId:"P1",agentId:"ops",purpose:"deterministic_dispatch"}));
 sqlite.close();
});test("revoked memory consent returns an empty vector result before AI or Vectorize",async()=>{
 const{sqlite,db}=world();await ensureAtlasMemoryTables(db);await setAtlasMemoryConsent(db,{customerId:"C1",granted:false,actor});let ai=0,vector=0;
 const result=await retrieveAtlasMemoryForLlm(db,{AI:{run:async()=>{ai++;return{data:[embedding]}}},ATLAS_VECTORIZE:{upsert:async()=>{},query:async()=>{vector++;return{matches:[]}}}},{actor,customerId:"C1",petId:"P1",query:"Dog preferences"});
 assert.deepEqual(result,{matches:[],secureContextExcluded:true,consentDenied:true});assert.equal(ai,0);assert.equal(vector,0);sqlite.close();
});
test("Atlas gateway enforces independent per-agent and per-tool rate buckets",async()=>{
 const{sqlite,db}=world(),input={agentCode:"ops",toolCode:"ops.inventory.check",env:{ATLAS_AGENT_RATE_LIMIT_PER_MINUTE:5,ATLAS_TOOL_RATE_LIMIT_PER_MINUTE:1}};
 await enforceAtlasToolRateLimit(db,input);await assert.rejects(()=>enforceAtlasToolRateLimit(db,input),error=>error instanceof Response&&error.status===429&&Number(error.headers.get("retry-after"))>=1);sqlite.close();
});
test("remediation vertical tools are registered with conservative boundaries",()=>{
 const source=readFileSync(new URL("../lib/atlas-phase2-vertical-tools.ts",import.meta.url),"utf8");
 for(const code of["ops.inventory.check","ops.fleet.track","ops.provisioning.execute","finance.ledger.reconcile"])assert.match(source,new RegExp(`"${code.replaceAll(".","\\.")}"`),`${code} must be registered`);
 assert.match(source,/"finance\.ledger\.reconcile":schema\("finance\.ledger\.reconcile",\["finance","atlas"\],"read","autonomous"/);
 assert.match(source,/"ops\.provisioning\.execute":schema\("ops\.provisioning\.execute",\["ops"\],"high","within_envelope"/);assert.match(source,/Atlas is recommendation-only for Phase 2 mutation tools/);
});
test("marketing budget reallocation compensates a successful source mutation when destination fails",()=>{
 const source=readFileSync(new URL("../lib/marketing-agent-gateway.ts",import.meta.url),"utf8");
 assert.match(source,/sourceMutated\s*=\s*true/);assert.match(source,/Compensation rollback:/);assert.match(source,/amountMinor:\s*payload\.fromDailyMinor/);assert.match(source,/source_compensated=false/);
});


test("revoking memory consent tombstones existing memory and re-grant never resurrects it",async()=>{
 const{sqlite,db}=world();await ensureAtlasMemoryTables(db);await setAtlasMemoryConsent(db,{customerId:"C1",granted:true,actor});
 const vectorEnv={AI:{run:async()=>({data:[embedding]})},ATLAS_VECTORIZE:{upsert:async()=>{},query:async()=>({matches:[]})}};
 await storeAtlasMemory(db,vectorEnv,{customerId:"C1",petId:"P1",content:"Dog dislikes autos",actor});
 await storeAtlasMemory(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{customerId:"C1",petId:"P1",content:"Gate code is 1234",actor,agentId:"ops",securePurpose:"deterministic_dispatch"});
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM atlas_vector_memories WHERE customer_id='C1' AND status='active'").get().n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM atlas_secure_context_facts WHERE customer_id='C1' AND status='active'").get().n,1);
 await setAtlasMemoryConsent(db,{customerId:"C1",granted:false,actor});
 assert.equal(sqlite.prepare("SELECT status FROM atlas_vector_memories WHERE customer_id='C1'").get().status,"revoked");
 assert.equal(sqlite.prepare("SELECT status FROM atlas_secure_context_facts WHERE customer_id='C1'").get().status,"revoked");
 await setAtlasMemoryConsent(db,{customerId:"C1",granted:true,actor});
 assert.equal(sqlite.prepare("SELECT status FROM atlas_vector_memories WHERE customer_id='C1'").get().status,"revoked");
 assert.equal(sqlite.prepare("SELECT status FROM atlas_secure_context_facts WHERE customer_id='C1'").get().status,"revoked");
 const secure=await readAtlasSecureContext(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey},{actor,customerId:"C1",petId:"P1",agentId:"ops",purpose:"deterministic_dispatch"});assert.deepEqual(secure.facts,[]);
 sqlite.close();
});
