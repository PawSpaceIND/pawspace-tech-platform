import {expect,test} from "@playwright/test";
// UI transport fixtures exercise real rendered components. API authorization and persistence
// are separately exercised against real handlers/SQLite in uat-phase3-checklist-api.test.mjs.
const provider="phase3-provider";
const job={bookingId:"phase3-job",providerId:provider,providerName:"UAT Groomer",status:"arrived",workOrderStatus:"arrived",serviceCode:"grooming",packageName:"UAT grooming",packageCode:"uat",zoneId:"blr-central",cityId:"blr",scheduledStart:new Date().toISOString(),scheduledEnd:new Date(Date.now()+3600000).toISOString(),totalAmount:1000,occurrenceCount:1,customer:{name:"UAT Customer",maskedPhone:"******0000"},pets:[{name:"Maya",breed:"Labrador",vaccinationStatus:"verified",safetyNotes:["Sensitive left paw — handle gently"]}],payment:{mode:"prepaid",status:"captured",amount:1000,amountDueNow:0},addOns:[],safetyRequirements:[],events:[],proof:null};
test("active job dominates home; safety gate and offline replay survive page reload",async({page,context},info)=>{
 let status="arrived",posts=0,blocked=false;
 await context.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(blocked)return route.abort("internetdisconnected");
  let body:unknown={data:{}};
  if(path==="/api/identity-session")body={data:{subjectType:"provider",subjectId:provider}};
  if(path==="/api/partner-jobs")body={jobs:[{...job,bookingId:"future-job",status:"assigned"},{...job,status}]};
  if(path==="/api/grooming-route")body={data:{destinationAddress:"UAT house, Bengaluru",destination:{latitude:12.97,longitude:77.59},navigationUrl:"https://www.google.com/maps/dir/?api=1&destination=12.97,77.59"}};
  if(path==="/api/grooming-lifecycle"){
   if(route.request().method()==="POST"){posts++;expect(route.request().postDataJSON().checklist).toEqual(["pet_identity","safety_review","safe_setup"]);status="in_service";}
   body={data:{booking:{provider_id:provider,status}}};
  }
  if(path==="/api/uat-provider-switch")return route.fulfill({status:404,json:{}});
  await route.fulfill({json:body});
 });
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("/partner-app");
 await expect(page.getByRole("heading",{name:"Your active job"})).toBeVisible();
 await expect(page.getByText("You are ON DUTY")).toBeVisible();
 await expect(page.getByText("Next assignment",{exact:true})).toHaveCount(0);
 await expect(page.getByText("Sensitive left paw — handle gently")).toBeVisible();
 const start=page.getByRole("button",{name:"Start service",exact:true}).first();await expect(start).toBeDisabled();
 for(const label of ["I verified the pet and booked service","I reviewed behaviour, medical and handling notes with the customer","The pet and equipment are safe to begin"])await page.getByRole("checkbox",{name:label}).check();
 await expect(start).toBeEnabled();
 blocked=true;await page.evaluate(()=>{Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>false});window.dispatchEvent(new Event("offline"));});
 await start.click();await expect(page.getByText(/1 update\(s\) saved on this device/)).toBeVisible();expect(posts).toBe(0);
 // Reload the real page while API replay is still unavailable; the saved queue must survive.
 await page.reload();expect(await page.evaluate(p=>JSON.parse(localStorage.getItem(`pawspace:partner-status:v1:${p}`)||"[]").length,provider)).toBe(1);
 blocked=false;await page.reload();
 await expect.poll(()=>posts).toBe(1);await expect(page.getByText("After-service checklist")).toBeVisible();
 await expect.poll(()=>page.evaluate(p=>JSON.parse(localStorage.getItem(`pawspace:partner-status:v1:${p}`)||"[]").length,provider)).toBe(0);
 await page.screenshot({path:info.outputPath("partner-active-job.png"),fullPage:true});expect(errors).toEqual([]);
});
test("training pet cards and requirement chips fit mobile; saved address replaces PIN entry",async({page},info)=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 const customer={customerId:"phase3-customer",customerName:"UAT Customer",phone:"9000000000"};
 const pets=[{id:"maya",name:"Maya",species:"dog",breed:"Labrador Retriever",ageYears:2,weightKg:24,profile:{}},{id:"evy",name:"Evy",species:"dog",breed:"Golden Retriever",ageYears:3,weightKg:26,profile:{}}];
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;let body:unknown={data:[]};
  if(path==="/api/identity-session")body={data:{subjectType:"customer",subjectId:customer.customerId}};
  if(path==="/api/customer-profile")body={data:customer};
  if(path==="/api/training-commercial")body={data:{packages:[],source:"ui-fixture",liveMoney:false}};
  if(path==="/api/training-trainers")body={data:{providers:[],source:"ui-fixture",liveAvailability:false}};
  if(path==="/api/customer-account")body={data:{...customer,pets,addresses:[{id:"home",line1:"42 UAT Road",city:"Bengaluru",postalCode:"560038",isDefault:true}]}};
  if(path==="/api/service-zone")body={data:{zone:{zoneId:"blr-central",serviceAvailable:true},assignment:{zoneId:"blr-central",cityId:"blr",city:"Bengaluru",pincode:"560038",area:"Indiranagar"}}};
  await route.fulfill({json:body});
 });
 await page.goto("/mobile-app?service=dog_training");
 await expect(page.getByRole("button",{name:/Maya.*Selected/})).toBeVisible();
 await expect(page.getByRole("button",{name:/Evy.*Add/})).toBeVisible();
 await expect(page.getByRole("button",{name:/Maya.*24 kg.*Selected/})).toBeVisible();
 const chips=page.getByRole("group",{name:"Training requirements"});await expect(chips).toBeVisible();
 await expect(chips.getByRole("button",{name:/Leash walking/})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 const first=await page.getByRole("button",{name:/Maya.*Selected/}).boundingBox(),second=await page.getByRole("button",{name:/Evy.*Add/}).boundingBox();
 expect(first&&second&&second.y>=first.y+first.height).toBeTruthy();
 const notes=await page.getByLabel("Home routine, behaviour and trainer notes").boundingBox(),health=await page.getByLabel("Health and safety").boundingBox();
 expect(notes&&health&&health.y>=notes.y+notes.height).toBeTruthy();
 await page.screenshot({path:info.outputPath("training-details.png"),fullPage:true});
 await page.getByRole("button",{name:"Book a Meet & Greet",exact:true}).click();
 await expect(page.getByText(/42 UAT Road/)).toBeVisible();await expect(page.getByRole("button",{name:"Change Address"})).toBeEnabled();
 await expect(page.getByLabel("PIN code",{exact:true})).toHaveCount(0);await expect(page.getByText("We’ll check trainer availability in your area before confirming.")).toBeVisible();
 expect(errors).toEqual([]);
});
