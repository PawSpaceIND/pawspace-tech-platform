import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__TRAINING_CONFIRMATION_DB__");
const { loadVerifiedTrainingConfirmation, TrainingConfirmationPendingError } = await import("../lib/training-confirmation-client.ts");
const base = { bookingId:"B1", customerId:"C1", petIds:["PET1"], scheduleGroupId:"G1", workOrderId:"W1", paymentId:"PAY-HOLD", status:"payment_pending", duplicatePrevented:false, liveMoney:false };
const projection = { ready:true, bookingId:"B1", serviceCode:"dog_training", packageName:"Training", bookingStatus:"confirmed", paymentId:"PAY1", paymentMode:"split", paymentStatus:"captured", transactionId:"TX1", amountDueNow:0, totalAmount:100, currency:"INR", providerId:"TRAINER1", providerName:"Assigned trainer", providerModel:"full_time", workOrderStatus:"assigned", scheduledStart:"2026-10-01T10:00:00+05:30", scheduledEnd:"2026-10-01T11:00:00+05:30", updatedAt:1 };
const programme = { programme:{ id:"PG1", booking_id:"B1", provider_id:"TRAINER1", plan_code:"P1", plan_name:"Training", status:"active", total_sessions:1, completed_sessions:0, no_show_sessions:0, cancelled_sessions:0, meet_booking_id:null, pricing_snapshot_json:"{}" }, sessions:[{ id:"S1", programme_id:"PG1", booking_id:"B1", provider_id:"TRAINER1", sequence_no:1, scheduled_start:projection.scheduledStart, scheduled_end:projection.scheduledEnd, status:"scheduled" }], events:[] };
function fixture(patch={}, programmePatch={}) {
  const calls=[];
  const fresh=structuredClone(programme);
  Object.assign(fresh.programme, programmePatch);
  return { calls, fresh, dependencies:{
    projection:async(id,signal)=>{ calls.push({kind:"projection",id,signal});return {...projection,...patch}; },
    programme:async(id,signal)=>{ calls.push({kind:"programme",id,signal});return fresh; },
  }};
}
test("confirmation uses exact booking projection and fresh programme, not the payment hold", async()=>{
  const f=fixture(), signal=new AbortController().signal;
  const result=await loadVerifiedTrainingConfirmation(base,signal,f.dependencies);
  assert.equal(result.booking.status,"confirmed");assert.equal(result.booking.paymentId,"PAY1");
  assert.equal(result.programme,f.fresh);assert.equal(result.providerName,"Assigned trainer");
  assert.equal(base.status,"payment_pending");assert.equal(base.paymentId,"PAY-HOLD");
  assert.deepEqual(f.calls.map(c=>[c.kind,c.id]),[["projection","B1"],["programme","B1"]]);
  assert.ok(f.calls.every(c=>c.signal===signal));
});
for (const status of ["cancelled","canceled","refunded","failed","expired"]) {
  test(`terminal ${status} cannot be shown as confirmed even when ready is true`,async()=>{
    const f=fixture({bookingStatus:status});
    await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),/no longer confirmed/);
    assert.equal(f.calls.length,1);
  });
}
for (const patch of [{ready:false},{bookingStatus:"payment_pending"},{bookingStatus:"unknown"},{paymentStatus:"created"},{transactionId:null},{transactionId:" "},{paymentId:""},{providerId:""},{providerName:""},{paymentMode:"pay_after_service"}]) {
  test(`incomplete evidence stays pending: ${JSON.stringify(patch)}`,async()=>{
    const f=fixture(patch);
    await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),TrainingConfirmationPendingError);
    assert.equal(f.calls.length,1);
  });
}
for (const patch of [{bookingId:"B-OTHER"},{serviceCode:"grooming"}]) {
  test(`foreign projection is rejected: ${JSON.stringify(patch)}`,async()=>{
    const f=fixture(patch);
    await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),/does not match/);
    assert.equal(f.calls.length,1);
  });
}
for (const mode of ["prepaid","split","split_50_50"]) {
  test(`verified ${mode} uses the same confirmation contract`,async()=>{
    const f=fixture({paymentMode:mode});assert.equal((await loadVerifiedTrainingConfirmation(base,undefined,f.dependencies)).booking.status,"confirmed");
  });
}
test("fresh programme and every session must belong to the exact booking",async()=>{
  const wrongProgramme=fixture({}, {booking_id:"B-OTHER"});
  await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,wrongProgramme.dependencies),/does not match/);
  for (const patch of [{booking_id:"B-OTHER"},{programme_id:"PG-OTHER"}]) {
    const f=fixture();Object.assign(f.fresh.sessions[0],patch);
    await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),/does not match/);
  }
});
test("cancelled programme never renders confirmation",async()=>{
  const f=fixture({}, {status:"cancelled"});
  await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),/no longer active/);
});
test("missing sessions or stale programme provider remains pending",async()=>{
  const absent=fixture();absent.fresh.sessions=[];
  await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,absent.dependencies),TrainingConfirmationPendingError);
  const stale=fixture({}, {provider_id:"OLD-TRAINER"});
  await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,stale.dependencies),TrainingConfirmationPendingError);
});
test("transport failures surface without fabricating success",async()=>{
  const f=fixture();f.dependencies.projection=async()=>{throw new Error("network unavailable")};
  await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),/network unavailable/);
});
test("an aborted refresh performs no reads",async()=>{
  const f=fixture(), controller=new AbortController();controller.abort();
  await assert.rejects(loadVerifiedTrainingConfirmation(base,controller.signal,f.dependencies),{name:"AbortError"});
  assert.equal(f.calls.length,0);
});
test("default refresh contracts only read status/programme and never start another payment",async()=>{
  const original=globalThis.fetch, calls=[];
  const signal=new AbortController().signal;
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    if(String(url)==="/api/customer-checkout") return Response.json({data:{bookingId:"B1",environment:"sandbox",confirmation:projection}});
    if(String(url)==="/api/training-programmes?bookingId=B1") return Response.json({data:programme});
    throw new Error("Unexpected network contract: "+url);
  };
  try {
    await loadVerifiedTrainingConfirmation(base,signal);
    await loadVerifiedTrainingConfirmation(base,signal); // Explicit refresh after a successful capture.
    assert.equal(calls.length,4);
    for(const call of calls){
      // The shared API helper composes a deadline with caller cancellation; object identity is not its contract.
      assert.ok(call.init.signal instanceof AbortSignal);assert.equal(call.init.signal.aborted,false);assert.equal(call.init.cache,"no-store");
      if(call.url==="/api/customer-checkout"){
        assert.deepEqual(JSON.parse(call.init.body),{action:"status",bookingId:"B1"});
      }else assert.equal(call.init.method??"GET","GET");
    }
  } finally { globalThis.fetch=original; }
});

