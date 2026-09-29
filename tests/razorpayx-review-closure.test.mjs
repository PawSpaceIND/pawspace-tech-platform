import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
import {world,seedActors,asActor} from "./helpers/execution-harness.mjs";
installWorkersHooks("__RX_REVIEW_DB__","__RX_REVIEW_ENV__");
const runtime=await import("../lib/razorpayx-payout-runtime.ts"),gateway=await import("../lib/api-gateway.ts");
const reconcile=await import("../app/api/razorpayx-test-reconcile/route.ts"),dispatch=await import("../app/api/razorpayx-test-dispatch/route.ts");
const notice=await import("../lib/razorpayx-dispatch-notice.ts");
const FINANCE="finance@review.test",SALES="sales@review.test",PATH="/api/razorpayx-test-reconcile";
const ENV={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_RAZORPAYX_ENV:"sandbox",PAWSPACE_RAZORPAYX_LIVE_APPROVED:"false",RAZORPAYX_KEY_ID_SANDBOX:"rzp_test_LOCAL",RAZORPAYX_KEY_SECRET_SANDBOX:"local-only",RAZORPAYX_ACCOUNT_NUMBER_SANDBOX:"local-only-account",RAZORPAYX_WEBHOOK_SECRET_SANDBOX:"local-only-webhook"};
const post=(email,body,path=PATH,headers={})=>asActor(email,path,{method:"POST",body:JSON.stringify(body),headers});
async function fixture(t){
 const w=world("__RX_REVIEW_DB__","__RX_REVIEW_ENV__",ENV);t.after(()=>w.sqlite.close());
 await seedActors(w.sqlite,w.db,[{id:"RF",email:FINANCE,role:"finance"},{id:"RS",email:SALES,role:"sales"}]);
 await runtime.ensureRazorpayXPayoutRuntime(w.db);
 const snapshot=JSON.stringify({providerId:"REVIEW-PROVIDER",verificationStatus:"verified",razorpayxContactId:"cont_REVIEW",razorpayxFundAccountId:"fa_REVIEW",verifiedForPayoutAt:1});
 w.sqlite.prepare("INSERT INTO payout_beneficiary_preauthorizations (scope_type,scope_id,provider_id,snapshot_json,snapshot_sha256,razorpayx_contact_id,razorpayx_fund_account_id,verified_at,expires_at) VALUES ('booking','REVIEW-BOOK','REVIEW-PROVIDER',?,?,'cont_REVIEW','fa_REVIEW',1,900001)").run(snapshot,createHash("sha256").update(snapshot).digest("hex"));
 w.sqlite.exec("INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,razorpayx_contact_id,razorpayx_fund_account_id,idempotency_key,provider_reference,created_by,created_at,updated_at) VALUES ('RPX-REVIEW','REVIEW-BOOK','REVIEW-PROVIDER',500,'INR','razorpayx','sandbox','payout_processed_sandbox',1,'cont_REVIEW','fa_REVIEW','review-key','pout_REVIEW','review-finance',1,1)");
 w.sqlite.exec("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,created_at,updated_at) VALUES ('RPX-REVIEW','commission','REVIEW-BOOK','REVIEW-PROVIDER',50000,'INR','fa_REVIEW','review-key','pout_REVIEW','processed',1,1)");
 t.mock.method(globalThis,"fetch",()=>assert.fail("Bookkeeping must not contact RazorpayX"));return w;
}
test("reconciliation has a fixed Finance permission regardless of caller action",async()=>{
 for(const action of [undefined,"reconcile_payout_books","approve_order_commission_level_2","save_provider_bank_account"])
  assert.equal(await gateway.requiredPermission(post(SALES,{payoutId:"RPX-REVIEW",action})),"finance.manage");
 const generic=readFileSync(new URL("../app/api/partner-finance/route.ts",import.meta.url),"utf8");
 assert.doesNotMatch(generic,/reconcile_payout_books|reconcileRecordedRazorpayXPayout/);
 assert.match(generic,/preauthorizeVerifiedPayoutBeneficiary/);
});
test("non-Finance and cross-origin requests cannot change recorded payout books",async t=>{
 const w=await fixture(t);
 for(const action of ["reconcile_payout_books","approve_order_commission_level_2"]){const result=await reconcile.POST(post(SALES,{payoutId:"RPX-REVIEW",action}));assert.equal(result.status,403);}
 assert.equal((await reconcile.POST(post(FINANCE,{payoutId:"RPX-REVIEW"},PATH,{origin:"https://other.test"}))).status,403);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='razorpayx_payout_accounting'").get().n,0);
});
test("authorized reconciliation exposes review and never manufactures another payout",async t=>{
 const w=await fixture(t);
 const response=await reconcile.POST(post(FINANCE,{payoutId:"RPX-REVIEW"})),body=await response.json();
 assert.equal(response.status,202);assert.equal(body.data.reconciliationRequired,true);assert.equal(body.data.status,"release_review_required");assert.equal(body.data.bankStatementReconciled,false);
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_order_payouts").get().n,1);
 assert.equal(w.sqlite.prepare("SELECT status FROM provider_order_payouts").get().status,"payout_processed_sandbox");
});
test("repeat dispatch reports accepted-but-unreconciled via HTTP 202 and audit detail",async t=>{
 const w=await fixture(t),response=await dispatch.POST(post(FINANCE,{payoutId:"RPX-REVIEW"},"/api/razorpayx-test-dispatch")),body=await response.json();
 assert.equal(response.status,202);assert.equal(body.data.connected,true);assert.equal(body.data.reconciliationRequired,true);assert.equal(body.data.duplicatePrevented,true);
 const audit=w.sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='partner.payout.razorpayx_test_dispatch'").get();
 assert.equal(JSON.parse(audit.detail_json).reconciliationRequired,true);assert.equal(JSON.parse(audit.detail_json).accountingStatus,"release_review_required");
});
function actualUiFunction(path,name,context){
 const source=readFileSync(new URL(`../${path}`,import.meta.url),"utf8"),tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let target;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)target=node;ts.forEachChild(node,visit);};visit(tree);assert.ok(target,`${path} must retain ${name}`);
 const code=ts.transpileModule(`${target.getText(tree)}\n${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return vm.runInNewContext(code,context);
}
for(const[path,name]of [["app/team/finance/partners/page.tsx","sendTestPayout"],["app/team/finance/contractors/page.tsx","sendPayout"]]){
 for(const reloadFails of [false,true])test(`actual Finance handler displays HTTP 202 warning: ${name}, reload failure=${reloadFails}`,async()=>{
  const state={error:"",notice:"",busy:"",feedbackRequest:0},calls=[];
  const set=key=>value=>{state[key]=typeof value==="function"?value(state[key]):value;};
  const fn=actualUiFunction(path,name,{setBusy:set("busy"),setError:set("error"),setNotice:set("notice"),setPayoutFeedbackRequest:set("feedbackRequest"),period:"2026-09",razorpayXDispatchNotice:notice.razorpayXDispatchNotice,
   fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return{ok:true,status:202,json:async()=>({data:{connected:true,reconciliationRequired:true,accounting:{status:"review_required",reason:"untrusted-provider-text"}}})};},
   load:async()=>{if(reloadFails)throw new Error("Refresh unavailable");}});
  await fn("RPX-REVIEW");assert.equal(calls.length,1);assert.equal(calls[0].url,"/api/razorpayx-test-dispatch");assert.equal(calls[0].body.payoutId,"RPX-REVIEW");
  assert.match(state.notice,/accounting requires Finance review/);assert.match(state.error,/Do not send another payout/);assert.doesNotMatch(state.notice,/untrusted-provider-text/);assert.equal(state.busy,"");assert.equal(state.feedbackRequest,1,"Completion asks for presentation focus exactly once");
 });
}
test("shared notice distinguishes provider acceptance, bookkeeping review and nonconfirmation",()=>{
 assert.equal(notice.razorpayXDispatchNotice({connected:true,accounting:{status:"principal_settled"}}).warning,false);
 assert.match(notice.razorpayXDispatchNotice({connected:true,reconciliationRequired:true}).message,/Do not send another payout/);
 assert.match(notice.razorpayXDispatchNotice({connected:false}).message,/not confirmed/);
});
