import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Training customer route uses canonical commercial, trainer, scheduler and programme ledgers",async()=>{const page=await read("app/training/page.tsx");for(const token of["loadTrainingPackages","quoteTraining","loadTrainingTrainers","reserveUatSchedule","createCanonicalTrainingBooking","materializeTrainingProgramme","programme.sessions","Canonical scheduler assignment"])assert.equal(page.includes(token),true,token);assert.equal(page.includes("const challenges ="),false);assert.equal(page.includes("Meet Arjun Kumar"),false)});

// This case used to pin `status:"captured"` and the literal "Training UAT sandbox capture marker" as
// REQUIRED source text - which is to say, it required the client to declare a payment capture it had
// never obtained, and passed for as long as that was true. A source-text pin can only prove that a
// string is present; it cannot tell whether the string is a fact. Measured in a browser, the server
// refused every such booking: "Training quote requires server-confirmed sandbox capture before
// programme booking". [PTJA-P1-F32]
//
// What the case is FOR - one server-quoted booking path, no live money - is unchanged. It is asserted
// against the path the client actually takes now, and the behaviour behind it is proven request-by-
// request in tests/ptja-p1-training-capture-attestation.test.mjs rather than by matching text here.
test("Training customer booking consumes a server quote and records only UAT sandbox payment truth",async()=>{const client=await read("lib/training-booking-client.ts");for(const token of["createCanonicalLifecycle","serviceCode:\"dog_training\"","trainingQuoteId:quote.quoteId","liveMoney:false"])assert.equal(client.includes(token),true,token);
 // The client must not assert its own capture: the attestation in lib/canonical-lifecycle-client.ts is
 // what promotes the payment, and it is the server's reference that ends up on the booking. Asserted as
 // the POSITIVE payload literal rather than as the ABSENCE of `status:"captured"` - a substring ban is
 // satisfied or broken by any prose that happens to quote the string, including the comment above this
 // file's own fix. That is the same weakness that let this case pin the defect in the first place.
 assert.match(client,/payment:\{method:"internal_uat",mode:quote\.paymentMode,status:"created"/,"the client sends an unproven payment as 'created'");
 const lifecycle=await read("lib/canonical-lifecycle-client.ts");
 assert.equal(lifecycle.includes("/api/training-payment-sandbox"),true,"the single booking path performs the server sandbox capture");
});

test("Training customer programme reserves the server-governed number of sessions",async()=>{const page=await read("app/training/page.tsx");for(const token of["occurrences:quote.meetAndGreet?1:quote.sessions","cadenceDays:7","quote.minutesPerSession","currentQuote.amountDueNow"])assert.equal(page.includes(token),true,token)});

// The Training page books for the SIGNED-IN customer. It used to hardcode customer TST-101 and pets
// TST-PET-BRUNO/TST-PET-PEPPER, so any other signed-in customer filled the form, saw a real quote and
// real trainers, pressed "Reserve trainer + create programme" and got a 403 from the session gateway:
// /api/uat-scheduling scopes the reservation to body.customerId and refuses a subject the session does
// not own. Nothing on the page said so. These assertions keep the fixture from coming back.
test("Training customer route books the signed-in customer's own dogs, never a fixture identity",async()=>{
 const page=await read("app/training/page.tsx");
 // Comment lines are stripped first: the comment above the fix names the fixture ids it removed, and
 // that history is worth keeping. What must not come back is a fixture in the executable code.
 const code=page.split("\n").filter(line=>!line.trim().startsWith("//")).join("\n");
 for(const fixture of["TST-101","TST-PET-BRUNO","TST-PET-PEPPER","uat.customer@pawspace.test"])
  assert.equal(code.includes(fixture),false,`hardcoded fixture ${fixture} must not be booked on behalf of a real customer`);
 // Identity and pets both come from the platform session, so the booking subject and the session
 // subject cannot disagree — which is exactly what the gateway rejects.
 for(const token of["loadCustomerAccount","account.customerId","pet.sourceId??pet.id"])
  assert.equal(page.includes(token),true,token);
 // Dogs-only service, and the customer's real selection drives the priced pet count.
 assert.equal(page.includes('pet.species==="dog"'),true,"only the customer's dogs are enrollable");
 assert.equal(page.includes("const petCount=selectedPets.length"),true,"petCount is derived from the real selection");
});

test("Training customer route never leaves the confirm button as a dead end",async()=>{
 const page=await read("app/training/page.tsx");
 // Signed out, no dogs, or nothing selected are all explained in the UI rather than surfacing as a
 // button that looks pressable and silently does nothing.
 assert.equal(page.includes("petCount===0"),true,"an empty selection is handled explicitly");
 for(const copy of["No dogs on your profile yet","Select at least one of your dogs to continue"])
  assert.equal(page.includes(copy),true,copy);
 // A 0-pet quote is never requested.
 assert.equal(page.includes("petCount>0?quoteTraining"),true,"quoting is skipped until a dog is selected");
});
