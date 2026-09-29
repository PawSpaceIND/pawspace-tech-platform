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
