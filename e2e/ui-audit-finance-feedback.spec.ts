import {expect,test} from "@playwright/test";

// UI-only fixtures. Every API request is intercepted; no credential, payout or journal is created.
const payoutId="UI-FOCUS-PAYOUT",statementId="UI-FOCUS-STATEMENT";
const warning="RazorpayX TEST accepted the instruction, but accounting requires Finance review. Do not send another payout; recheck the original payout books.";
const providerResponse={data:{connected:true,providerPayoutId:"pout_UIFOCUS",reconciliationRequired:true,accounting:{status:"review_required"}}};
const actor={name:"UI focus fixture",email:"ui@example.test",roleCode:"founder",permissions:["*"]};
const partner={data:{statements:[],payouts:[],commission:{profiles:[],orders:[],payouts:[{id:payoutId,provider_id:"UI-PROVIDER",amount:500,status:"queued_sandbox",due_at:Date.UTC(2026,8,1)}],policy:{}},payoutAccounting:[{local_payout_id:payoutId,status:"review_required",reason:"Synthetic review"}]}};
const contractor={data:{periodCode:"2026-08",defaults:{tdsSection:"194J",tdsRatePct:10,tdsSections:["194J","194C"],maxTdsRatePct:20,petrolRule:"none"},profiles:[],fullTimeWithoutProfile:[],events:[],payoutReadiness:{ready:true,problems:[]},payouts:[{id:payoutId,statementId,amount:500,status:"approved_sandbox",providerReference:null}],payoutAccounting:[{local_payout_id:payoutId,status:"review_required",reason:"Synthetic review"}],statements:[{id:statementId,providerId:"UI-CONTRACTOR",periodCode:"2026-08",serviceCode:"grooming",status:"approved",daysInMonth:31,activeDays:31,fixedFee:500,incentive:0,petrol:0,tdsSection:"194J",tdsRatePct:0,tdsAmount:0,netPayable:500,lines:[],blockers:[],approvedBy:"checker@example.test"}]}};
for(const prefix of ["","/v2"])for(const width of [390,1440])for(const kind of ["partners","contractors"])for(const refreshFails of [false,true]) {
 test(`payout outcome is focused and in viewport ${prefix||"V1"}/${kind}/${width}/refresh-${refreshFails?"failed":"ok"}`,async({context,page,baseURL},info)=>{
  const origin=new URL(baseURL!).origin;
  expect(["127.0.0.1","localhost"]).toContain(new URL(origin).hostname);
  const requests:Array<{path:string;body:unknown}>=[],unexpected:string[]=[],errors:string[]=[];
  let sent=false;
  page.on("pageerror",error=>errors.push(error.message));
  await context.route("**/*",async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!==origin)return route.abort("blockedbyclient");
   if(!["GET","HEAD"].includes(request.method())) {
    requests.push({path:url.pathname,body:request.postDataJSON()});
    if(url.pathname!=="/api/razorpayx-test-dispatch"){unexpected.push(url.pathname);return route.abort("blockedbyclient");}
    sent=true;return route.fulfill({status:202,json:providerResponse});
   }
   if(!url.pathname.startsWith("/api/"))return route.continue();
   if(url.pathname==="/api/team-overview")return route.fulfill({json:{data:{actor,today:"2026-09-29",commandStrip:{},workspaces:{}}}});
   if(url.pathname==="/api/partner-finance"||url.pathname==="/api/contractor-pay") {
    if(sent&&refreshFails)return route.fulfill({status:503,json:{error:"Synthetic refresh unavailable"}});
    return route.fulfill({json:url.pathname==="/api/partner-finance"?partner:contractor});
   }
   return route.fulfill({status:503,json:{error:"Unconfigured synthetic read"}});
  });
  await page.setViewportSize({width,height:1000});
  await page.goto(`${prefix}/team/finance/${kind}`,{waitUntil:"domcontentloaded"});
  const send=page.getByRole("button",{name:"Send TEST payout",exact:true});await expect(send).toBeEnabled();
  const consent=page.getByRole("button",{name:"Essential only",exact:true});if(await consent.isVisible())await consent.click();
  const outcome=page.getByRole("group",{name:"Payout action outcome",exact:true});
  await expect(outcome).not.toBeFocused();
  await send.click();
  await expect(page.getByText(warning,{exact:true}).first()).toBeVisible();
  if(refreshFails)await expect(outcome.getByRole("alert")).toContainText("Synthetic refresh unavailable");
  // No test-side scroll/focus call: the actual component must bring the result to the operator.
  await expect(outcome).toBeFocused();
  await expect.poll(()=>page.getByText(warning,{exact:true}).first().evaluate(el=>{
   const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;
  })).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  expect(requests).toEqual([{path:"/api/razorpayx-test-dispatch",body:{payoutId}}]);
  expect(unexpected).toEqual([]);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath("payout-outcome.png")});
 });
}

