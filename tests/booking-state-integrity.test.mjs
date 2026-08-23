import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
import * as nodeModule from "node:module";

// lib/canonical-lifecycle-client.ts imports "./api-fetch" without an extension, which node's ESM
// resolver cannot resolve on its own. Every other suite in this repo installs the same .ts fallback.
// Without it this file threw ERR_MODULE_NOT_FOUND at load, so NONE of the #197 assertions below ever
// executed — the suite reported a single failing file rather than running. Static imports are hoisted
// above top-level code, so the libraries have to be pulled in dynamically AFTER the hook is registered.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const {trainingProgrammeRequestId} = await import("../lib/booking-state-integrity.ts");
const {createCanonicalLifecycle} = await import("../lib/canonical-lifecycle-client.ts");
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

const base={customerId:"CUS-A",petIds:["PET-B","PET-A"],packageCode:"training-8-basic",scheduledStart:"2026-09-01T09:30:00.000Z",frequency:"Tue & Sat"};

test("training programme idempotency binds customer and stable selected-pet identity",()=>{
 const first=trainingProgrammeRequestId(base);
 assert.equal(first,trainingProgrammeRequestId({...base,petIds:["PET-A","PET-B"]}),"pet selection order must not change a genuine retry key");
 assert.equal(first,trainingProgrammeRequestId(base),"identical booking intent must stay idempotent");
 assert.notEqual(first,trainingProgrammeRequestId({...base,customerId:"CUS-B"}),"another customer must never share the same booking key");
 assert.notEqual(first,trainingProgrammeRequestId({...base,petIds:["PET-A"]}),"a different selected-pet set must never share the same booking key");
});

test("mobile Training checkout uses the displayed quote and dynamic pet identity",async()=>{
 const flow=await read("app/mobile-app/training-flow.tsx");
 assert.doesNotMatch(flow,/training-TST101/);
 assert.match(flow,/trainingProgrammeRequestId/);
 const confirm=flow.slice(flow.indexOf("confirm = async"),flow.indexOf("if (confirmed)"));
 assert.match(confirm,/\bquote=checkoutQuote\b/);
 assert.doesNotMatch(confirm,/quote=await quoteTraining/,'confirm must not replace the displayed checkout quote with an unseen re-quote');
 assert.doesNotMatch(flow,/Bruno&apos;s training options/);
 assert.match(flow,/primaryPet\?\.name/);
});

test("Training programme confirmation attests sandbox payment before canonical booking while Meet & Greet stays pending",async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});if(String(url)==="/api/training-payment-sandbox")return Response.json({data:{quoteId:"TQ-1",status:"captured",amount:6000,currency:"INR",environment:"sandbox",reference:"TRN-UAT-PAY-1",duplicatePrevented:false,liveMoney:false,synthetic:true}},{status:201});return Response.json({data:{bookingId:"B-1",customerId:"CUS-A",petIds:["PET-A"],scheduleGroupId:"G-1",workOrderId:"WO-1",paymentId:"PAY-1",status:"confirmed",duplicatePrevented:false}},{status:201});};
 try{
  const common={idempotencyKey:"training-key",scheduleGroupId:"G-1",customer:{id:"CUS-A",name:"A",primaryPhone:"9999999999"},pets:[{sourceId:"PET-A",name:"Dog",species:"dog"}],cityId:"blr",zoneId:"blr-east",serviceCode:"dog_training",packageName:"P",scheduledStart:"2026-09-01T09:30:00.000Z",scheduledEnd:"2026-09-01T10:30:00.000Z",provider:{id:"P-1",name:"Trainer",model:"commission"},totalAmount:12000,amountDueNow:6000,payment:{method:"payment_link",mode:"split",status:"created",detail:"Awaiting verified payment"},pricing:{discount:0,trainingQuoteId:"TQ-1"}};
  await createCanonicalLifecycle({...common,packageCode:"training-8-basic"});
  assert.equal(calls.length,2);assert.equal(calls[0].url,"/api/training-payment-sandbox");assert.equal(JSON.parse(String(calls[0].init.body)).amount,6000);assert.equal(calls[1].url,"/api/canonical-bookings");const programmePayload=JSON.parse(String(calls[1].init.body));assert.equal(programmePayload.payment.status,"captured");assert.match(programmePayload.payment.detail,/TRN-UAT-PAY-1/);
  calls.length=0;
  await createCanonicalLifecycle({...common,packageCode:"trainer-meet-greet",amountDueNow:500,totalAmount:500,payment:{method:"payment_link",mode:"prepaid",status:"created",detail:"Awaiting verified payment"}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,"/api/canonical-bookings");assert.equal(JSON.parse(String(calls[0].init.body)).payment.status,"created");
 }finally{globalThis.fetch=originalFetch;}
});

test("Meet & Greet is standalone and cannot be partially created by programme confirm",async()=>{
 const flow=await read("app/mobile-app/training-flow.tsx");
 const meet=flow.slice(flow.indexOf("confirmMeetFirst = async"),flow.indexOf("confirm = async"));
 const confirm=flow.slice(flow.indexOf("confirm = async"),flow.indexOf("if (confirmed)"));
 assert.match(meet,/packageCode:"trainer-meet-greet"/);
 assert.match(meet,/status:"created"/,'standalone Meet & Greet must await verified payment rather than self-capture');
 assert.doesNotMatch(confirm,/packageCode:"trainer-meet-greet"/,'programme confirm must not create a Meet & Greet first');
 assert.match(confirm,/meetBookingId:linkedMeetBookingId\|\|undefined/,'programme may only link an already-created standalone meeting');
});

test("Boarding sends persisted vaccination truth and freezes the confirmed amount",async()=>{
 const flow=await read("app/mobile-app/stay-flow.tsx");
 assert.match(flow,/vaccinationStatus:p\.vaccinationStatus/);
 assert.doesNotMatch(flow,/vaccinationStatus:"verified"/,'customer flow must never manufacture verified vaccination');
 assert.match(flow,/confirmedTotal/);
 assert.match(flow,/total=\{confirmedTotal\?\?total\}/);
 const scheduling=await read("app/api/uat-scheduling/route.ts");
 assert.match(scheduling,/SELECT customer_id,vaccination_status FROM canonical_pets WHERE id=\?/,'Boarding reservation must read authoritative canonical pet status');
 assert.match(scheduling,/String\(pet\.customer_id\)!==input\.customerId/,'Boarding reservation must reject foreign pets before capacity is held');
 assert.match(scheduling,/String\(pet\.vaccination_status\)!=="verified"/,'Boarding reservation must reject unverified pets before capacity is held');
 const governance=await read("lib/boarding-governance.ts");
 assert.match(governance,/vaccinationStatuses\.some\(status=>status!=="verified"\)/,'server boundary must still reject unverified Boarding pets');
});