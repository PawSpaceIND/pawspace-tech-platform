import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {productionOtpEnabled} from "../lib/otp-production-runtime.ts";

const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const customerOtp=read("app/api/customer-otp/route.ts");
const partnerOtp=read("app/api/partner-otp/route.ts");
const gateway=read("lib/api-gateway.ts");
const balance=read("app/api/stay-balance/route.ts");
const tcs=read("lib/tcs-governance.ts");
const tds=read("lib/tds-governance.ts");
const worker=read("worker/index.ts");
const scheduling=read("app/api/uat-scheduling/route.ts");
const deploy=read(".github/workflows/deploy-production.yml");

const founderAutoprovisionSafe=(source)=>!source.includes("email===String(env.FOUNDER_EMAIL")&&!/if\s*\(\s*!user[^)]*FOUNDER_EMAIL[\s\S]{0,500}INSERT INTO app_users/.test(source);
const destructiveRefreshAfterRead=(source,deleteNeedle,readNeedle)=>source.indexOf(readNeedle)>=0&&source.indexOf(deleteNeedle)>source.indexOf(readNeedle);
const templateSyncIsolated=(source)=>{const scheduled=source.indexOf("async scheduled"),sync=source.indexOf("syncSubmittedMetaTemplateStatuses",scheduled),catchIndex=source.indexOf("catch(error){templateSyncError=",sync),fanout=source.indexOf("=await Promise.allSettled([",catchIndex);return scheduled>=0&&sync>scheduled&&catchIndex>sync&&fanout>catchIndex&&!source.slice(catchIndex,fanout).includes("catch(error){throw error");};
const restoreIsCollisionSafe=(source)=>source.includes("SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE")&&source.includes("restore=async()=>")&&source.includes("AND NOT EXISTS (SELECT 1 FROM scheduling_reservations other")&&source.includes("other.${SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE}")&&source.includes("SLOT_LOST_DURING_REASSIGN");

test("C4 production OTP requires the production artifact plus Fast2SMS and both routes deliver out-of-band",()=>{
 assert.equal(productionOtpEnabled({PAWSPACE_DEPLOYMENT_ENV:"production",FAST2SMS_API_KEY:"secret"}),true);
 assert.equal(productionOtpEnabled({PAWSPACE_DEPLOYMENT_ENV:"production"}),false);
 assert.equal(productionOtpEnabled({PAWSPACE_DEPLOYMENT_ENV:"staging",FAST2SMS_API_KEY:"secret"}),false);
 for(const source of [customerOtp,partnerOtp]){
  assert.match(source,/productionOtpEnabled/);
  assert.match(source,/sendFast2SmsMessage/);
  assert.match(source,/liveSmsDelivered:true/);
 }
 assert.match(deploy,/FAST2SMS_API_KEY: \$\{\{ secrets\.FAST2SMS_API_KEY \}\}/);
 assert.match(deploy,/PAWSPACE_IDENTITY_ASSERTION_SECRET: \$\{\{ secrets\.PAWSPACE_IDENTITY_ASSERTION_SECRET \}\}/);
});

test("C1 founder raw-header auto-provisioning is removed and the guard catches deliberate sabotage",()=>{
 assert.equal(founderAutoprovisionSafe(gateway),true);
 const sabotaged=`${gateway}\nif(!user&&email===String(env.FOUNDER_EMAIL||"").trim()){ await env.DB.prepare("INSERT INTO app_users"); }`;
 assert.equal(founderAutoprovisionSafe(sabotaged),false);
});

test("C2 self-paid balance is rejected before synthetic settlement in production",()=>{
 assert.match(balance,/PAWSPACE_PAYMENT_ENV\|\|""/);
 assert.match(balance,/PAWSPACE_DEPLOYMENT_ENV\|\|""/);
 assert.ok(balance.indexOf("productionBalanceSettlementBlocked(env)")<balance.indexOf("payStayBalance(db"));
});

test("C3 TCS/TDS destructive refreshes occur only after required statutory reads and sabotage is detected",()=>{
 const tcsDelete='DELETE FROM tcs_collections WHERE period=?';
 const tdsDelete='DELETE FROM tds_deductions WHERE period=?';
 assert.equal(destructiveRefreshAfterRead(tcs,tcsDelete,"SELECT c.booking_id,c.provider_id,c.service_code,c.order_value"),true);
 assert.equal(destructiveRefreshAfterRead(tds,tdsDelete,"SELECT r.id result_id,r.employee_id,r.gross_earnings"),true);
 const sabotageTcs=`${tcsDelete}\n${tcs.replace(tcsDelete,"")}`;
 const sabotageTds=`${tdsDelete}\n${tds.replace(tdsDelete,"")}`;
 assert.equal(destructiveRefreshAfterRead(sabotageTcs,tcsDelete,"SELECT c.booking_id,c.provider_id,c.service_code,c.order_value"),false);
 assert.equal(destructiveRefreshAfterRead(sabotageTds,tdsDelete,"SELECT r.id result_id,r.employee_id,r.gross_earnings"),false);
});

test("H9 template status exceptions cannot block the Promise.allSettled sweep fanout",()=>{
 assert.equal(templateSyncIsolated(worker),true);
 const sabotaged=worker.replace("catch(error){templateSyncError=", "catch(error){throw error;templateSyncError=");
 assert.equal(templateSyncIsolated(sabotaged),false);
});

test("H1 admin restore rechecks the partial-unique slot boundary and sabotage is detected",()=>{
 assert.equal(restoreIsCollisionSafe(scheduling),true);
 const sabotaged=scheduling.replace("AND NOT EXISTS (SELECT 1 FROM scheduling_reservations other", "AND EXISTS (SELECT 1 FROM scheduling_reservations other");
 assert.equal(restoreIsCollisionSafe(sabotaged),false);
});
