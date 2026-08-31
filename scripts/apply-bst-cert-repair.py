from pathlib import Path
import subprocess

root=Path('.')
def edit(path, changes):
    p=root/path; s=p.read_text()
    for old,new in changes:
        if old not in s: raise SystemExit(f'missing transform in {path}: {old[:80]!r}')
        s=s.replace(old,new)
    p.write_text(s)

# Reuse the already-proven generic Razorpay checkout authority from Grooming; rename only the client entrypoint.
subprocess.run(['git','fetch','origin','cert/grooming-razorpay-test-e2e'],check=True)
for path in ['lib/razorpay-checkout-verification.ts','app/api/payment-order/route.ts']:
    content=subprocess.check_output(['git','show',f'origin/cert/grooming-razorpay-test-e2e:{path}'],text=True)
    (root/path).write_text(content)
client=subprocess.check_output(['git','show','origin/cert/grooming-razorpay-test-e2e:lib/razorpay-checkout-client.ts'],text=True)
client=client.replace('openGroomingRazorpayTestCheckout','openRazorpayTestCheckout').replace('Grooming certification is restricted to Razorpay Test Mode','This certification checkout is restricted to Razorpay Test Mode').replace('description || "Grooming service"','description || "PawSpace service"')
(root/'lib/razorpay-checkout-client.ts').write_text(client)

edit('lib/canonical-lifecycle-client.ts',[
('vaccinationStatus?:string}>','vaccinationStatus?:string;medicationRequired?:boolean}>'),
('boardingQuoteId?:string;referralClaimId?:string','boardingQuoteId?:string;sittingQuoteId?:string;referralClaimId?:string'),
])
edit('lib/boarding-governance.ts',[(
'if(input.paymentStatus!=="captured")throw new Response("Boarding payment must be captured in sandbox before confirmation",{status:409});',
'if(input.paymentStatus!=="created"&&input.paymentStatus!=="captured")throw new Response("Boarding payment must be pending verified Razorpay capture or already captured by server evidence",{status:409});')])
edit('lib/sitting-governance.ts',[(
'if(input.paymentStatus!=="captured")throw governedJsonError({error:"Sitting payment must be captured in sandbox before confirmation"},409);',
'if(input.paymentStatus!=="created"&&input.paymentStatus!=="captured")throw governedJsonError({error:"Sitting payment must be pending verified Razorpay capture or already captured by server evidence"},409);')])
edit('app/api/canonical-bookings/route.ts',[
('import {requireSittingQuoteSandboxCapture} from "../../../lib/sitting-payment-governance";\n',''),
('  let sittingCapture:Awaited<ReturnType<typeof requireSittingQuoteSandboxCapture>>|null=null;\n',''),
('    sittingCapture=await requireSittingQuoteSandboxCapture(db,{quoteId,amount:input.amountDueNow});\n',''),
('paymentStatus:sittingCapture.status','paymentStatus:paymentStatusRecorded'),
('const paymentStatusPersisted=sittingCapture?.status??paymentStatusRecorded;','const paymentStatusPersisted=paymentStatusRecorded;'),
('sittingPaymentReference:sittingCapture?.reference','sittingPaymentReference:undefined'),
('JSON.stringify({reservations:reservations.results,decision:assignment})','JSON.stringify({reservations:reservations.results,decision:assignment,customerSelection:{requirements:input.pricing.requirements??[],healthSafetyNotes:input.pricing.healthSafetyNotes??null,behaviourNotes:input.pricing.behaviourNotes??null}})'),
])

