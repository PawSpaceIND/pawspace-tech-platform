import test from"node:test";
import assert from"node:assert/strict";
import{evaluateUatSandboxReadiness}from"../lib/uat-sandbox-readiness.ts";

const completeEnv={
 PAWSPACE_PAYMENT_ENV:"sandbox",RAZORPAY_KEY_ID_SANDBOX:"rzp_test_key",RAZORPAY_KEY_SECRET_SANDBOX:"razor-test-secret",RAZORPAY_WEBHOOK_SECRET_SANDBOX:"razor-webhook-secret",
 PAWSPACE_COMMUNICATION_ENV:"uat",PAWSPACE_COMMUNICATION_PROVIDER_URL:"https://sms-test.example",PAWSPACE_COMMUNICATION_PROVIDER_TOKEN:"sms-test-token",PAWSPACE_COMMUNICATION_WEBHOOK_SECRET:"sms-webhook-secret",PAWSPACE_COMMUNICATION_UAT_ALLOWLIST:"+919999999999",
 META_WHATSAPP_UAT_DELIVERY_ENABLED:"true",META_WHATSAPP_UAT_ACCESS_TOKEN:"meta-test-token",META_WHATSAPP_PHONE_NUMBER_ID:"test-phone-id",META_WHATSAPP_WABA_ID:"test-waba",META_WHATSAPP_APP_SECRET:"meta-app-secret",META_WHATSAPP_VERIFY_TOKEN:"meta-verify-token",META_WHATSAPP_UAT_ALLOWLIST:"+919999999999",META_WHATSAPP_TEMPLATE_ALLOWLIST:"uat_booking_confirmation",
 PAWSPACE_MAPS_ENV:"sandbox",GOOGLE_MAPS_SERVER_API_KEY_UAT:"maps-test-key",PAWSPACE_AI_PROVIDER_API_KEY:"ai-test-key",
};
const verified=Object.fromEntries(["INT-PAY-01","INT-COMMS-02","INT-COMMS-01","INT-MAPS-01","INT-AI-01"].map(code=>{const evidenceId=`EVIDENCE-${code}`;return[code,{readinessState:"sandbox_verified",evidenceReference:`live-evidence:${evidenceId}`,evidenceId,matched:true}]}));
const configured={aiRolloutStage:"staff_only",aiProviderRef:"anthropic",aiModelRef:"claude-sonnet-4-6",smsAdapterConfigured:true};
const sensitiveValues=["razor-test-secret","razor-webhook-secret","sms-test-token","sms-webhook-secret","meta-test-token","meta-app-secret","meta-verify-token","maps-test-key","ai-test-key"];

test("strict UAT readiness reports every absent provider configuration as blocked without pretending synthetic logic is external proof",()=>{
 const result=evaluateUatSandboxReadiness({},{});
 assert.equal(result.status,"blocked");
 assert.equal(result.configuredForExternalTest,false);
 assert.equal(result.sandboxEvidenceVerified,false);
 assert.equal(result.syntheticLogicReady,true);
 assert.equal(result.productionEnabled,false);
 assert.equal(result.modules.length,5);
 assert.ok(result.modules.every(module=>module.status==="configuration_blocked"));
});

test("configured test credentials still require durable sandbox evidence before the indicator can say verified",()=>{
 const result=evaluateUatSandboxReadiness(completeEnv,configured);
 assert.equal(result.status,"external_test_required");
 assert.equal(result.configuredForExternalTest,true);
 assert.equal(result.sandboxEvidenceVerified,false);
 assert.ok(result.modules.every(module=>module.status==="external_test_required"));
});

test("all five modules become sandbox verified only with test configuration staff-only AI and evidence",()=>{
 const result=evaluateUatSandboxReadiness(completeEnv,{...configured,evidence:verified});
 assert.equal(result.status,"sandbox_verified");
 assert.equal(result.configuredForExternalTest,true);
 assert.equal(result.sandboxEvidenceVerified,true);
 assert.ok(result.modules.every(module=>module.status==="sandbox_verified"));
 const serialized=JSON.stringify(result);
 for(const value of sensitiveValues)assert.ok(!serialized.includes(value),"a credential value reached the readiness response");
});

test("production-shaped environment values cannot satisfy the UAT indicator",()=>{
 const result=evaluateUatSandboxReadiness({...completeEnv,PAWSPACE_PAYMENT_ENV:"live",PAWSPACE_MAPS_ENV:"production"},{...configured,evidence:verified});
 assert.equal(result.status,"blocked");
 assert.equal(result.modules.find(module=>module.code==="razorpay").configuredForExternalTest,false);
 assert.equal(result.modules.find(module=>module.code==="maps_gps").configuredForExternalTest,false);
});

/*
 * This case used to bundle a customer AI rollout in with live payments and production Maps and call all
 * three "cannot satisfy the UAT indicator". Owner decision 2026-09-22 opened the AI to customers on UAT
 * deployments, so that premise no longer holds for the AI module and keeping it would have reported the
 * owner's own decision as a readiness blocker. What still has to block is an AI that answers nobody:
 * 'off' is not a testable state. Both directions are asserted here so neither can quietly invert.
 */
test("the AI module is ready to test at either rollout stage that answers somebody, and never at 'off'",()=>{
 for(const aiRolloutStage of ["staff_only","customers"]){
  const result=evaluateUatSandboxReadiness(completeEnv,{...configured,aiRolloutStage,evidence:verified});
  const ai=result.modules.find(module=>module.code==="ai");
  assert.equal(ai.configuredForExternalTest,true,`a '${aiRolloutStage}' rollout is a configured UAT state`);
  assert.deepEqual(ai.blockers,[],`a '${aiRolloutStage}' rollout must raise no blocker`);
 }
 const off=evaluateUatSandboxReadiness(completeEnv,{...configured,aiRolloutStage:"off",evidence:verified});
 const blocked=off.modules.find(module=>module.code==="ai");
 assert.equal(blocked.configuredForExternalTest,false,"an AI that answers nobody is not ready to be tested");
 assert.ok(blocked.blockers.some(blocker=>/rollout/i.test(blocker)),"the blocker must name the rollout, not something else");
 assert.equal(off.status,"blocked");
});

test("a free-text evidence claim cannot satisfy strict sandbox verification",()=>{
 const claimed=Object.fromEntries(Object.entries(verified).map(([code,evidence])=>[code,{...evidence,evidenceReference:"tested in UAT"}]));
 const result=evaluateUatSandboxReadiness(completeEnv,{...configured,evidence:claimed});
 assert.equal(result.sandboxEvidenceVerified,false);
 assert.ok(result.modules.every(module=>module.status==="external_test_required"));
});
