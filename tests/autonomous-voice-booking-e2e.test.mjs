import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/voice-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__AUTO_BOOK_DB__","__AUTO_BOOK_ENV__");
const { extractVoiceBookingCreate } = await import("../lib/autonomous-voice-booking-extractor.ts");
const { validateBookingCreateArguments } = await import("../lib/autonomous-booking-tool.ts");
const { createStrictAutonomousBooking } = await import("../lib/autonomous-booking-create.ts");
const { ensureAutonomousBookingTables, finalizeAutonomousProviderAssignment, runAutonomousBookingExceptionSweep } = await import("../lib/autonomous-booking-engine.ts");
const { ensureAutonomousBookingCaptureTrigger } = await import("../lib/autonomous-booking-capture-trigger.ts");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const { ensureCommunicationTables, seedCommunicationPolicy } = await import("../lib/communication-engine.ts");
const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
const { respondToJobOffer } = await import("../lib/provider-workspace.ts");

const NOW = Date.parse("2026-09-05T16:30:00.000Z");
const SLOT = "2026-09-07T05:30:00.000Z"; // 11:00 IST

async function world(){
  const sqlite=new DatabaseSync(":memory:");
  const db=makeD1(sqlite);
  globalThis.__AUTO_BOOK_DB__=db;
  globalThis.__AUTO_BOOK_ENV__={PAWSPACE_DEPLOYMENT_ENV:"staging",PAWSPACE_COMMUNICATION_ENV:"sandbox"};
  await ensureAutonomousBookingTables(db);
  await ensureAutonomousBookingCaptureTrigger(db);
  await ensurePricingControlRuntime(db);
  await ensureCommunicationTables(db);
  await seedCommunicationPolicy(db);
  const now=NOW;
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES ('CUST-AUTO','blr','Autonomous Customer','+919876543210',NULL,'auto@example.test','voice','{}',?,?)").run(now,now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-AUTO','CUST-AUTO','Bruno','dog','Labrador','verified',NULL,?,?)").run(now,now);
  sqlite.prepare("UPDATE service_packages SET active=1,effective_from='2026-08-01',effective_to=NULL WHERE package_code='dog-basic'").run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,whatsapp_consent INTEGER,opt_out INTEGER DEFAULT 0)");
  sqlite.prepare("INSERT OR REPLACE INTO customer_contact_preferences VALUES ('CUST-AUTO',1,0)").run();
  sqlite.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('TERM-GROOM-AUTO','grooming',NULL,1,'active','commission_groomer',0.70,'none',0.18,1,0,0,12,'2026-08-01','Autonomous E2E active payout term','maker','checker','UAT-AUTO',?,?)").run(now,now);
  return{sqlite,db};
}

const paymentLink=async()=>({connected:true,environment:"sandbox",paymentLink:{id:"plink_auto_e2e",short_url:"https://rzp.io/i/auto-e2e",expire_by:Math.floor((NOW+30*60_000)/1000)}});
const whatsapp=async()=>({status:"provider_accepted",productionDelivery:false,provider:"interakt-mock"});