edit('app/mobile-app/stay-flow.tsx',[
('import { createTestTransaction } from "../../lib/test-transaction";','import { createTestTransaction, updateTestTransaction } from "../../lib/test-transaction";\nimport { openRazorpayTestCheckout } from "../../lib/razorpay-checkout-client";'),
('import { captureSittingQuoteSandbox } from "../../lib/sitting-payment-client";\nimport { createCanonicalSittingBooking } from "../../lib/sitting-booking-client";\n',''),
('// Unique per-booking nonce. Kept as a module-scope helper so the impure Date.now()\n// call lives outside component render (matching istDate in the taxi/walking flows).\nconst bookingNonce = () => Date.now();\nconst careWindowDates=(start:string,end:string,window:CareWindow)=>{const scheduledStart=new Date(`${start}T03:30:00.000Z`),scheduledEnd=window==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduledStart.getTime()+(window==="10 hours"?10:window==="12 hours"?12:4)*3_600_000);return{scheduledStart,scheduledEnd};};',
'const normalizeMaterial=(value:string)=>value.trim().replace(/\\s+/g," ").toLowerCase();\nconst careWindowDates=(start:string,end:string,window:CareWindow,startTime="09:00")=>{const [hour,minute]=startTime.split(":").map(Number),scheduledStart=new Date(`${start}T00:00:00.000Z`);scheduledStart.setUTCHours(hour-6,minute+30,0,0);const scheduledEnd=window==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduledStart.getTime()+(window==="10 hours"?10:window==="12 hours"?12:4)*3_600_000);return{scheduledStart,scheduledEnd};};'),
('[careWindow, setCareWindow] = useState<CareWindow>("24 hours"),','[careWindow, setCareWindow] = useState<CareWindow>("24 hours"),\n    [startTime, setStartTime] = useState("09:00"),'),
('[foodType, setFoodType] = useState("Pet food from home"),','[foodType, setFoodType] = useState("Pet food from home"),\n    [specialRequest, setSpecialRequest] = useState(""),\n    [foodRoutine, setFoodRoutine] = useState(""),\n    [walkSleepRoutine, setWalkSleepRoutine] = useState(""),\n    [medicalNotes, setMedicalNotes] = useState(""),\n    [behaviourSafetyNotes, setBehaviourSafetyNotes] = useState(""),\n    [homeAccess, setHomeAccess] = useState("Key handover during Meet & Greet"),\n    [secondaryContact, setSecondaryContact] = useState(""),\n    [careCardUpdates, setCareCardUpdates] = useState(true),'),
('careWindowDates(start,end,careWindow)','careWindowDates(start,end,careWindow,startTime)'),
('[mode,serviceLocation,start,end,careWindow,selectedPets.length,splitEligible,splitPayment]','[mode,serviceLocation,start,end,careWindow,startTime,selectedPets.length,splitEligible,splitPayment]'),
('[mode,serviceLocation,careWindow,start,end,selectedPets.length,splitEligible,splitPayment]','[mode,serviceLocation,careWindow,start,end,startTime,selectedPets.length,splitEligible,splitPayment]'),
('[mode,serviceLocation,careWindow,start,end,selectedPets.length,boardingHostQueryKey,selectedSpeciesKey]','[mode,serviceLocation,careWindow,start,end,startTime,selectedPets.length,boardingHostQueryKey,selectedSpeciesKey]'),
('''    const requestId=`${mode}-${customer.customerId}-${start}-${end}-${careWindow.replaceAll(" ","")}-${selectedPets.length}-${bookingNonce()}`,decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:mode==="boarding"?governedHost?.providerId:providerIds[caregiver.name]});
    let canonicalBookingId:string;
    if(mode==="sitting"){
      const quote=sittingQuote!;await captureSittingQuoteSandbox({quoteId:quote.quoteId,amount:quote.amountDueNow});const result=await createCanonicalSittingBooking({idempotencyKey:`sitting:${quote.quoteId}:${customer.customerId}`,groupId:decision.groupId,sittingQuoteId:quote.quoteId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other",vaccinationStatus:"not_provided"})),cityId:serviceLocation.assignment.cityId,zoneId,packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:quote.paymentMode,detail:"Server-attested Sitting UAT sandbox capture"}});canonicalBookingId=result.bookingId;
    }else{
      const quote=governedBoardingQuote!;const result=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other" as const,vaccinationStatus:p.vaccinationStatus})),cityId:serviceLocation.assignment.cityId,zoneId,serviceCode:"boarding",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"upi",mode:quote.paymentMode,status:"captured",detail:"UAT Boarding sandbox payment from server quote"},pricing:{discount:0,boardingQuoteId:quote.quoteId}});canonicalBookingId=result.bookingId;
    }''',
'''    const requirements=[...selectedNeeds,...selectedBenefits,`Food: ${foodType}`,specialRequest&&`Special request: ${specialRequest}`,foodRoutine&&`Food/water: ${foodRoutine}`,walkSleepRoutine&&`Walk/toilet/sleep: ${walkSleepRoutine}`,mode==="sitting"&&`Home access: ${homeAccess}`,careCardUpdates&&"Care Card updates enabled"].filter((value):value is string=>Boolean(value)).map(value=>value.trim());
    const materialKey=[mode,customer.customerId,...selectedPets.slice().sort(),serviceLocation.assignment.cityId,zoneId,scheduleStart.toISOString(),scheduleEnd.toISOString(),careWindow,startTime,mode==="boarding"?governedHost?.providerId:providerIds[caregiver.name],...requirements.slice().sort(),normalizeMaterial(medicalNotes),normalizeMaterial(behaviourSafetyNotes)].map(value=>encodeURIComponent(String(value??""))).join(":");
    const requestId=`stay:${materialKey}`,decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:mode==="boarding"?governedHost?.providerId:providerIds[caregiver.name]});
    const quote=mode==="boarding"?governedBoardingQuote!:sittingQuote!;
    const result=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone,secondaryPhone:secondaryContact.trim()||undefined},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other" as const,breed:p.profile?.breed||p.breed||undefined,vaccinationStatus:p.vaccinationStatus,medicationRequired:selectedNeeds.includes("Medication")||/medicat/i.test(medicalNotes)})),cityId:serviceLocation.assignment.cityId,zoneId,serviceCode:mode==="boarding"?"boarding":"pet_sitting",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:quote.paymentMode,status:"created",detail:"Razorpay Test Mode payment pending verified webhook capture"},pricing:{discount:0,boardingQuoteId:mode==="boarding"?quote.quoteId:undefined,sittingQuoteId:mode==="sitting"?quote.quoteId:undefined,requirements,healthSafetyNotes:medicalNotes.trim()||undefined,behaviourNotes:behaviourSafetyNotes.trim()||undefined}});const canonicalBookingId=result.bookingId;'''),
('''      payment:
        mode === "boarding"
          ? splitEligible && splitPayment
            ? `50% deposit paid in UAT sandbox from canonical Boarding quote · ${money(balanceAmount)} due 24 hours before check-in`
            : "Paid in UAT sandbox from canonical Boarding quote"
          : splitEligible && splitPayment
            ? `50% stay deposit + Meet & Greet paid · ${money(balanceAmount)} due 24 hours before check-in`
            : "Server-attested Sitting UAT sandbox payment",''','''      payment: `Razorpay Test Mode payment pending · ${money(reserveAmount)} due now${balanceAmount>0?` · ${money(balanceAmount)} later`:""}`,
      initialPaymentStatus: "payment_pending",'''),
('''    setConfirmedTotal(governedBoardingQuote?.totalAmount ?? sittingQuote?.totalAmount ?? total);
    setBookingId(booking.id);
    setConfirmed(true);''','''    setConfirmedTotal(governedBoardingQuote?.totalAmount ?? sittingQuote?.totalAmount ?? total);
    setBookingId(booking.id);
    setConfirmed(true);
    try {const paid=await openRazorpayTestCheckout({bookingId:canonicalBookingId,customerName:customer.customerName,customerPhone:customer.phone,description:mode==="boarding"?"Boarding booking":"Pet Sitting booking"});updateTestTransaction({paymentStatus:paid.outcome==="captured"?"paid":"payment_pending",payment:paid.outcome==="captured"?`Razorpay Test Mode captured${paid.truth?.gatewayPaymentId?` · ${paid.truth.gatewayPaymentId}`:""}`:`Razorpay Test Mode pending · ${paid.error||"verified capture pending"}`} ,"accounts",paid.outcome==="captured"?"Verified Razorpay webhook capture reconciled the stay payment":"Stay payment remains pending until verified Razorpay webhook capture");}catch(paymentError){updateTestTransaction({paymentStatus:"payment_pending",payment:`Razorpay Test Mode pending · ${paymentError instanceof Error?paymentError.message:"checkout unavailable"}`} ,"accounts","Booking remains confirmed; payment is not marked captured without verified Razorpay evidence");}'''),
('<select defaultValue="9:00 AM">\n                <option>9:00 AM</option>\n                <option>1:00 PM</option>\n                <option>6:00 PM</option>\n              </select>','<select value={startTime} onChange={(e) => setStartTime(e.target.value)}>\n                <option value="09:00">9:00 AM</option>\n                <option value="13:00">1:00 PM</option>\n                <option value="18:00">6:00 PM</option>\n              </select>'),
('<textarea defaultValue="Please keep Bruno separate during meals and share one play-time video daily." />','<textarea value={specialRequest} onChange={(e) => setSpecialRequest(e.target.value)} placeholder="Separation, feeding or other special instructions" />'),
('<textarea defaultValue="Bruno: meals at 7:30 AM and 6:30 PM. Coco: wet food at 8 AM and 7 PM." />','<textarea value={foodRoutine} onChange={(e) => setFoodRoutine(e.target.value)} placeholder="Meal and water routine for the selected pets" />'),
('<textarea defaultValue="Bruno needs two 30-minute walks. Coco sleeps in the living room." />','<textarea value={walkSleepRoutine} onChange={(e) => setWalkSleepRoutine(e.target.value)} placeholder="Walk, toilet and sleep routine" />'),
('<textarea defaultValue="Bruno: one tablet after breakfast. Vet: Cessna Lifeline, Domlur." />','<textarea value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)} placeholder="Medication, allergies, medical restrictions and vet instructions" />\n          </label>\n          <label className={styles.field}>\n            Behaviour & safety notes\n            <textarea value={behaviourSafetyNotes} onChange={(e) => setBehaviourSafetyNotes(e.target.value)} placeholder="Bite/aggression history, anxiety, reactivity or handling restrictions" />'),
('<select>\n                <option>Key handover during Meet & Greet</option>','<select value={homeAccess} onChange={(e) => setHomeAccess(e.target.value)}>\n                <option>Key handover during Meet & Greet</option>'),
('<input defaultValue="Karthik · +91 99969 99505" />','<input value={`${customer.customerName} · ${customer.phone}`} readOnly />'),
('<input defaultValue="Rahul · +91 98802 22741" />','<input value={secondaryContact} onChange={(e) => setSecondaryContact(e.target.value)} placeholder="Optional emergency contact" />'),
('<input type="checkbox" defaultChecked />','<input type="checkbox" checked={careCardUpdates} onChange={(e) => setCareCardUpdates(e.target.checked)} />'),
])

