import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BASE=process.env.PW_BASE_URL||"https://pawspace-staging.karthik-fce.workers.dev";
const PHONE=process.env.PW_CUSTOMER_PHONE||`8${String(Date.now()).slice(-9)}`;
const EMAIL="uat.training.customer@example.com";
const REPORT=process.env.E2E_REPORT||"test-results/uat-training-report.md";
const report=["# PawSpace staging — Training deployed acceptance","",`- Origin: ${BASE}`,`- Run: ${new Date().toISOString()}`,""];
const log=(s:string)=>{report.push(s);console.log(`[training-uat] ${s}`)};
const shot=async(page:Page,name:string)=>{try{await page.screenshot({path:`test-results/training-${name}.png`,fullPage:true});}catch{}};
const visible=async(loc:Locator,timeout=3000)=>loc.first().waitFor({state:"visible",timeout}).then(()=>true).catch(()=>false);

async function login(page:Page){
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button",{name:/account/i}).last().click();
  await page.getByPlaceholder("10-digit phone number").fill(PHONE);
  await page.getByRole("button",{name:"Send OTP"}).click();
  const sandbox=page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1]; expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name=page.getByPlaceholder("Your name (first time only)"); if(await name.isVisible().catch(()=>false))await name.fill("Uattraining Customer");
  await page.getByRole("button",{name:"Verify & continue"}).click();
  await expect.poll(()=>page.evaluate(async()=>fetch("/api/identity-session",{credentials:"include"}).then(r=>r.status))).toBe(200);
}
async function seedAccount(page:Page){
  const acct=await page.context().request.get("/api/customer-account").then(r=>r.json()) as {data:{customerId:string;addresses?:Array<{postalCode?:string|null}>;pets?:Array<{species?:string}>}};
  const id=acct.data.customerId;
  if(!(acct.data.addresses||[]).some(a=>a.postalCode==="560038")){
    const r=await page.context().request.post("/api/customer-account",{data:{action:"upsert_address",idempotencyKey:`training-addr:${id}`,address:{label:"Home",line1:"42 Indiranagar Double Road",area:"Indiranagar",city:"Bengaluru",postalCode:"560038",isDefault:true}}}); expect(r.ok()).toBeTruthy();
  }
  if(!(acct.data.pets||[]).some(p=>p.species==="dog")){
    const r=await page.context().request.post("/api/customer-account",{data:{action:"upsert_pet",idempotencyKey:`training-pet:${id}`,pet:{name:"Bruno",species:"dog",breed:"Labrador Retriever",vaccinationStatus:"not_provided"}}}); expect(r.ok()).toBeTruthy();
  }
}
async function payRazorpay(page:Page){
  const selector="iframe.razorpay-checkout-frame, iframe[src*='razorpay']";
  await page.locator(selector).first().waitFor({state:"visible",timeout:45_000});
  const f=page.frameLocator(selector).first();
  log("ℹ️ Razorpay checkout iframe mounted.");
  const contact=f.locator("#contact, input[name='contact'], input[type='tel']");
  if(await visible(contact,8000)){
    await contact.first().fill(PHONE);
    const email=f.locator("#email,input[type='email']"); if(await visible(email))await email.first().fill(EMAIL);
    const next=f.getByRole("button",{name:/continue|proceed|next/i}); if(await visible(next,5000))await next.first().click();
    await page.waitForTimeout(1500);
  }
  for(const tile of [f.locator("[data-value='card'],[data-method='card']"),f.getByRole("button",{name:/^cards?(\\s|$)/i}),f.getByRole("button",{name:/credit|debit/i}),f.getByText(/^cards?$/i)]){
    if(await visible(tile)){await tile.first().click().catch(()=>{});break;}
  }
  const add=f.getByText(/add (a )?new card/i); if(await visible(add))await add.first().click().catch(()=>{});
  const num=f.locator("#card_number,input[name='card[number]'],input[autocomplete='cc-number'],input[placeholder*='card number' i]");
  await expect(num.first()).toBeVisible({timeout:20_000}); await num.first().fill("4111111111111111");
  await f.locator("#card_expiry,input[name='card[expiry]'],input[autocomplete='cc-exp'],input[placeholder*='MM' i]").first().fill("12/29");
  await f.locator("#card_cvv,input[name='card[cvv]'],input[autocomplete='cc-csc'],input[placeholder*='CVV' i]").first().fill("123");
  const popupPromise=page.context().waitForEvent("page",{timeout:25_000}).catch(()=>null);
  const pay=()=>f.getByRole("button",{name:/^pay\\b|pay ₹|pay now|^continue$/i}).last();
  await pay().click();
  for(let i=0;i<3;i++){
    await page.waitForTimeout(1500); let filled=false;
    const holder=f.getByPlaceholder(/name on (your )?card/i).or(f.locator("#card_name,input[name='card[name]']"));
    if(await visible(holder)&&!(await holder.first().inputValue().catch(()=>""))){await holder.first().fill("UAT Training Customer");filled=true;}
    const em=f.getByPlaceholder(/email/i).or(f.locator("#email,input[type='email']"));
    if(await visible(em)&&!(await em.first().inputValue().catch(()=>""))){await em.first().fill(EMAIL);filled=true;}
    if(!filled)break; if(await visible(pay(),3000))await pay().click().catch(()=>{});
  }
  const decline=async()=>{const later=f.getByRole("button",{name:/maybe later|no thanks|not now|skip/i});if(await visible(later,5000)){await later.first().click().catch(()=>{});return true;}return false;};
  await decline();
  const popup=await popupPromise;
  const pressSuccess=async()=>{
    if(popup){const b=popup.getByRole("button",{name:/^success$/i}).first();if(await b.waitFor({state:"visible",timeout:1500}).then(()=>true).catch(()=>false)){await b.click();log("✅ Razorpay test-bank Success pressed in popup.");return true;}}
    const inCheckout=f.getByRole("button",{name:/^success$/i}).first(); if(await inCheckout.waitFor({state:"visible",timeout:1500}).then(()=>true).catch(()=>false)){await inCheckout.click();log("✅ Razorpay test-bank Success pressed in checkout iframe.");return true;}
    for(const frame of page.frames()){const b=frame.getByRole("button",{name:/^success$/i}).first();if(await b.waitFor({state:"visible",timeout:750}).then(()=>true).catch(()=>false)){await b.click();log(`✅ Razorpay test-bank Success pressed in nested frame ${frame.url()}.`);return true;}}
    return false;
  };
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){if(await pressSuccess())return;if(await decline())continue;await page.waitForTimeout(1200);}
  await shot(page,"razorpay-success-not-found");
  log("ℹ️ No visible Razorpay test-bank Success control appeared within 90 s. Continuing to the server-authoritative capture check; this does not count as payment success by itself.");
}

