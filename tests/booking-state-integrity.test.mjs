import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
import{trainingProgrammeRequestId}from"../lib/booking-state-integrity.ts";
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
 assert.match(flow,/const quote=checkoutQuote/);
 const confirm=flow.slice(flow.indexOf("confirm = async"),flow.indexOf("if (confirmed)"));
 assert.doesNotMatch(confirm,/quote=await quoteTraining/,'confirm must not replace the displayed checkout quote with an unseen re-quote');
 assert.doesNotMatch(flow,/Bruno&apos;s training options/);
 assert.match(flow,/primaryPet\?\.name/);
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
 const governance=await read("lib/boarding-governance.ts");
 assert.match(governance,/vaccinationStatuses\.some\(status=>status!=="verified"\)/,'server boundary must still reject unverified Boarding pets');
});