edit('lib/taxi-booking-client.ts',[(
'payment:{method:string;mode:"sandbox_deferred";detail:string}};',
'payment:{method:string;mode:"sandbox_deferred";detail:string};safety?:{healthSafetyNotes?:string;behaviourNotes?:string;requirements?:string[]}};')])
edit('app/api/taxi-bookings/route.ts',[
('payment:{method:string;mode:string;detail:string}};','payment:{method:string;mode:string;detail:string};safety?:{healthSafetyNotes?:string;behaviourNotes?:string;requirements?:string[]}};'),
('paymentTiming:"production_policy_pending",productionMapsVerified:false,liveMoney:false','paymentTiming:"razorpay_verify_first",productionMapsVerified:false,liveMoney:false,healthSafetyNotes:input.safety?.healthSafetyNotes??null,behaviourNotes:input.safety?.behaviourNotes??null,requirements:input.safety?.requirements??[]'),
('JSON.stringify({source:"canonical_taxi_gate1",reservationId:governed.reservationId,routeSource:"uat_route_class",productionMapsVerified:false})','JSON.stringify({source:"canonical_taxi_gate1",reservationId:governed.reservationId,routeSource:"uat_route_class",productionMapsVerified:false,customerSelection:input.safety??{}})'),
])
edit('app/mobile-app/taxi-flow.tsx',[
('import { resolveServiceCoverage } from "../../lib/service-zone-client";','import { resolveServiceCoverage } from "../../lib/service-zone-client";\nimport { openRazorpayTestCheckout } from "../../lib/razorpay-checkout-client";'),
('  const [pincode, setPincode] = useState("");','  const [pincode, setPincode] = useState("");\n  const [safetyNotes, setSafetyNotes] = useState("");\n  const [behaviourNotes, setBehaviourNotes] = useState("");\n  const [paymentNote, setPaymentNote] = useState("Payment pending");'),
('''      const requestId = `taxi-${customer.customerId}-${fresh.routeCode}-${fresh.scheduledStart}`;
      // Auto-assignment''','''      const coverage = await resolveServiceCoverage(pincode);
      const normalized=(value:string)=>value.trim().replace(/\\s+/g," ").toLowerCase();
      const requestId=["taxi",customer.customerId,pet.id,fresh.routeCode,fresh.scheduledStart,coverage.cityId,coverage.zoneId,normalized(fresh.originLabel),normalized(fresh.destinationLabel),normalized(safetyNotes),normalized(behaviourNotes)].map(value=>encodeURIComponent(String(value))).join(":");
      // Auto-assignment'''),
('      const coverage = await resolveServiceCoverage(pincode);\n      const reservation','      const reservation'),
('pets: [{ sourceId: pet.sourceId ?? pet.id, name: pet.name, species: pet.species === "cat" ? "cat" : pet.species === "dog" ? "dog" : "other" }],','pets: [{ sourceId: pet.sourceId ?? pet.id, name: pet.name, species: pet.species === "cat" ? "cat" : pet.species === "dog" ? "dog" : "other", breed: pet.profile?.breed || pet.breed || undefined, vaccinationStatus: pet.vaccinationStatus }],'),
('payment: { method: "payment_link", mode: "sandbox_deferred", detail: "Payment remains pending until a verified payment event" } });\n      setQuote(fresh); setDriver(reservation.driver); setBooking(created);','payment: { method: "payment_link", mode: "sandbox_deferred", detail: "Payment remains pending until a verified payment event" }, safety:{healthSafetyNotes:safetyNotes.trim()||undefined,behaviourNotes:behaviourNotes.trim()||undefined,requirements:["Safe pet transport","Pickup/drop verification"]} });\n      setQuote(fresh); setDriver(reservation.driver); setBooking(created);\n      try{const paid=await openRazorpayTestCheckout({bookingId:created.bookingId,customerName:customer.customerName,customerPhone:customer.phone,description:"Pet Taxi booking"});setPaymentNote(paid.outcome==="captured"?"Razorpay Test Mode captured":"Razorpay Test Mode pending verified webhook capture");}catch(paymentError){setPaymentNote(`Razorpay Test Mode pending · ${paymentError instanceof Error?paymentError.message:"checkout unavailable"}`);}'),
('<p className={styles.note}>Dogs and cats welcome — one pet per trip so the driver&apos;s full attention stays on your companion. 🐾</p>\n          <button className={styles.primary} disabled={!pet} onClick={() => { setQuote(null); setStage(4); }}>Review &amp; confirm</button>','<p className={styles.note}>Dogs and cats welcome — one pet per trip so the driver&apos;s full attention stays on your companion. 🐾</p>\n          <span className={styles.label}>Medical &amp; transport safety notes</span>\n          <textarea className={styles.input} value={safetyNotes} onChange={event => setSafetyNotes(event.target.value)} placeholder="Medical restrictions, allergies, medication or handling requirements" />\n          <span className={styles.label}>Behaviour notes</span>\n          <textarea className={styles.input} value={behaviourNotes} onChange={event => setBehaviourNotes(event.target.value)} placeholder="Bite/aggression history, anxiety or reactivity" />\n          <button className={styles.primary} disabled={!pet} onClick={() => { setQuote(null); setStage(4); }}>Review &amp; confirm</button>'),
('<div><span>Due today</span><b>{quote ? money(quote.amountDueNow) : money(0)}</b></div>','<div><span>Due today</span><b>{quote ? money(quote.amountDueNow) : money(0)}</b></div>\n            <div><span>Payment</span><b>{paymentNote}</b></div>'),
])

