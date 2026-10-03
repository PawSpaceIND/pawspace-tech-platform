import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshUatAiDb, stubFetch, jsonResponse } from "./helpers/ai-harness.mjs";
installAiHooks();
const { runPublicAiWebChat } = await import("../lib/ai-web-chat-adapter.ts");
async function world() {
 const {db} = freshUatAiDb({PAWSPACE_AI_PROVIDER:"openai",PAWSPACE_OPENAI_API_KEY:"test-not-real"});
 for (const [file,fn] of [["pricing-control-runtime","ensurePricingControlRuntime"],["training-commercial-governance","ensureTrainingCommercialTables"],["boarding-governance","ensureBoardingGovernanceTables"],["sitting-governance","ensureSittingGovernanceTables"],["walking-governance","ensureWalkingGovernanceTables"],["taxi-governance","ensureTaxiGovernanceTables"]]) await (await import(`../lib/${file}.ts`))[fn](db);
 await db.prepare("UPDATE service_packages SET active=1 WHERE package_code='dog-basic'").run();
 return db;
}
for (const question of [
 "What do grooming subscriptions cost, and can I pay after each service?",
 "My Labrador has mats and my grooming budget is ₹2000. Which package fits?",
 "My dog has a rash. What is the grooming price and is a bath suitable?",
 "What does grooming Bath & Basic include and how much does it cost?"
]) test(`sales intent survives price words: ${question}`,async()=>{
 const db=await world();const net=stubFetch(()=>jsonResponse({status:"completed",output_text:"Grounded care answer",usage:{input_tokens:10,output_tokens:10,total_tokens:20}}));
 try {const answer=await runPublicAiWebChat(db,{query:question,sessionKey:"sales-price-intent"});assert.equal(net.calls.length,1);assert.equal(JSON.parse(JSON.parse(net.calls[0].init.body).input).question,question);assert.equal(answer.ai.turn.output,"Grounded care answer");}finally{net.restore();}
});
test("plain published price question keeps zero-model path",async()=>{const db=await world();await db.prepare("UPDATE service_packages SET active=1 WHERE package_code='dog-basic'").run();const net=stubFetch(()=>{throw new Error("No paid provider permitted")});try{const result=await runPublicAiWebChat(db,{query:"How much does grooming cost?",sessionKey:"plain-price"});assert.match(result.ai.turn.output,/starts from ₹/);assert.equal(net.calls.length,0);}finally{net.restore();}});