// Review regressions: error-only outcomes and unrelated actions must not share a focus trigger.
import type {BrowserContext,Page} from "@playwright/test";
type ReviewScenario="http"|"network"|"initial"|"profile"|"approve"|"prepare"|"reconcile"|"release"|"release-error";
async function reviewFixture(context:BrowserContext,page:Page,baseURL:string,scenario:ReviewScenario){
 const origin=new URL(baseURL).origin;expect(["127.0.0.1","localhost"]).toContain(new URL(origin).hostname);
 const requests:Array<{path:string;body:Record<string,unknown>}>=[],unexpected:string[]=[];
 const c=structuredClone(contractor),p:{data:Record<string,unknown>}=structuredClone(partner);
 if(scenario==="approve")c.data.statements[0].status="ready";
 if(scenario==="prepare")c.data.payouts=[];
 if(scenario.startsWith("release"))p.data.payoutQueue={holdDays:7,queue:[{booking_id:"UI-FOCUS-BOOK",provider_id:"UI-PROVIDER",service_code:"grooming",due_at:Date.UTC(2026,8,1),payable_amount:500,refund_adjustment:0,tds_amount:0,recovery_deduction:0,amount:500,status:"awaiting_release",statusLabel:"Ready",blockedLabel:null,releasable:true}],upcoming:[],recoveries:[],reconciliation:{ok:true,checked:1,mismatches:[]},totals:{awaitingRelease:1,awaitingAmount:500,releasable:1,openRecoveryAmount:0}};
 await page.addInitScript(()=>{
  const w=window as unknown as {payoutFocusCount:number};w.payoutFocusCount=0;
  document.addEventListener("focusin",event=>{if(event.target instanceof Element&&event.target.getAttribute("aria-label")==="Payout action outcome")w.payoutFocusCount++;});
 });
 await context.route("**/*",async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin)return route.abort("blockedbyclient");
  if(!["GET","HEAD"].includes(request.method())){
   const body=request.postDataJSON() as Record<string,unknown>;requests.push({path:url.pathname,body});
   if(url.pathname==="/api/razorpayx-test-dispatch")return scenario==="network"?route.abort("failed"):route.fulfill({status:409,json:{error:"Synthetic dispatch refused; review original instruction"}});
   if(url.pathname==="/api/partner-finance"&&body.action==="release_provider_payout"&&scenario.startsWith("release"))return scenario==="release-error"?route.fulfill({status:409,json:{error:"Synthetic payout release refused"}}):route.fulfill({json:{data:{released:[{bookingId:"UI-FOCUS-BOOK",amount:500,dispatch:providerResponse.data}],refused:[]}}});
   const allowed=({profile:"save_profile",approve:"approve_statement",prepare:"prepare_payout",reconcile:"reconcile_payout"} as Record<string,string>)[scenario];
   if(url.pathname==="/api/contractor-pay"&&body.action===allowed)return route.fulfill({json:{data:{status:"review_required",reconciliationRequired:true}}});
   unexpected.push(url.pathname);return route.abort("blockedbyclient");
  }
  if(!url.pathname.startsWith("/api/"))return route.continue();
  if(url.pathname==="/api/team-overview")return route.fulfill({json:{data:{actor,today:"2026-09-29",commandStrip:{},workspaces:{}}}});
  if(url.pathname==="/api/partner-finance"||url.pathname==="/api/contractor-pay")return scenario==="initial"?route.fulfill({status:503,json:{error:"Synthetic initial read unavailable"}}):route.fulfill({json:url.pathname==="/api/partner-finance"?p:c});
  return route.fulfill({status:503,json:{error:"Unconfigured synthetic read"}});
 });
 return {requests,unexpected};
}
async function openReview(page:Page,route:string){
 await page.goto(route,{waitUntil:"domcontentloaded"});await expect(page.locator("h1")).toBeVisible();
 const consent=page.getByRole("button",{name:"Essential only",exact:true});if(await consent.isVisible())await consent.click();
 return page.getByRole("group",{name:"Payout action outcome",exact:true});
}
for(const prefix of ["","/v2"])for(const width of [390,1440])for(const kind of ["partners","contractors"])for(const scenario of ["http","network"] as const){
 test(`review error-only payout ${prefix||"V1"}/${kind}/${width}/${scenario}`,async({context,page,baseURL},info)=>{
  const {requests,unexpected}=await reviewFixture(context,page,baseURL!,scenario);await page.setViewportSize({width,height:1000});
  const outcome=await openReview(page,`${prefix}/team/finance/${kind}`),send=page.getByRole("button",{name:"Send TEST payout",exact:true});
  for(let attempt=1;attempt<=2;attempt++){
   await send.click();await expect(outcome.getByRole("alert")).toBeVisible();
   await expect(outcome).toBeFocused();
   await expect.poll(()=>outcome.getByRole("alert").evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
   expect(await page.evaluate(()=>(window as unknown as {payoutFocusCount:number}).payoutFocusCount)).toBe(attempt);
   expect(requests).toEqual(Array.from({length:attempt},()=>({path:"/api/razorpayx-test-dispatch",body:{payoutId}})));
  }
  expect(unexpected).toEqual([]);await page.screenshot({path:info.outputPath("error-outcome.png")});
 });
}
for(const prefix of ["","/v2"])for(const width of [390,1440])for(const kind of ["partners","contractors"]){
 test(`review initial read cannot steal focus ${prefix||"V1"}/${kind}/${width}`,async({context,page,baseURL})=>{
  const {requests}=await reviewFixture(context,page,baseURL!,"initial");await page.setViewportSize({width,height:1000});
  const outcome=await openReview(page,`${prefix}/team/finance/${kind}`);
  await expect(outcome.getByRole("alert")).toContainText("Synthetic initial read unavailable");
  expect(await page.evaluate(()=>(window as unknown as {payoutFocusCount:number}).payoutFocusCount)).toBe(0);
  await expect(outcome).not.toBeFocused();expect(requests).toEqual([]);
 });
}
for(const prefix of ["","/v2"])for(const width of [390,1440])for(const scenario of ["profile","approve","prepare","reconcile"] as const){
 test(`review unrelated action keeps focus ${prefix||"V1"}/contractors/${width}/${scenario}`,async({context,page,baseURL})=>{
  const {requests,unexpected}=await reviewFixture(context,page,baseURL!,scenario);await page.setViewportSize({width,height:1000});
  const outcome=await openReview(page,`${prefix}/team/finance/contractors`);
  if(scenario==="profile"){
   // Wait for the client-loaded record before filling controlled inputs; SSR fields can hydrate later.
   await expect(page.getByRole("button",{name:"Send TEST payout",exact:true})).toBeEnabled();
   const consent=page.getByRole("button",{name:"Essential only",exact:true});if(await consent.isVisible())await consent.click();
   await page.getByPlaceholder("Provider ID",{exact:true}).first().fill("UI-CONTRACTOR");
   await page.getByPlaceholder("Monthly fixed fee ₹",{exact:true}).fill("500");
   await page.getByLabel("Starts on",{exact:true}).fill("2026-10-01");
   await page.getByPlaceholder("Reason for this pay change (at least 8 characters)",{exact:true}).fill("Synthetic profile review");
   await expect(page.getByPlaceholder("Provider ID",{exact:true}).first()).toHaveValue("UI-CONTRACTOR");
   await expect(page.getByPlaceholder("Monthly fixed fee ₹",{exact:true})).toHaveValue("500");
   await expect(page.getByLabel("Starts on",{exact:true})).toHaveValue("2026-10-01");
   await page.getByRole("button",{name:"Save pay profile",exact:true}).click();
   await expect(outcome).toContainText("Pay profile saved for UI-CONTRACTOR");
  }else if(scenario==="approve"){
   await page.getByRole("button",{name:"Approve",exact:true}).click();
   await expect(outcome).toContainText("Approved UI-CONTRACTOR for 2026-08");
  }else if(scenario==="prepare"){
   await page.getByRole("button",{name:"Prepare TEST payout",exact:true}).click();
   await expect(outcome).toContainText("TEST instruction prepared. No money has been sent.");
  }else{
   await page.getByRole("button",{name:"Recheck payout books",exact:true}).click();
   await expect(outcome).toContainText("Recorded payout books rechecked; no new transfer requested.");
  }
  expect(await page.evaluate(()=>(window as unknown as {payoutFocusCount:number}).payoutFocusCount)).toBe(0);
  await expect(outcome).not.toBeFocused();
  expect(requests).toHaveLength(1);expect(requests[0].path).toBe("/api/contractor-pay");
  expect(requests[0].body.action).toBe(({profile:"save_profile",approve:"approve_statement",prepare:"prepare_payout",reconcile:"reconcile_payout"})[scenario]);
  expect(unexpected).toEqual([]);
 });
}
for(const prefix of ["","/v2"])for(const width of [390,1440])for(const scenario of ["release","release-error"] as const){
 test(`review explicit payout release reveals outcome ${prefix||"V1"}/${width}/${scenario}`,async({context,page,baseURL})=>{
  const {requests,unexpected}=await reviewFixture(context,page,baseURL!,scenario);await page.setViewportSize({width,height:1000});
  const outcome=await openReview(page,`${prefix}/team/finance/partners`);
  await page.getByRole("button",{name:"Release payout",exact:true}).click();
  await expect(outcome).toContainText(scenario==="release-error"?"Synthetic payout release refused":warning);
  await expect(outcome).toBeFocused();
  await expect.poll(()=>outcome.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
  expect(requests).toEqual([{path:"/api/partner-finance",body:{action:"release_provider_payout",bookingIds:["UI-FOCUS-BOOK"]}}]);
  expect(unexpected).toEqual([]);
 });
}
