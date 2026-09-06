import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
import{trainingQuoteKey,trainingQuoteSpendable,trainingLocationPincode,trainingLocationZone}from"../lib/training-booking-guards.ts";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

const base={scheduledStart:"2026-08-19T10:00:00+05:30",packageCode:"training-2-starter",paymentMode:"split",petIds:["PET-A"]};

// ---------------------------------------------------------------------------
// 1. Stale quote protection. The page holds one quote; the danger is spending it against selections
//    it was never priced for. These drive the real functions the page imports.
// ---------------------------------------------------------------------------
test("every quote-driving input changes the quote key",()=>{
 const key=trainingQuoteKey(base);
 for(const [what,changed] of [
  ["date",{...base,scheduledStart:"2026-08-26T10:00:00+05:30"}],
  ["package",{...base,packageCode:"training-4-puppy"}],
  ["payment mode",{...base,paymentMode:"prepaid"}],
  ["added dog",{...base,petIds:["PET-A","PET-B"]}],
  ["swapped dog",{...base,petIds:["PET-B"]}],
  ["removed dog",{...base,petIds:[]}],
 ]) assert.notEqual(trainingQuoteKey(changed),key,`changing the ${what} must invalidate the quote`);
 // Selection ORDER is not a price input, so re-picking the same dogs must not churn the quote.
 assert.equal(trainingQuoteKey({...base,petIds:["PET-B","PET-A"]}),trainingQuoteKey({...base,petIds:["PET-A","PET-B"]}));
});

test("changing selections cannot submit the previous quote",()=>{
 // Mirrors exactly what the page does: inputs change → quote dropped; response applied → stamped
 // with the key it was PRICED for.
 const state={hasQuote:false,quotedKey:""};
 const inputsChanged=()=>{state.hasQuote=false;state.quotedKey="";};
 const responseApplied=pricedKey=>{state.hasQuote=true;state.quotedKey=pricedKey;};
 const spendable=currentKey=>trainingQuoteSpendable({...state,currentKey});

 const oneDog=trainingQuoteKey(base);
 inputsChanged();responseApplied(oneDog);
 assert.equal(spendable(oneDog),true,"a quote priced for the current selections is spendable");

 // The customer adds a second dog. The price is now wrong and must not be spendable for an instant.
 const twoDogs=trainingQuoteKey({...base,petIds:["PET-A","PET-B"]});
 inputsChanged();
 assert.equal(spendable(twoDogs),false,"the previous quote is dropped the moment selections change");
 assert.equal(spendable(oneDog),false,"and it is not spendable under its own old key either");

 responseApplied(twoDogs);
 assert.equal(spendable(twoDogs),true,"the replacement quote is spendable once it lands");
});

test("an out-of-order quote response can never become spendable",()=>{
 const state={hasQuote:false,quotedKey:""};
 const spendable=currentKey=>trainingQuoteSpendable({...state,currentKey});
 const slowOneDog=trainingQuoteKey(base);
 const twoDogs=trainingQuoteKey({...base,petIds:["PET-A","PET-B"]});

 // Request A (one dog) is in flight. The customer adds a dog; request B is issued and lands first.
 state.hasQuote=true;state.quotedKey=twoDogs;
 assert.equal(spendable(twoDogs),true);

 // Request A now finally arrives, late, and is applied. It carries ITS key, not the current one.
 state.hasQuote=true;state.quotedKey=slowOneDog;
 assert.equal(spendable(twoDogs),false,"a superseded response must not be spendable against newer selections");
});

test("a quote is never spendable before one has been priced",()=>{
 assert.equal(trainingQuoteSpendable({hasQuote:false,quotedKey:"",currentKey:trainingQuoteKey(base)}),false);
 // An empty stamp never matches, even against an empty current key.
 assert.equal(trainingQuoteSpendable({hasQuote:true,quotedKey:"",currentKey:""}),false);
});

// ---------------------------------------------------------------------------
// 2. City / zone. The governed model (lib/service-zones.ts) maps pincode→zone and covers Bengaluru
//    only, so anything it cannot answer is refused rather than defaulted into Bengaluru.
// ---------------------------------------------------------------------------
const blrAddress=[{postalCode:"560038",isDefault:true}];

test("a non-Bengaluru customer is refused rather than booked into Bengaluru",()=>{
 const decision=trainingLocationPincode({cityId:"hyd",addresses:[{postalCode:"500081",isDefault:true}]});
 assert.equal(decision.ok,false);
 assert.match(decision.reason,/Bengaluru only/);
});

test("a Bengaluru customer without a usable PIN code is refused, not defaulted to a zone",()=>{
 for(const addresses of [[],[{postalCode:null,isDefault:true}],[{postalCode:"56003",isDefault:true}]]){
  const decision=trainingLocationPincode({cityId:"blr",addresses});
  assert.equal(decision.ok,false,`addresses ${JSON.stringify(addresses)} must refuse`);
  assert.match(decision.reason,/PIN code/);
 }
});

