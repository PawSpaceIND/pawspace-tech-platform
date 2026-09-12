import{expect,test}from"@playwright/test";
import{setupJourney,runCompletedJourney}from"./helpers/grooming-journey-harness.mjs";
import{ensureProviderCommissionTables,saveProviderCompensationProfile,syncCompletedCommissionOrders}from"../lib/provider-commission-governance";

const DAY=86_400_000;
function futureSlot(){const d=new Date(Date.now()+14*DAY);d.setUTCHours(5,30,0,0);return d.toISOString();}

test("founder global UAT: customer booking -> partner assignment -> SLA -> commission calculation",async()=>{
 const ctx=await setupJourney();const db=ctx.db as unknown as D1Database;
 try{
  await ensureProviderCommissionTables(db);
  await db.prepare("UPDATE provider_capacity_profiles SET provider_model='commission',acceptance_timeout_minutes=3 WHERE id='groom_arun'").run();
  await saveProviderCompensationProfile(db,{providerId:"groom_arun",engagementModel:"commission",commissionMode:"percent",commissionValue:30,razorpayxContactId:"cont_uat",razorpayxFundAccountId:"fa_uat",reason:"Founder cross-flow UAT commission fixture",actor:"founder-uat"});
  const groupId=`FOUNDER-GLOBAL-${Date.now()}`;
  const journey=await runCompletedJourney(ctx,{customerId:"CUST-FOUNDER-GLOBAL",customerName:"Founder Global UAT",phone:"+919900009911",petSourceId:"PET-FOUNDER-GLOBAL",petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId,start:futureSlot()});
  expect(journey.booked.status).toBe(201);
  expect(journey.provider.id).toBe("groom_arun");
  const booking=ctx.sqlite.prepare("SELECT id,provider_id,status,total_amount FROM canonical_bookings WHERE id=?").get(journey.bookingId) as Record<string,unknown>;
  const work=ctx.sqlite.prepare("SELECT provider_id,provider_model,status FROM provider_work_orders WHERE booking_id=?").get(journey.bookingId) as Record<string,unknown>;
  expect(booking.provider_id).toBe("groom_arun");expect(booking.status).toBe("completed");expect(work.provider_id).toBe("groom_arun");expect(work.provider_model).toBe("commission");expect(work.status).toBe("completed");
  const offer=ctx.sqlite.prepare("SELECT offered_at,expires_at,responded_at,status FROM provider_assignment_offers WHERE group_id=?").get(groupId) as Record<string,unknown>|undefined;
  if(offer){expect(Number(offer.expires_at)-Number(offer.offered_at)).toBe(3*60_000);expect(["accepted","pending"]).toContain(String(offer.status));}
  expect(await syncCompletedCommissionOrders(db)).toBe(1);
  const commission=ctx.sqlite.prepare("SELECT order_amount,commission_mode,commission_value,commission_amount,status,completed_at,due_at FROM provider_order_commissions WHERE booking_id=?").get(journey.bookingId) as Record<string,unknown>;
  expect(commission.commission_mode).toBe("percent");expect(Number(commission.commission_value)).toBe(30);expect(Number(commission.commission_amount)).toBe(Math.round(Number(booking.total_amount)*30)/100);expect(commission.status).toBe("pending_confirmation");expect(Number(commission.due_at)-Number(commission.completed_at)).toBe(5*DAY);
 }finally{ctx.close();}
});