test('verified Meet & Greet requires its execution session but remains an assessment confirmation',async()=>{
 const f=fixture({packageCode:'trainer-meet-greet'});
 const result=await loadVerifiedTrainingConfirmation(base,undefined,f.dependencies);
 assert.equal(result.programme,null);assert.equal(result.booking.status,'confirmed');
 assert.deepEqual(f.calls.map(c=>c.kind),['projection','programme']);
});
test('unpaid Meet & Greet cannot bypass capture verification',async()=>{
 const f=fixture({packageCode:'trainer-meet-greet',paymentStatus:'created'});
 await assert.rejects(loadVerifiedTrainingConfirmation(base,undefined,f.dependencies),TrainingConfirmationPendingError);
});
test('preparing a Meet & Greet creates its canonical execution session before checkout',async(t)=>{
 const {prepareTrainingProgramme}=await import('../lib/training-programme-client.ts');
 const request=t.mock.method(globalThis,'fetch',async()=>Response.json({data:programme}));
 assert.equal(await prepareTrainingProgramme({bookingId:'MEET1',packageCode:'trainer-meet-greet'}),null);
 assert.equal(request.mock.callCount(),1);
 assert.deepEqual(JSON.parse(request.mock.calls[0].arguments[1].body),{bookingId:"MEET1"});
});

test('Training catalogue and programme gateways show a useful error for an HTML outage',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('<html>upstream gateway unavailable</html>',{status:502,headers:{'content-type':'text/html'}});
 try{const catalogue=await import('../lib/training-commercial-client.ts'),programme=await import('../lib/training-programme-client.ts');for(const call of [()=>catalogue.loadTrainingPackages(),()=>programme.loadTrainingProgramme('B1')])await assert.rejects(call(),error=>error instanceof Error&&!/Unexpected token|<html>|JSON/.test(error.message)&&error.message.length>10);}finally{globalThis.fetch=original;}
});

test("default refresh forwards caller cancellation through the bounded API helper", { timeout: 2000 }, async () => {
  const original = globalThis.fetch, controller = new AbortController();
  let began, calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      began();
    });
  };
  try {
    const pending = loadVerifiedTrainingConfirmation(base, controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, /too long|aborted/i);
    assert.equal(calls, 1, "cancellation must not start a programme read or a second payment");
  } finally { globalThis.fetch = original; }
});