test("the default address supplies the pincode, and it is normalised",()=>{
 const decision=trainingLocationPincode({cityId:"blr",addresses:[{postalCode:"560 001",isDefault:false},{postalCode:"560038",isDefault:true}]});
 assert.deepEqual(decision,{ok:true,pincode:"560038"},"the default address wins over the first one");
 assert.deepEqual(trainingLocationPincode({cityId:"blr",addresses:[{postalCode:"560 001",isDefault:true}]}),{ok:true,pincode:"560001"});
});

test("an unresolvable or closed zone is refused, never replaced with a fallback zone",()=>{
 const missing=trainingLocationZone(null,"560038");
 assert.equal(missing.ok,false);
 assert.match(missing.reason,/not in a serviced Bengaluru training zone/);
 const closed=trainingLocationZone({zoneId:"blr-east",zoneName:"East Bengaluru",serviceAvailable:false},"560038");
 assert.equal(closed.ok,false);
 assert.match(closed.reason,/not open for Dog Training/);
 // No refusal may leak a zone id a caller could book against.
 for(const refusal of [missing,closed]) assert.equal("zoneId" in refusal,false);
});

test("a governed serviced zone is accepted and carried through",()=>{
 assert.deepEqual(trainingLocationZone({zoneId:"blr-south",zoneName:"South Bengaluru",serviceAvailable:true},"560095"),
  {ok:true,zoneId:"blr-south",zoneName:"South Bengaluru"});
 assert.deepEqual(trainingLocationPincode({cityId:"blr",addresses:blrAddress}),{ok:true,pincode:"560038"});
});

// ---------------------------------------------------------------------------
// 3. The page must actually use these guards, and must not reintroduce a hardcoded zone.
// ---------------------------------------------------------------------------
test("the Training page books the governed zone and never a hardcoded one",async()=>{
 const page=await read("app/training/page.tsx");
 const code=page.split("\n").filter(line=>!line.trim().startsWith("//")).map(line=>line.replace(/\s\/\/.*$/,"")).join("\n");
 for(const token of["trainingQuoteKey","trainingQuoteSpendable","trainingLocationPincode","trainingLocationZone"])
  assert.equal(code.includes(token),true,`page must use ${token}`);
 // Availability, reservation and the canonical booking all take the resolved zone.
 for(const token of["cityId:location.cityId,zoneId:location.zoneId","zoneId:location.zoneId,scheduledStart,scheduledEnd","loadTrainingTrainers({cityId:location.cityId,zoneId:location.zoneId"])
  assert.equal(code.includes(token),true,token);
 // No city or zone literal survives in the page at all: the city guard moved into the tested helper,
 // and every bookable city/zone now comes from the resolved location.
 assert.deepEqual(code.match(/"blr[a-z-]*"/g)||[],[],"no hardcoded city or zone may remain in the page");
 // Invalidation is DERIVED, not written: currentQuote is null the instant quotedKey stops matching
 // quoteKey, so there is no state write to forget and no window between the two.
 assert.equal(code.includes("const currentQuote=quoteReady?quote:null"),true,"the quote must be derived, not imperatively cleared");
 assert.equal(code.includes("!currentQuote||!activeTrainer"),true,"confirm() gates on the derived quote");
 // Nothing may read the raw held quote outside confirm()'s validated local binding.
 const rawReads=(code.match(/(?<![A-Za-z])quote\.[a-zA-Z]+/g)||[]).length,localBinding=code.includes("const quote=currentQuote;");
 assert.equal(localBinding,true,"confirm() binds the validated quote to a local before use");
 assert.equal(/\{quote\.[a-zA-Z]+/.test(code.split("async function confirm")[0]),false,"no JSX above confirm() may read the raw quote");
 assert.ok(rawReads>0,"confirm() still consumes the server quote fields");
});

// A customer we cannot service must not be left staring at a spinner. The zone-gated availability
// effect returns early when there is no location, so anything whose loading flag that effect owned
// would never clear — the catalogue load is deliberately independent of the zone for that reason.
test("a refused customer never sees a spinner that cannot finish",async()=>{
 const page=await read("app/training/page.tsx");
 const code=page.split("\n").filter(line=>!line.trim().startsWith("//")).map(line=>line.replace(/\s\/\/.*$/,"")).join("\n");
 // The catalogue effect takes no location and no other dependency, so it always settles.
 assert.match(code,/loadTrainingPackages\(\)[\s\S]{0,400}?setCatalogueLoading\(false\)/,"the catalogue must clear its own loading flag");
 assert.equal(code.includes("loadTrainingPackages(),"),false,"the catalogue must not sit inside the zone-gated availability effect");
 // The early return that strands a flag must not be reachable with one still set.
 assert.equal(code.includes("if(!location)return()=>{active=false};"),true,"availability is still zone-gated");
 assert.equal(/setCatalogueLoading\(true\)/.test(code),false,"nothing re-arms the catalogue flag after the initial state");
 // And the confirm button no longer depends on a flag the early return could strand.
 assert.equal(/disabled=\{[^}]*\bloading\b/.test(code),false,"the button must not gate on a strandable loading flag");
});

test("the dog picker keeps the label the removed select had",async()=>{
 const page=await read("app/training/page.tsx");
 assert.match(page,/role="group" aria-labelledby="training-dogs-label"/,"the button group must be labelled");
 assert.match(page,/id="training-dogs-label"/,"and the label must carry that id");
});