type CheckoutStatus={http:number;body:{data?:{status?:string}}|null};
async function status(page:Page,bookingId:string){return page.evaluate(async id=>{const r=await fetch("/api/customer-checkout",{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({action:"status",bookingId:id})});return{http:r.status,body:await r.json().catch(()=>null) as {data?:{status?:string}}|null}} ,bookingId) as Promise<CheckoutStatus>}

test("Training — captured payment, canonical trainer/programme, read-only recovery",async({page})=>{
  test.setTimeout(600_000); try{
    await login(page); log(`✅ Customer sandbox OTP login (${PHONE}).`); await seedAccount(page); log("✅ Canonical Bengaluru address + dog available.");
    await page.goto("/training");
    const meetGreet=page.getByRole("button",{name:/Trainer Meet & Greet/i}); await expect(meetGreet).toBeVisible({timeout:60_000}); await meetGreet.click();
    log("✅ Selected canonical one-session Trainer Meet & Greet to avoid multi-week staging-capacity pollution.");
    const reserve=page.getByRole("button",{name:/Reserve trainer & continue to payment/i});
    const dateInput=page.getByRole("textbox",{name:"First session date"});
    let capacityFound=false;
    for(let offset=3;offset<=21;offset+=1){
      const candidate=new Date(Date.now()+offset*86_400_000).toISOString().slice(0,10);
      await dateInput.fill(candidate);
      const loading=page.getByRole("status",{name:/Checking availability for every programme session/i});
      await loading.waitFor({state:"visible",timeout:10_000}).catch(()=>{});
      await loading.waitFor({state:"hidden",timeout:20_000}).catch(()=>{});
      await expect(page.getByText(/Repricing for your current selections/i)).toBeHidden({timeout:20_000}).catch(()=>{});
      if(await reserve.isEnabled().catch(()=>false)){capacityFound=true;log(`✅ Server-confirmed Training capacity found for ${candidate}.`);break;}
    }
    expect(capacityFound).toBe(true); await expect(reserve).toBeEnabled();
    const created=page.waitForResponse(r=>r.url().includes("/api/canonical-bookings")&&r.request().method()==="POST",{timeout:180_000}); await reserve.click();
    const cr=await created; const cb=await cr.json() as {data?:{bookingId?:string}}; expect(cr.status()).toBe(201); const bookingId=String(cb.data?.bookingId||""); expect(bookingId).not.toEqual(""); log(`✅ Canonical Training booking created: ${bookingId}.`);
    await expect(page.getByRole("heading",{name:"Review payment"})).toBeVisible({timeout:60_000});

    let failOneProgrammeRead=true;
    await page.route("**/api/training-programmes**",async route=>{if(failOneProgrammeRead&&route.request().method()==="GET"){failOneProgrammeRead=false;return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"UAT injected one-time Training programme read failure"})});}return route.continue();});
    await page.getByRole("button",{name:/^Pay securely\b/i}).click(); await payRazorpay(page); log("✅ Razorpay sandbox card flow completed.");
    let s:CheckoutStatus={http:0,body:null};for(let i=0;i<12;i++){await page.waitForTimeout(4000);s=await status(page,bookingId);if(s.body?.data?.status==="captured")break;} expect(s.body?.data?.status).toBe("captured");log(`✅ Server-authoritative payment status captured for ${bookingId}.`);
    const checkStatus=page.getByRole("button",{name:"Check payment status"}); await expect(checkStatus).toBeVisible({timeout:60_000}); await checkStatus.click();
    const recovery=page.getByRole("region",{name:"Training confirmation recovery"}); await expect(recovery).toBeVisible({timeout:60_000});
    await expect(page.getByText(/do not pay again/i)).toBeVisible(); log("✅ One-time post-payment Training read failure entered read-only recovery; payment controls did not return.");
    await recovery.getByRole("button",{name:"Refresh confirmation"}).click();
    await expect(page.getByRole("heading",{name:"Training programme confirmed"})).toBeVisible({timeout:60_000});
    await expect(page.getByText(bookingId,{exact:true})).toBeVisible();
    const trainerCard=page.locator("article").filter({hasText:"Trainer"}).first(); await expect(trainerCard).toBeVisible(); const trainerText=(await trainerCard.innerText()).trim(); expect(trainerText).not.toMatch(/—|undefined|null/i);
    const programmeCard=page.locator("article").filter({hasText:"Programme"}).first(); await expect(programmeCard).toBeVisible(); expect((await programmeCard.innerText()).trim()).toMatch(/TP-|programme|session/i);
    await expect(page.getByText(/Canonical scheduler assignment/i)).toBeVisible(); log(`✅ Recovery resolved canonical programme + assigned trainer (${trainerText.replace(/\n/g," · ")}).`);
    await shot(page,"confirmed");
  }finally{mkdirSync(dirname(REPORT),{recursive:true});writeFileSync(REPORT,report.join("\n")+"\n");}
});
