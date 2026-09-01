import { writeFileSync } from "node:fs";
const base="https://pawspace-staging.karthik-fce.workers.dev",accessCode=String(process.env.PAWSPACE_UAT_ACCESS_CODE||"").trim();
if(!accessCode)throw new Error("PAWSPACE_UAT_ACCESS_CODE is required");
const bookingId="CERT-GATEWAY-SMOKE-20260901",providerId="CERT-PROVIDER";
const safe=async r=>{try{return await r.json()}catch{return null}};
async function req(path,init={}){const r=await fetch(`${base}${path}`,{...init,headers:{origin:base,...(init.body?{"content-type":"application/json"}:{}),...(init.headers||{})},signal:AbortSignal.timeout(30000)});return{status:r.status,body:await safe(r),headers:r.headers};}
async function login(email){const r=await req("/api/staging-login",{method:"POST",body:JSON.stringify({action:"login",code:accessCode,email})});if(r.status!==200)throw new Error(`login ${email} failed ${r.status}`);const cookie=String(r.headers.get("set-cookie")||"").split(";")[0];if(!cookie)throw new Error(`login ${email} issued no cookie`);return cookie;}
async function post(body,cookie){return req("/api/booking-operations",{method:"POST",headers:{cookie},body:JSON.stringify(body)});}
const invalid=await req("/api/razorpay-webhook",{method:"POST",headers:{"x-razorpay-signature":"deadbeef","x-razorpay-event-id":"evt_invalid_hmac_20260901"},body:JSON.stringify({event:"payment.captured",payload:{}})});
const makerEmail="founder@pawspace.in",checkerEmail="anjali.finance33@tkpetcare.in";
const maker=await login(makerEmail),checker=await login(checkerEmail);
let created=await post({bookingId,providerId,action:"refund_requested",reason:"Razorpay gateway smoke maker request"},maker);
let refundCaseId=String(created.body?.data?.refundCaseId||"");
if(!refundCaseId){const view=await req(`/api/booking-operations?bookingId=${encodeURIComponent(bookingId)}`,{headers:{cookie:maker}});refundCaseId=String(view.body?.data?.refunds?.[0]?.id||"");}
if(!refundCaseId)throw new Error(`refund case unavailable: ${JSON.stringify(created.body)}`);
const selfApproval=await post({bookingId,providerId,action:"refund_status",refundCaseId,refundStatus:"approved",reason:"Maker self approval negative test"},maker);
const checkerApproval=await post({bookingId,providerId,action:"refund_status",refundCaseId,refundStatus:"approved",reason:"Independent checker approval"},checker);
const evidence={invalidHmac:{status:invalid.status,body:invalid.body},maker:{actor:makerEmail,createStatus:created.status,refundCaseId},selfApproval:{actor:makerEmail,status:selfApproval.status,body:selfApproval.body},checkerApproval:{actor:checkerEmail,status:checkerApproval.status,body:checkerApproval.body}};
writeFileSync("gateway-smoke-negative.json",JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
if(invalid.status!==401)throw new Error(`invalid HMAC expected 401, got ${invalid.status}`);
if(![403,409].includes(selfApproval.status))throw new Error(`self approval was not rejected: ${selfApproval.status}`);