(root/'tests/boarding-sitting-taxi-customer-integrity.test.mjs').write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const stay=fs.readFileSync("app/mobile-app/stay-flow.tsx","utf8"),taxi=fs.readFileSync("app/mobile-app/taxi-flow.tsx","utf8"),canonical=fs.readFileSync("app/api/canonical-bookings/route.ts","utf8"),payment=fs.readFileSync("app/api/payment-order/route.ts","utf8"),boarding=fs.readFileSync("lib/boarding-governance.ts","utf8"),sitting=fs.readFileSync("lib/sitting-governance.ts","utf8"),taxiApi=fs.readFileSync("app/api/taxi-bookings/route.ts","utf8");
test("stay material controls are controlled and preserved",()=>{assert.doesNotMatch(stay,/defaultValue=|defaultChecked/);assert.match(stay,/value=\{startTime\}/);assert.match(stay,/healthSafetyNotes:medicalNotes/);assert.match(stay,/behaviourNotes:behaviourSafetyNotes/);assert.match(stay,/requirements/);assert.match(stay,/breed:p\.profile\?\.breed\|\|p\.breed/);assert.match(stay,/vaccinationStatus:p\.vaccinationStatus/);});
test("stay retries use normalized material identity and never self-claim capture",()=>{assert.doesNotMatch(stay,/bookingNonce|Date\.now\(\).*request/);assert.match(stay,/selectedPets\.slice\(\)\.sort\(\)/);assert.match(stay,/status:"created"/);assert.doesNotMatch(stay,/captureSittingQuoteSandbox|status:"captured"/);});
test("boarding and sitting accept verify-first pending payment but not arbitrary states",()=>{assert.match(boarding,/paymentStatus!=="created"&&input\.paymentStatus!=="captured"/);assert.match(sitting,/paymentStatus!=="created"&&input\.paymentStatus!=="captured"/);assert.doesNotMatch(canonical,/requireSittingQuoteSandboxCapture/);});
test("provider work order carries care and safety snapshot",()=>{assert.match(canonical,/customerSelection:\{requirements:input\.pricing\.requirements/);assert.match(canonical,/healthSafetyNotes:input\.pricing\.healthSafetyNotes/);assert.match(canonical,/behaviourNotes:input\.pricing\.behaviourNotes/);});
test("taxi identity includes pet route locations zone and safety",()=>{for(const token of ["pet.id","coverage.cityId","coverage.zoneId","normalized(fresh.originLabel)","normalized(fresh.destinationLabel)","normalized(safetyNotes)","normalized(behaviourNotes)"])assert.match(taxi,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));assert.match(taxiApi,/customerSelection:input\.safety/);});
test("Razorpay checkout is verify-first and webhook remains capture authority",()=>{assert.match(payment,/verifyRazorpayCheckoutSignature/);assert.match(payment,/awaiting_webhook_capture/);assert.doesNotMatch(payment,/UPDATE booking_payments SET status='captured'/);});
''')
