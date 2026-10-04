import {test,expect,type Page} from "@playwright/test";
const trainer=(id:string,name:string)=>({id,name,model:"commission",rating:4.8,qualityScore:90,capacity:1,travelBufferMinutes:30,maxDailyJobs:6});
async function fixture(page:Page){
 const first=trainer("TRAINER-1","Trainer One"),second=trainer("TRAINER-2","Trainer Two");
 const state={providers:[first,second],assigned:first,refuse:false,reservations:[] as Record<string,unknown>[],bookings:[] as Record<string,unknown>[]};
 await page.route("**/api/**",async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,body=request.method()==="POST"?request.postDataJSON():{};
  const reply=(data:unknown,status=200)=>route.fulfill({status,json:{data}});
  if(path==="/api/identity-session")return reply({subjectType:"customer",subjectId:"TRAIN-C1"});
  if(path==="/api/customer-account")return reply({customerId:"TRAIN-C1",name:"Training Customer",primaryPhone:"9000000901",cityId:"blr",pets:[{id:"TRAIN-P1",sourceId:"TRAIN-P1",name:"Bruno",species:"dog",breed:"Labrador",ageYears:2,vaccinationStatus:"verified"}],addresses:[{id:"ADDR-1",line1:"21 Indiranagar Main Road",city:"Bengaluru",postalCode:"560038",isDefault:true}],bookings:[]});
  if(path==="/api/training-requirements")return reply([]);
  if(path==="/api/service-zone")return reply({zone:{zoneId:"blr-east",zoneName:"Bengaluru East",serviceAvailable:true}});
  if(path==="/api/training-commercial"){
   if(request.method()==="GET")return reply({packages:[{package_code:"training-4-puppy",name:"Foundation Training",sessions:4,validity_days:60,base_price:6000,currency:"INR",meet_and_greet:0,max_pets:4,direct_minutes_per_pet:45,coaching_minutes_per_pet:15,split_due_percent:50,version:1}],source:"fixture",liveMoney:false});
   return reply({quoteId:"TRAIN-Q1",packageCode:body.packageCode,packageName:"Foundation Training",packageVersion:1,sessions:4,validityDays:60,petCount:body.petCount,minutesPerSession:60,basePrice:6000,discount:0,totalAmount:6000,amountDueNow:body.paymentMode==="split"?3000:6000,paymentMode:body.paymentMode,meetAndGreet:false,expiresAt:Date.now()+900000,liveMoney:false});
  }
  if(path==="/api/training-trainers")return reply({providers:state.providers,source:"fixture",liveAvailability:false});
  if(path==="/api/uat-scheduling"){
   const occurrences=Array.from({length:Number(body.occurrences)},(_,i)=>({start:new Date(Date.parse(body.scheduledStart)+i*Number(body.cadenceDays)*86400000).toISOString(),end:new Date(Date.parse(body.scheduledEnd)+i*Number(body.cadenceDays)*86400000).toISOString(),occurrenceNumber:i+1}));
   if(body.action==="preview")return reply({providers:state.providers,availabilityChecked:true,reserved:false,cityId:body.cityId,zoneId:body.zoneId,scheduledStart:body.scheduledStart,scheduledEnd:body.scheduledEnd,occurrences});
   state.reservations.push(body);if(state.refuse)return route.fulfill({status:409,json:{error:"SELECTED_PROVIDER_UNAVAILABLE"}});
   return reply({groupId:body.clientRequestId,provider:state.assigned,occurrences});
  }
  if(path==="/api/canonical-bookings"){state.bookings.push(body);return reply({bookingId:"TRAIN-B1",customerId:"TRAIN-C1",petIds:["TRAIN-P1"],scheduleGroupId:body.scheduleGroupId,workOrderId:"TRAIN-W1",paymentId:"TRAIN-PAY1",status:"payment_pending",duplicatePrevented:false});}
  if(path==="/api/training-programmes")return reply({programme:{id:"TRAIN-PROGRAMME",booking_id:"TRAIN-B1",provider_id:state.assigned.id,total_sessions:4},sessions:[],events:[]});
  if(path==="/api/customer-checkout")return reply({bookingId:"TRAIN-B1",amountDueNow:3000,paymentStatus:"created",sandboxOnly:true});
  return reply({});
 });
 await page.goto("/v2/training");
 const firstDate=page.getByLabel(/First session date/);
 await expect(firstDate).toBeEnabled();await firstDate.fill("2026-10-08");
 await expect(page.getByText(/trainer is available|trainers are available/)).toBeVisible();
 await expect(page.getByRole("button",{name:/Reserve trainer & continue/})).toBeEnabled();return state;
}

test("V2 Training defaults to automatic matching and uses the assigned trainer before payment",async({page})=>{
 const state=await fixture(page);state.assigned=trainer("TRAINER-NEW","Currently Available Trainer");
 await page.getByRole("button",{name:/Reserve trainer & continue/}).click();
 await expect(page.getByRole("heading",{name:"Complete payment to confirm"})).toBeVisible();
 expect(state.reservations).toHaveLength(1);expect(state.reservations[0].providerSelection).toBe("auto");expect(state.reservations[0].preferredProviderId).toBeUndefined();
 expect(state.bookings).toHaveLength(1);expect(state.bookings[0].provider).toMatchObject({id:"TRAINER-NEW"});
 await expect(page.getByRole("region",{name:"Reserved training details"})).toContainText("Currently Available Trainer");
 expect(state.reservations[0].occurrences).toBe(1);
});
test("V2 Training reservation refusal creates no booking or payment",async({page})=>{
 const state=await fixture(page);state.refuse=true;
 await page.getByRole("button",{name:/Reserve trainer & continue/}).click();
 await expect(page.getByRole("alert").first()).toBeVisible();
 expect(state.reservations[0]).toMatchObject({providerSelection:"auto",occurrences:1});expect(state.bookings).toHaveLength(0);
 await expect(page.getByRole("heading",{name:"Complete payment to confirm"})).toHaveCount(0);
});
test("V2 Training refreshes first-slot availability without creating a booking",async({page})=>{
 const state=await fixture(page);state.providers=[trainer("TRAINER-2","Trainer Two")];
 await page.getByRole("button",{name:"Refresh trainer availability"}).click();
 await expect(page.getByText(/trainer is available/)).toBeVisible();
 await expect(page.getByRole("button",{name:/Reserve trainer & continue/})).toBeEnabled();expect(state.reservations).toHaveLength(0);
});
