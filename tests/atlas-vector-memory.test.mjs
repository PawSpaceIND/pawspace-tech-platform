import test from "node:test";
import assert from "node:assert/strict";
import {classifyAtlasMemory,storeAtlasMemory,retrieveAtlasMemoryForLlm,ATLAS_VECTOR_MEMORY_MODEL,ATLAS_VECTOR_DIMENSIONS,ATLAS_VECTOR_METRIC} from "../lib/atlas-vector-memory.ts";

class DbMock{
 constructor(){this.calls=[];this.rows=[]}
 prepare(sql){const call={sql,binds:[]};this.calls.push(call);return{bind:(...binds)=>{call.binds=binds;return{run:async()=>({meta:{changes:1}}),all:async()=>({results:this.rows}),first:async()=>sql.includes("atlas_memory_consents")?{status:"granted"}:null}},run:async()=>({meta:{changes:1}})}}
}
const secureKey=Buffer.alloc(32,7).toString("base64");
const embedding=Array.from({length:1024},(_,i)=>i/1024);
const actor={email:"ops@test",name:"Ops",roleCode:"admin",permissions:["customers.manage"],developmentPreview:false,identitySource:"session",principalType:"staff",principalKey:"staff:ops@test"};

test("Vectorize contract is bge-m3 / 1024 / cosine",()=>{
 assert.equal(ATLAS_VECTOR_MEMORY_MODEL,"@cf/baai/bge-m3");
 assert.equal(ATLAS_VECTOR_DIMENSIONS,1024);
 assert.equal(ATLAS_VECTOR_METRIC,"cosine");
});

test("access codes and direct PII are classified as secure context",()=>{
 assert.equal(classifyAtlasMemory("Gate code is 1234").storage,"secure_context");
 assert.equal(classifyAtlasMemory("Lockbox PIN 8822").sensitivity,"credential");
 assert.equal(classifyAtlasMemory("Lockbox number 8822").storage,"secure_context");
 assert.equal(classifyAtlasMemory("Call me at +919876543210").storage,"secure_context");
 assert.equal(classifyAtlasMemory("Dog is afraid of autos").storage,"vector");
});

test("credential storage never invokes AI embedding or Vectorize",async()=>{
 const db=new DbMock();let aiCalls=0,vectorCalls=0;
 const result=await storeAtlasMemory(db,{ATLAS_SECURE_CONTEXT_KEY:secureKey,AI:{run:async()=>{aiCalls++;return{data:[embedding]}}},ATLAS_VECTORIZE:{upsert:async()=>{vectorCalls++},query:async()=>({matches:[]})}},{customerId:"C1",petId:"P1",content:"Gate code is 1234",actorId:"ops@test"});
 assert.equal(result.storage,"secure_context");assert.equal(result.vectorized,false);assert.equal(aiCalls,0);assert.equal(vectorCalls,0);
 const insert=db.calls.find(c=>c.sql.includes("INSERT INTO atlas_secure_context_facts"));assert.ok(insert);assert.equal(insert.binds.includes("Gate code is 1234"),false);
});

test("ordinary behavioral memory uses bge-m3 and filtered Vectorize metadata",async()=>{
 const db=new DbMock();let model="",metadata=null;
 const vector={upsert:async rows=>{metadata=rows[0].metadata},query:async()=>({matches:[]})};
 const result=await storeAtlasMemory(db,{AI:{run:async m=>{model=m;return{data:[embedding]}}},ATLAS_VECTORIZE:vector},{customerId:"C1",petId:"P1",content:"Dog is afraid of autos",actorId:"ops@test"});
 assert.equal(result.storage,"vector");assert.equal(model,"@cf/baai/bge-m3");assert.deepEqual(metadata,{customer_id:"C1",pet_id:"P1",sensitivity:"non_sensitive",memory_id:result.id});
});
test("LLM retrieval of a sensitive query stops before embeddings or Vectorize",async()=>{
 const db=new DbMock();let aiCalls=0,vectorCalls=0;
 const result=await retrieveAtlasMemoryForLlm(db,{AI:{run:async()=>{aiCalls++;return{data:[embedding]}}},ATLAS_VECTORIZE:{upsert:async()=>{},query:async()=>{vectorCalls++;return{matches:[]}}}},{actor,customerId:"C1",petId:"P1",query:"What is the lockbox code?"});
 assert.deepEqual(result,{matches:[],secureContextExcluded:true,consentDenied:false});assert.equal(aiCalls,0);assert.equal(vectorCalls,0);
});

test("normal LLM retrieval always filters customer, pet and non-sensitive metadata",async()=>{
 const db=new DbMock();let filter=null;
 await retrieveAtlasMemoryForLlm(db,{AI:{run:async()=>({data:[embedding]})},ATLAS_VECTORIZE:{upsert:async()=>{},query:async(_v,options)=>{filter=options.filter;return{matches:[]}}}},{actor,customerId:"C1",petId:"P1",query:"What does the dog dislike?"});
 assert.deepEqual(filter,{customer_id:"C1",sensitivity:"non_sensitive",pet_id:"P1"});
});

test("customer-only retrieval is scoped to customer-global memories, never every pet",async()=>{
 const db=new DbMock();let filter=null;
 await retrieveAtlasMemoryForLlm(db,{AI:{run:async()=>({data:[embedding]})},ATLAS_VECTORIZE:{upsert:async()=>{},query:async(_v,options)=>{filter=options.filter;return{matches:[]}}}},{actor,customerId:"C1",query:"What should staff remember?"});
 assert.deepEqual(filter,{customer_id:"C1",pet_id:"",sensitivity:"non_sensitive"});
});