test("voice transcript -> booking.create -> signed capture -> CRM Won -> provider broadcast -> first accept needs no human approval",async()=>{
  const{sqlite,db}=await world();
  const transcript=JSON.stringify({intent:"booking_create",customer_phone:"+91 98765 43210",pet_id:"PET-AUTO",service_id:"dog-basic",date_time_slot:SLOT,service_location:{address:"12 CMH Road, Indiranagar, Bengaluru",pincode:"560038"}});
  const extracted=extractVoiceBookingCreate(transcript);
  assert.equal(extracted.intent,"booking_create");
  assert.equal(extracted.complete,true);
  assert.deepEqual(extracted.missing,[]);
  const locked=validateBookingCreateArguments("CUST-AUTO",extracted.arguments,"voice-auto-e2e-1","audio-bot","THREAD-AUTO");
  const created=await createStrictAutonomousBooking(db,globalThis.__AUTO_BOOK_ENV__,locked,{createPaymentLink:paymentLink,dispatchWhatsApp:whatsapp,now:()=>NOW});
  assert.equal(created.status,"provisional_awaiting_payment");
  assert.equal(created.humanApprovalRequired,false);
  assert.equal(created.paymentLink,"https://rzp.io/i/auto-e2e");
  assert.match(created.closingScript,/I have reserved your slot for/);
  assert.match(created.closingScript,/secure confirmation link to your WhatsApp/);
  const provisional=sqlite.prepare("SELECT status,provider_id,channel,total_amount FROM canonical_bookings WHERE id=?").get(created.bookingId);
  assert.equal(provisional.status,"provisional_awaiting_payment");
  assert.equal(provisional.provider_id,"unassigned");
  assert.equal(provisional.channel,"voice");
  assert.equal(provisional.total_amount,1899);

  const captured=await processGatewayEvent(db,{provider:"razorpay",environment:"sandbox",eventId:"evt_auto_capture_1",eventType:"payment.captured",bookingId:created.bookingId,gatewayPaymentLinkId:"plink_auto_e2e",gatewayPaymentId:"pay_auto_1",amountSubunits:189900,currency:"INR",createdAt:NOW+1000,signatureVerified:true,payloadHash:"sha-auto-capture-1",detail:{source:"mock_signed_webhook"}});
  assert.equal(captured.status,"processed");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(created.bookingId).status,"captured");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(created.bookingId).status,"confirmed");
  const opportunity=sqlite.prepare("SELECT stage,status,won_booking_id FROM crm_opportunities WHERE won_booking_id=?").get(created.bookingId);
  assert.equal(opportunity.stage,"won");
  assert.equal(opportunity.status,"won");
  const offers=sqlite.prepare("SELECT provider_id,detail_json FROM provider_job_offers WHERE booking_id=? AND status='offered' ORDER BY provider_id").all(created.bookingId);
  assert.ok(offers.length>=1,"payment capture must broadcast to at least one governed provider");
  const detail=JSON.parse(offers[0].detail_json);
  assert.equal(detail.serviceCode,"grooming");
  assert.equal(detail.address,"12 CMH Road, Indiranagar, Bengaluru");
  assert.ok(Number(detail.payoutAmount)>0);
  assert.match(String(detail.petProfileJson),/Bruno/);

  const winner=offers[0].provider_id;
  const accepted=await respondToJobOffer(db,{providerId:winner,bookingId:created.bookingId,accept:true});
  assert.equal(accepted.status,"accepted");
  const lockedSlot=await finalizeAutonomousProviderAssignment(db,{bookingId:created.bookingId,providerId:winner,actorId:`provider:${winner}`});
  assert.equal(lockedSlot.slotLocked,true);
  assert.equal(sqlite.prepare("SELECT provider_id FROM canonical_bookings WHERE id=?").get(created.bookingId).provider_id,winner);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) AND provider_id=?").get(created.bookingId,winner).n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM unified_cases WHERE customer_id='CUST-AUTO'").get().n,0,"happy path must create no human approval/case queue item");
});

test("absolute parameter lock refuses an incomplete booking before any D1 booking write",async()=>{
  const{sqlite}=await world();
  assert.throws(()=>validateBookingCreateArguments("CUST-AUTO",{customer_phone:"+919876543210",service_id:"dog-basic",date_time_slot:SLOT,service_location:{address:"Indiranagar",pincode:"560038"}},"missing-pet","audio-bot"),/pet_id or breed is required/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,0);
});

test("Ops exception queue opens only after the 30m payment and 15m provider SLA boundaries",async()=>{
  const{sqlite,db}=await world();
  const locked=validateBookingCreateArguments("CUST-AUTO",{customer_phone:"+919876543210",pet_id:"PET-AUTO",service_id:"dog-basic",date_time_slot:SLOT,service_location:{address:"12 CMH Road, Indiranagar, Bengaluru",pincode:"560038"}},"voice-timeout-1","audio-bot");
  const created=await createStrictAutonomousBooking(db,globalThis.__AUTO_BOOK_ENV__,locked,{createPaymentLink:paymentLink,dispatchWhatsApp:whatsapp,now:()=>NOW});
  await runAutonomousBookingExceptionSweep(db,{asOf:NOW+29*60_000});
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM autonomous_booking_exceptions").get().n,0);
  await runAutonomousBookingExceptionSweep(db,{asOf:NOW+31*60_000});
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM autonomous_booking_exceptions WHERE booking_id=? AND reason_code='payment_uncompleted_30m'").get(created.bookingId).n,1);
});
