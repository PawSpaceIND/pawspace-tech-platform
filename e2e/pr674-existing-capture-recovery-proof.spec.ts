import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
const CANDIDATE=String(process.env.PR674_CANDIDATE_SHA||"").trim();
const WORKER=String(process.env.PR674_WORKER_NAME||"").trim();
const ORIGIN=String(process.env.PR674_WORKER_ORIGIN||"").trim();
const ACCOUNT=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim();
const CF_TOKEN=String(process.env.CLOUDFLARE_API_TOKEN||"").trim();
const GH_TOKEN=String(process.env.GITHUB_TOKEN||"").trim();
const RZP_KEY=String(process.env.RAZORPAY_KEY_ID_SANDBOX||"").trim();
const RZP_SECRET=String(process.env.RAZORPAY_KEY_SECRET_SANDBOX||"").trim();
const PHONE="9000000674";
const BOOKING="PR674-PROVIDER-1789096751293";
const PAYMENT="PR674-PROVIDER-PAY-1789096751293";
const ORDER="order_TaZwvGwxOSRPHg";
const PROVIDER_PAYMENT="pay_TaZx544X5XCXbx";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;
async function cf(path:string,init:RequestInit={}){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,{...init,headers:{authorization:`Bearer ${CF_TOKEN}`,"content-type":"application/json",...(init.headers||{})},redirect:"manual",signal:AbortSignal.timeout(30000)});
 const body=await response.json() as Json;
 if(!response.ok||body.success!==true)throw new Error(`Cloudflare request failed (${response.status})`);
 return body.result;
}
async function d1(dbId:string,sql:string,params:unknown[]=[]){
 const result=await cf(`/d1/database/${dbId}/query`,{method:"POST",body:JSON.stringify({sql,params})}) as Array<{results?:Json[]}>;
 return result?.[0]?.results||[];
}
async function dbIdForWorker(){
 for(let page=1;page<=10;page++){
  const rows=await cf(`/d1/database?per_page=100&page=${page}`) as Json[];
  const hit=rows.find(row=>row.name===WORKER); if(hit?.uuid)return String(hit.uuid); if(!rows.length)break;
 }
 throw new Error("Isolated checkout D1 not found");
}
async function providerPayments(){
 const response=await fetch(`https://api.razorpay.com/v1/orders/${ORDER}/payments`,{headers:{authorization:`Basic ${Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64")}`},redirect:"manual",signal:AbortSignal.timeout(20000)});
 const body=await response.json() as Json;
 if(!response.ok)throw new Error(`Razorpay provider read failed (${response.status})`);
 return Array.isArray(body.items)?body.items:[];
}
async function pagePost(page:Page,path:string,body:Json){
 return page.evaluate(async({path,body})=>{const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"});return{status:response.status,body:await response.json()};},{path,body});
}
async function verifyTarget(){
 expect(CANDIDATE).toMatch(/^[0-9a-f]{40}$/); expect(WORKER).toMatch(/^pawspace-checkout-674-/); expect(ORIGIN).toBe(`https://${WORKER}.karthik-fce.workers.dev`);
 const pr=await fetch("https://api.github.com/repos/PawSpaceIND/pawspace-tech-platform/pulls/674",{headers:{authorization:`Bearer ${GH_TOKEN}`,accept:"application/vnd.github+json"},redirect:"manual",signal:AbortSignal.timeout(20000)});
 expect(pr.status).toBe(200); const prBody=await pr.json() as Json; expect(prBody.state).toBe("open"); expect(prBody.head?.sha).toBe(CANDIDATE);
 const settings=await cf(`/workers/scripts/${WORKER}/settings`) as Json; const bindings=Array.isArray(settings.bindings)?settings.bindings:[];
 const plain=Object.fromEntries(bindings.filter((b:Json)=>b.type==="plain_text").map((b:Json)=>[b.name,b.text]));
 expect(plain.PAWSPACE_RELEASE_SHA).toBe(CANDIDATE); expect(plain.PAWSPACE_PAYMENT_ENV).toBe("sandbox"); expect(plain.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
 const db=bindings.find((b:Json)=>b.type==="d1"&&b.name==="DB"); const dbId=await dbIdForWorker(); expect(String(db?.id||"").toLowerCase()).toBe(dbId.toLowerCase()); return dbId;
}
async function seedExistingCapturedIntent(dbId:string,customerId:string){
 const now=Date.now(),start=new Date(now+7*86400000).toISOString(),end=new Date(now+7*86400000+7200000).toISOString();
 const existing=await d1(dbId,"SELECT id FROM canonical_bookings WHERE id=?",[BOOKING]); expect(existing).toHaveLength(0);
 await d1(dbId,"INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','pr674-existing-capture','PR674 Existing Capture',?,'groom_kiran',?,?,'confirmed','customer_app',1,'INR','{}','pr674_existing_capture',?,?)",
  [BOOKING,`idem-${BOOKING}`,customerId,"[]","[]",`group-${BOOKING}`,start,end,now,now]);
 await d1(dbId,"INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1,1,'INR','netbanking','prepaid','created','uat_sandbox',?,'{}',?,?)",
  [PAYMENT,BOOKING,customerId,`idem-${PAYMENT}`,now,now]);
 await d1(dbId,`INSERT INTO payment_intents
  (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,
   gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,version,created_at,updated_at)
  VALUES (?,?,?,?,'razorpay','sandbox',?,100,'INR','CREATED','ORDER_CREATED',?,100,0,100,0,0,0,'proof-v1','proof-v1','{}',0,?,?)`,
  [`PI-${BOOKING}`,BOOKING,customerId,PAYMENT,`idem-pi-${BOOKING}`,ORDER,now-180000,now-180000]);
}
async function count(dbId:string,sql:string,params:unknown[]=[]){const rows=await d1(dbId,sql,params);return Number(rows[0]?.n||0);}
test("exact PR674 worker recovers the already-captured Razorpay TEST payment without a new charge",async({page},testInfo)=>{
 const dbId=await verifyTarget(); const beforeProvider=await providerPayments();
 const captured=beforeProvider.find((p:Json)=>p.id===PROVIDER_PAYMENT); expect(captured?.order_id).toBe(ORDER); expect(captured?.status).toBe("captured"); expect(captured?.captured).toBe(true); expect(captured?.amount).toBe(100); expect(captured?.currency).toBe("INR");
 await page.goto(`${ORIGIN}/mobile-app`,{waitUntil:"domcontentloaded"});
 const otp=await pagePost(page,"/api/customer-otp",{action:"request",phone:PHONE}); expect(otp.status).toBe(200); expect(otp.body.data.sandboxDelivery).toBe(true); expect(otp.body.data.liveSmsDelivered).toBe(false);
 const verified=await pagePost(page,"/api/customer-otp",{action:"verify",challengeId:otp.body.data.challengeId,code:otp.body.data.sandboxCode,name:"PR674 Existing Capture Proof",cityId:"blr",installId:`pr674-recovery-${Date.now()}`}); expect(verified.status).toBe(200);
 const customerId=String(verified.body.data.customerId); await seedExistingCapturedIntent(dbId,customerId);
 expect(await count(dbId,"SELECT COUNT(*) n FROM payment_gateway_events WHERE booking_id=?",[BOOKING])).toBe(0);
 expect(await count(dbId,"SELECT COUNT(*) n FROM gateway_webhook_events WHERE raw_payload LIKE ? OR raw_payload LIKE ?",[`%${PROVIDER_PAYMENT}%`,`%${ORDER}%`])).toBe(0);
 const signature=createHmac("sha256",RZP_SECRET).update(`${ORDER}|${PROVIDER_PAYMENT}`).digest("hex");
 const first=await pagePost(page,"/api/customer-checkout",{action:"confirm",bookingId:BOOKING,orderId:ORDER,paymentId:PROVIDER_PAYMENT,signature});
 expect(first.status).toBe(200); expect(first.body.data.receiptVerified).toBe(true); expect(first.body.data.status).toBe("captured"); expect(first.body.data.environment).toBe("sandbox");
 const intent=(await d1(dbId,"SELECT state,gateway_payment_id FROM payment_intents WHERE booking_id=?",[BOOKING]))[0]; expect(intent.state).toBe("CAPTURED"); expect(intent.gateway_payment_id).toBe(PROVIDER_PAYMENT);
 const payment=(await d1(dbId,"SELECT status,gateway FROM booking_payments WHERE booking_id=?",[BOOKING]))[0]; expect(payment.status).toBe("captured"); expect(payment.gateway).toBe("razorpay_sandbox");
 const events=await d1(dbId,"SELECT event_id,event_type,gateway_payment_id,signature_verified,processing_status,detail_json FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at",[BOOKING]);
 expect(events).toHaveLength(1); expect(events[0].gateway_payment_id).toBe(PROVIDER_PAYMENT); expect(Number(events[0].signature_verified)).toBe(0); expect(events[0].processing_status).toBe("processed"); expect(JSON.parse(String(events[0].detail_json)).captureAuthority).toBe("provider_api");
 expect(await count(dbId,"SELECT COUNT(*) n FROM gateway_webhook_events WHERE raw_payload LIKE ? OR raw_payload LIKE ?",[`%${PROVIDER_PAYMENT}%`,`%${ORDER}%`])).toBe(0);
 expect(await count(dbId,"SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'")).toBe(1);
 const outbox=(await d1(dbId,"SELECT status FROM financial_outbox WHERE event_type='RAZORPAY_CAPTURE_POST_COMMIT'"))[0]; expect(outbox.status).toBe("SUCCEEDED");
 const timeline=await d1(dbId,"SELECT actor_id,detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='payment_captured'",[BOOKING]); expect(timeline).toHaveLength(1); expect(timeline[0].actor_id).toBe("razorpay_provider_api");
 const second=await pagePost(page,"/api/customer-checkout",{action:"confirm",bookingId:BOOKING,orderId:ORDER,paymentId:PROVIDER_PAYMENT,signature}); expect(second.status).toBe(200); expect(second.body.data.status).toBe("captured");
 expect(await count(dbId,"SELECT COUNT(*) n FROM payment_gateway_events WHERE booking_id=?",[BOOKING])).toBe(1); expect(await count(dbId,"SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture'")).toBe(1);
 const afterProvider=await providerPayments(); expect(afterProvider.map((p:Json)=>p.id).sort()).toEqual(beforeProvider.map((p:Json)=>p.id).sort());
 const report={candidate:CANDIDATE,worker:WORKER,existingOrder:ORDER,existingProviderPayment:PROVIDER_PAYMENT,amountPaise:100,providerAlreadyCaptured:true,newProviderPaymentCreated:false,providerApiRecovery:true,signatureVerifiedStored:false,captureAuthority:"provider_api",webhookInboxCount:0,d1PaymentStatus:payment.status,intentState:intent.state,journalCount:1,timelineActor:timeline[0].actor_id};
 await testInfo.attach("pr674-existing-capture-recovery-proof",{body:JSON.stringify(report,null,2),contentType:"application/json"}); console.log(`[PR674-EXISTING-CAPTURE-RECOVERY] ${JSON.stringify(report)}`);
});
