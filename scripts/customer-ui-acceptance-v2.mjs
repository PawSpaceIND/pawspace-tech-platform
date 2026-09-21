import fs from "node:fs";
import { chromium } from "playwright";

const readArg=(name,fallback="")=>{const item=process.argv.find(value=>value.startsWith(`--${name}=`));return item?item.slice(name.length+3):fallback;};
const BASE=readArg("base",process.env.PREVIEW_URL||"").replace(/\/$/,"");
const OUT=readArg("json","customer-ui-acceptance-report.json");
const PHONE=readArg("phone","9000000911"),PIN="560038",PET="UI Test Bruno",CUSTOMER="UI Acceptance Customer",ADDRESS="42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru";
const TIMEOUT=Number(readArg("timeout","18000"));
const SERVER_TIMEOUT=Number(readArg("server-timeout","60000"));
if(!BASE)throw new Error("--base or PREVIEW_URL is required");

const report={generatedAt:new Date().toISOString(),base:BASE,pincode:PIN,cases:[],failures:[],sittingProfileRateEvidence:[],sittingDiscoveryRetries:0};
const persist=()=>{report.summary={total:report.cases.length,passed:report.cases.filter(x=>x.ok).length,failed:report.cases.filter(x=>!x.ok).length};fs.writeFileSync(OUT,`${JSON.stringify(report,null,2)}\n`);};
const die=(message)=>{throw new Error(message);};
const wait=async(page,ms=350)=>{await page.waitForLoadState("domcontentloaded",{timeout:TIMEOUT}).catch(()=>undefined);await page.waitForTimeout(ms);};
async function runCase(name,fn){const started=Date.now();try{const detail=await fn();report.cases.push({name,ok:true,ms:Date.now()-started,detail:detail||"passed"});console.log(`PASS ${name}${detail?` — ${detail}`:""}`);}catch(error){const detail=error instanceof Error?error.message:String(error);report.cases.push({name,ok:false,ms:Date.now()-started,detail});report.failures.push({name,detail});console.error(`FAIL ${name} — ${detail}`);}finally{persist();}}
async function bottomNav(page){const nav=page.getByRole("navigation",{name:"Customer navigation"});await nav.waitFor({state:"visible",timeout:TIMEOUT});return nav;}
async function gotoApp(page){const response=await page.goto(`${BASE}/mobile-app`,{waitUntil:"domcontentloaded",timeout:TIMEOUT});if(!response||response.status()>=500)die(`mobile app HTTP ${response?.status()??0}`);await bottomNav(page);}
async function nav(page,label){const buttons=(await bottomNav(page)).getByRole("button").filter({hasText:new RegExp(label,"i")});const count=await buttons.count();if(!count)die(`bottom navigation ${label} not found`);await buttons.last().click();await wait(page,220);}
async function text(page,value,timeout=TIMEOUT){await page.getByText(value,{exact:false}).first().waitFor({state:"visible",timeout});}
async function ready(page,button,label,timeout=TIMEOUT){
 await button.waitFor({state:"visible",timeout});
 try{await button.click({trial:true,timeout});}
 catch(error){const alerts=(await page.getByRole("alert").allTextContents()).map(value=>value.replace(/\s+/g," ").trim()).filter(Boolean);die(`${label} did not become available${alerts.length?`: ${alerts.join(" | ")}`:""} (${error instanceof Error?error.message.split("\n")[0]:String(error)})`);}
 return button;
}
async function enabled(locator,label,timeout=SERVER_TIMEOUT){
 await locator.waitFor({state:"visible",timeout});
 const deadline=Date.now()+timeout;
 while(!(await locator.isEnabled().catch(()=>false))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,120));
 if(!(await locator.isEnabled().catch(()=>false)))die(`${label} did not become enabled within ${timeout}ms`);
 return locator;
}
async function petsReady(page){for(const label of["Loading your pets…","Loading pets…"]){const loading=page.getByText(label,{exact:true}).first();if(await loading.count())await loading.waitFor({state:"hidden",timeout:SERVER_TIMEOUT});}}
const petButton=(page)=>page.getByRole("button",{name:new RegExp(PET.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i")}).first();
async function ensurePetProgress(page,continueButton,label){
 await petsReady(page);
 if(await continueButton.count()){
  try{await continueButton.click({trial:true,timeout:1200});return continueButton;}catch{}
 }
 const pet=petButton(page);await pet.waitFor({state:"visible",timeout:SERVER_TIMEOUT});await pet.click();return ready(page,continueButton,label,SERVER_TIMEOUT);
}
async function transition(page,button,marker,label,timeout=TIMEOUT){await ready(page,button,label,timeout);await button.click({timeout});await marker.waitFor({state:"visible",timeout});}

async function login(page,context){
 await gotoApp(page);const session=await context.request.get(`${BASE}/api/identity-session`);if(session.ok()){const body=await session.json().catch(()=>({}));if(body?.data?.subjectType==="customer")return`existing customer ${body.data.subjectId}`;}
 await nav(page,"Account");await page.getByPlaceholder("10-digit phone number").fill(PHONE);
 const requested=page.waitForResponse(response=>response.url().includes("/api/customer-otp")&&response.request().method()==="POST"&&response.request().postData()?.includes('"action":"request"'),{timeout:SERVER_TIMEOUT});
 await page.getByRole("button",{name:"Send OTP"}).click();
 const otpResponse=await requested,otpBody=await otpResponse.json().catch(()=>({}));
 if(!otpResponse.ok()||!otpBody?.data?.sandboxCode)die(`sandbox OTP request failed (HTTP ${otpResponse.status()})`);
 const sandbox=page.getByText(/Sandbox code \(no real SMS yet\):/i);await sandbox.waitFor({state:"visible",timeout:SERVER_TIMEOUT});const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];if(!code)die("sandbox OTP not rendered");
 if(code!==String(otpBody.data.sandboxCode))die("rendered sandbox OTP did not match the server challenge");
 const codeInput=page.getByPlaceholder("6-digit code");await codeInput.fill(code);await page.getByPlaceholder("Your name (first time only)").fill(CUSTOMER);await page.getByRole("button",{name:"Verify & continue"}).click();await codeInput.waitFor({state:"hidden",timeout:TIMEOUT});
 const verified=await context.request.get(`${BASE}/api/identity-session`),body=await verified.json().catch(()=>({}));if(!verified.ok()||body?.data?.subjectType!=="customer")die(`OTP did not establish customer session (HTTP ${verified.status()})`);return`real OTP -> ${body.data.subjectId}`;
}

async function ensurePet(page){
 await gotoApp(page);await nav(page,"My Pets");await petsReady(page);if(await page.getByText(PET,{exact:true}).count())return`${PET} reused`;
 const add=page.getByRole("button",{name:/Add pet/i}).first();await add.waitFor({state:"visible",timeout:TIMEOUT});await add.click();await page.getByPlaceholder("Pet name").fill(PET);
 await page.getByLabel("Breed").selectOption({index:1});await page.getByLabel("Age").selectOption({index:1});await page.getByLabel("Weight").selectOption({index:1});await page.getByLabel("Temperament").selectOption({index:1});await page.getByLabel("Vaccinated?").selectOption("yes");
 const gender=page.getByLabel("Gender (optional)");if(await gender.count())await gender.selectOption({index:1});await page.getByRole("button",{name:"Add pet",exact:true}).click();await page.getByText(PET,{exact:true}).first().waitFor({state:"visible",timeout:TIMEOUT});return`${PET} created through UI`;
}

const care=(page)=>page.getByRole("region",{name:"Care services"});
const serviceCard=(page,name)=>care(page).locator("article").filter({hasText:new RegExp(name,"i")});
async function serviceAction(page,name){const cards=serviceCard(page,name),count=await cards.count();if(count!==1)die(`${name} discovery card count=${count}`);const action=cards.getByRole("button");const actions=await action.count();if(actions!==1)die(`${name} discovery action count=${actions}`);return action;}
async function goHome(page){await gotoApp(page);await nav(page,"Home");await care(page).waitFor({state:"visible",timeout:TIMEOUT});const openDialog=page.getByRole("dialog",{name:"Choose your service area"});if(await openDialog.isVisible().catch(()=>false)){const close=openDialog.getByRole("button",{name:"Close location"});if(await close.count())await close.click();await openDialog.waitFor({state:"hidden",timeout:TIMEOUT});}}
async function openService(page,name){await goHome(page);const action=await serviceAction(page,name);if(await action.isDisabled())die(`${name} discovery card disabled`);await action.click();await wait(page,450);}

async function observeFinal(page,button,target,safePosts=[],timeout=SERVER_TIMEOUT){
 const seen=[],unexpected=[];const handler=async(route)=>{const req=route.request(),method=req.method(),path=new URL(req.url()).pathname,label=`${method} ${path}`;if(!["POST","PUT","PATCH","DELETE"].includes(method)){await route.continue();return;}if(target.test(label)){seen.push(label);await route.abort("blockedbyclient");return;}if(safePosts.some(pattern=>pattern.test(label))){await route.continue();return;}unexpected.push(label);await route.abort("blockedbyclient");};
 await page.route("**/api/**",handler);try{await button.click({timeout:TIMEOUT});const deadline=Date.now()+timeout;while(!seen.length&&!unexpected.length&&Date.now()<deadline)await page.waitForTimeout(100);}finally{await page.unroute("**/api/**",handler);}if(unexpected.length)die(`unexpected committing request(s) before target: ${unexpected.join(", ")}`);if(!seen.length)die(`expected final mutation ${target} not attempted within ${timeout}ms`);return seen.join(", ");
}

async function homeControls(page){
 await goHome(page);const cards=care(page).locator("article"),cardCount=await cards.count();if(cardCount!==8)die(`service cards=${cardCount}, expected 8`);for(const name of["Grooming","Training","Boarding","Pet Sitting","Pet Taxi","Dog Walking","Fresh Food","Relocation"]){const action=await serviceAction(page,name);if(await action.isDisabled())die(`${name} disabled`);}
 const location=page.getByRole("button",{name:"Choose your service location"}).last();await location.click();const sheet=page.getByRole("dialog",{name:"Choose your service area"});await sheet.waitFor({state:"visible",timeout:TIMEOUT});const fallback=sheet.getByText("Can’t find your area? Use a PIN code",{exact:true});await fallback.click();await sheet.getByPlaceholder("6-digit PIN code").fill(PIN);await sheet.getByRole("button",{name:"Check area",exact:true}).click();const continueButton=sheet.getByRole("button",{name:/Continue in Bengaluru/i});await ready(page,continueButton,"Home service-area coverage",SERVER_TIMEOUT);await continueButton.click();await sheet.waitFor({state:"hidden",timeout:TIMEOUT});await location.getByText("Indiranagar",{exact:false}).waitFor({state:"visible",timeout:TIMEOUT});
 const search=page.getByLabel("Search PawSpace services");await search.fill("food");await serviceCard(page,"Fresh Food").waitFor({state:"visible",timeout:TIMEOUT});if(await serviceCard(page,"Grooming").count())die("search failed to filter service cards");await search.fill("");
 await page.getByRole("button",{name:/View your bookings/i}).click();await wait(page,200);await nav(page,"Home");await page.getByRole("button",{name:"Open pet profiles"}).click();await text(page,"Your pets");return"8 services + search + location + bookings + pets";
}

async function grooming(page){await openService(page,"Grooming");const next=page.getByRole("button",{name:/Choose a package/i});await ensurePetProgress(page,next,"Grooming package progression");await next.click();for(const label of["Essential Bath","Bath & Basic","Complete Makeover","Just Trim"])await text(page,label);return"pet -> package stage + legacy packages";}

async function training(page){
 await openService(page,"Training");await text(page,"Build better days together.");await petsReady(page);const dog=petButton(page);await dog.waitFor({state:"visible",timeout:SERVER_TIMEOUT});if(await dog.getAttribute("aria-pressed")!=="true")await dog.click();const proceed=page.getByRole("button",{name:"Book a Meet & Greet",exact:true}).first();await ready(page,proceed,"Training assessment progression",SERVER_TIMEOUT);await proceed.click();await text(page,"All training programmes",SERVER_TIMEOUT);const chooseTrainer=page.getByRole("button",{name:"Choose trainer",exact:true});await ready(page,chooseTrainer,"Training programme progression",SERVER_TIMEOUT);await chooseTrainer.click();await text(page,"Your trainer matches",SERVER_TIMEOUT);const careLocation=page.getByRole("region",{name:"Care location"});await careLocation.waitFor({state:"visible",timeout:SERVER_TIMEOUT});const manual=careLocation.getByLabel("Complete doorstep address",{exact:true});if(await manual.count()){await address(page);}const useAddress=careLocation.getByRole("button",{name:"Use this address",exact:true});if(await useAddress.isVisible().catch(()=>false)){await ready(page,useAddress,"Training address coverage",SERVER_TIMEOUT);await useAddress.click();}const calendar=page.getByRole("button",{name:"Build session calendar"});await ready(page,calendar,"Training trainer match",SERVER_TIMEOUT);await calendar.click();await text(page,"Plan your sessions");await page.getByRole("button",{name:"Review & pay"}).click();await text(page,"Review your programme");const final=page.getByRole("button",{name:/Pay .* & request trainer approval|Refreshing server quote/i});await ready(page,final,"Training server quote",SERVER_TIMEOUT);const seen=await observeFinal(page,final,/POST \/api\/uat-scheduling/,[/POST \/api\/training-commercial/]);return`5 stages + final scheduler wiring (${seen})`;
}

async function address(page){const line1=await enabled(page.getByLabel(/Address Line 1/),"Service address",SERVER_TIMEOUT);await line1.fill(ADDRESS);const verify=await enabled(page.getByRole("button",{name:"Verify service address",exact:true}),"Service address verification",SERVER_TIMEOUT);await verify.click();await page.getByText("Verified service doorstep",{exact:true}).waitFor({state:"visible",timeout:SERVER_TIMEOUT});}
async function sittingRates(page){
 const rateButtons=page.locator("button").filter({hasText:"/ night"}),first=rateButtons.first(),retry=page.getByRole("button",{name:"Retry sitter search",exact:true}),status=page.getByRole("status").filter({hasText:/Checking sitter availability/i});
 const deadline=Date.now()+SERVER_TIMEOUT*2;let attempts=0,lastAlerts=[];
 while(Date.now()<deadline){
  if(await first.isVisible().catch(()=>false))break;
  lastAlerts=(await page.getByRole("alert").allTextContents()).map(value=>value.replace(/\s+/g," ").trim()).filter(Boolean);
  if(await retry.isVisible().catch(()=>false)&&attempts<2){attempts+=1;report.sittingDiscoveryRetries+=1;await retry.click();await status.waitFor({state:"visible",timeout:3000}).catch(()=>undefined);await status.waitFor({state:"hidden",timeout:SERVER_TIMEOUT}).catch(()=>undefined);continue;}
  await page.waitForTimeout(200);
 }
 if(!await first.isVisible().catch(()=>false))die(`Sitting profile rates unavailable after ${attempts} governed retr${attempts===1?"y":"ies"}${lastAlerts.length?`: ${lastAlerts.join(" | ")}`:""}`);
 const rates=await rateButtons.allTextContents();report.sittingProfileRateEvidence=rates.slice(0,3).map(x=>x.replace(/\s+/g," ").trim());if(!rates.length)die("Sitting profile rates not rendered for checkout-vs-card review");return rates;
}
async function resolveStayLocation(page,available,name){
 const region=page.getByRole("region",{name:"Care location"});await region.waitFor({state:"visible",timeout:SERVER_TIMEOUT});const manual=region.getByLabel("Complete doorstep address",{exact:true}),change=region.getByRole("button",{name:"Change Address",exact:true}),retry=region.getByRole("button",{name:"Retry address check",exact:true});
 const deadline=Date.now()+SERVER_TIMEOUT;let retryUsed=false;
 while(Date.now()<deadline){
  if(await available.isVisible().catch(()=>false)&&await available.isEnabled().catch(()=>false))return;
  if(await manual.isVisible().catch(()=>false)){await address(page);await ready(page,available,`${name} manual-address trip details`,SERVER_TIMEOUT);return;}
  if(await change.isVisible().catch(()=>false)&&await change.isEnabled().catch(()=>false)){await change.click();await manual.waitFor({state:"visible",timeout:TIMEOUT});await address(page);await ready(page,available,`${name} manual-address trip details`,SERVER_TIMEOUT);return;}
  if(!retryUsed&&await retry.isVisible().catch(()=>false)){retryUsed=true;await retry.click();}
  await page.waitForTimeout(150);
 }
 const alerts=(await page.getByRole("alert").allTextContents()).map(value=>value.replace(/\s+/g," ").trim()).filter(Boolean);die(`${name} address resolution did not become usable${alerts.length?`: ${alerts.join(" | ")}`:""}`);
}
async function stay(page,sitting){
 const name=sitting?"Pet Sitting":"Boarding";await openService(page,name);await text(page,sitting?"Care at home, around their routine.":"A stay that feels like home.");await petsReady(page);const available=page.getByRole("button",{name:sitting?/See available sitters/i:/See available homes/i});const pet=petButton(page);if(await pet.count())await pet.click();await resolveStayLocation(page,available,name);await available.click();await text(page,sitting?"Choose your sitter":"Choose your host");if(sitting)await sittingRates(page);
 const next=page.getByRole("button",{name:/Continue with|Choose an available host/i});await ready(page,next,`${name} caregiver match`,SERVER_TIMEOUT);await next.click();await text(page,"Build the Care Card");await page.getByLabel("Vet contact").fill("UAT Vet contact");await page.getByLabel("Emergency contact").fill("UAT emergency contact");if(sitting)await page.getByLabel("Home access instructions").fill("UAT home access instructions");await page.getByRole("button",{name:"Review protected booking"}).click();await text(page,"Review and confirm");await page.getByRole("checkbox",{name:/I agree to care/i}).check();const final=page.getByRole("button",{name:/create canonical stay|request final partner approval/i});await ready(page,final,`${name} server quote`,SERVER_TIMEOUT);const seen=await observeFinal(page,final,sitting?/POST \/api\/(sitting-payment|uat-scheduling|canonical-bookings)/:/POST \/api\/uat-scheduling/,[/POST \/api\/(boarding|sitting)-commercial/,/POST \/api\/(boarding|sitting).*quote/,/POST \/api\/live-price-quote/]);return`4 stages + caregiver + final wiring (${seen})`;
}

async function walking(page){
 await openService(page,"Dog Walking");await text(page,"Choose a walk package");const schedule=page.getByRole("button",{name:"Plan the schedule"});await ready(page,schedule,"Walking catalogue",SERVER_TIMEOUT);await schedule.click();await page.getByRole("button",{name:"Choose your dog"}).click();await text(page,"Who's walking?");const review=page.getByRole("button",{name:"Review & confirm"});await ensurePetProgress(page,review,"Walking pet selection");await review.click();await text(page,"Review your walks");await address(page);const final=page.getByRole("button",{name:/Continue to payment|Refreshing server quote/i});await ready(page,final,"Walking server quote",SERVER_TIMEOUT);await final.click();await text(page,"Review payment");const confirm=page.getByRole("button",{name:"Accept pay-after-service & confirm booking"});await ready(page,confirm,"Walking payment review",SERVER_TIMEOUT);const seen=await observeFinal(page,confirm,/POST \/api\/uat-scheduling/,[/POST \/api\/walking-commercial/]);return`4 stages + payment review + scheduler wiring (${seen})`;
}

async function taxi(page){
 await openService(page,"Pet Taxi");await text(page,"Who is travelling?");await petsReady(page);const trip=page.getByRole("button",{name:"Continue to trip details"});await ready(page,trip,"Taxi travellers",SERVER_TIMEOUT);await trip.click();const pickupLabel=page.getByLabel("Pickup address",{exact:true}),dropLabel=page.getByLabel("Drop address / Point 1",{exact:true});const enhanced=page.locator('input[list="pawspace-bengaluru-addresses"]');const pickup=await pickupLabel.count()?pickupLabel:enhanced.nth(0),drop=await dropLabel.count()?dropLabel:enhanced.nth(1);await pickup.waitFor({state:"visible",timeout:SERVER_TIMEOUT});await pickup.fill("Indiranagar, Bengaluru");await drop.fill("Whitefield Vet Clinic, Bengaluru");const review=page.getByRole("button",{name:"Review ride requirements"});await ready(page,review,"Taxi locations");await review.click();await text(page,"Ready for a live route quote?");const calculate=page.getByRole("button",{name:/Calculate Citroën & XUV fares/i});await ready(page,calculate,"Taxi route quote",SERVER_TIMEOUT);const quoteResponse=page.waitForResponse(response=>response.url().includes("/api/taxi-commercial")&&response.request().method()==="POST",{timeout:SERVER_TIMEOUT});await calculate.click();const taxiResponse=await quoteResponse,taxiBody=await taxiResponse.json().catch(()=>({}));if(!taxiResponse.ok())die(`Taxi route quote failed (HTTP ${taxiResponse.status()}): ${taxiBody?.error||"unknown error"}`);await text(page,"Choose your car",SERVER_TIMEOUT);await page.getByPlaceholder("6-digit service PIN").fill(PIN);const reserve=page.getByRole("button",{name:/Reserve · pay .* next/i});await ready(page,reserve,"Taxi vehicle quote",SERVER_TIMEOUT);const seen=await observeFinal(page,reserve,/POST \/api\/uat-scheduling/);return`5 stages + live route quote + scheduler wiring (${seen})`;
}

async function food(page){
 await openService(page,"Fresh Food");await text(page,"Fresh food for your pets");await page.getByPlaceholder("Enter six-digit PIN code").first().fill(PIN);await page.getByRole("button",{name:"Check service area & load catalogue"}).click();await text(page,"Delivery coverage confirmed",SERVER_TIMEOUT);const add=page.getByRole("button",{name:"Add",exact:true}).first();await add.waitFor({state:"visible",timeout:SERVER_TIMEOUT});await add.click();const cart=page.getByRole("button",{name:/Review cart/i});await ready(page,cart,"Food cart",SERVER_TIMEOUT);await cart.click();await text(page,"Your cart");const choosePlan=page.getByRole("button",{name:"Choose delivery plan"});await transition(page,choosePlan,page.getByText("One-time or repeat?",{exact:true}),"Food delivery-plan transition");const delivery=page.getByRole("button",{name:"Delivery details"});await transition(page,delivery,page.getByText("Where and when?",{exact:true}),"Food delivery-details transition");const deliveryAddress=page.getByLabel("Delivery address");await deliveryAddress.waitFor({state:"visible",timeout:TIMEOUT});await deliveryAddress.fill(ADDRESS);const review=page.getByRole("button",{name:"Review with server quote"});await ready(page,review,"Food delivery coverage",SERVER_TIMEOUT);await review.click();await text(page,"Review and confirm",SERVER_TIMEOUT);const final=page.getByRole("button",{name:/Confirm food order|Confirm order \+ repeat plan/i});await ready(page,final,"Food server quote",SERVER_TIMEOUT);await final.click();await text(page,"Review payment");const confirm=page.getByRole("button",{name:"Accept pay-after-service & confirm booking"});await ready(page,confirm,"Food payment review",SERVER_TIMEOUT);const seen=await observeFinal(page,confirm,/POST \/api\/food-orders/);return`5 stages + catalogue + quote + payment review + order wiring (${seen})`;
}

async function relocation(page){await openService(page,"Relocation");await text(page,"PET RELOCATION · ENQUIRY");await page.getByLabel("Email").fill("ui-acceptance@pawspace.test");await page.getByLabel("Pickup location").fill("Koramangala, Bengaluru");await page.getByLabel("Drop location").fill("Indiranagar, Bengaluru");const seen=await observeFinal(page,page.getByRole("button",{name:"Request relocation plan & quote"}),/POST \/api\/relocation-enquiry/);return`enquiry-only wiring (${seen}); no payment endpoint`;}

async function main(){const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844}}),pageErrors=[];
 const withPage=async(fn)=>{const page=await context.newPage();page.on("pageerror",error=>pageErrors.push(String(error.message).slice(0,240)));try{return await fn(page);}finally{await page.close().catch(()=>undefined);}};
 try{
  await runCase("real customer OTP/session",()=>withPage(page=>login(page,context)));
  await runCase("customer pet profile",()=>withPage(page=>ensurePet(page)));
  await runCase("premium Home and controls",()=>withPage(page=>homeControls(page)));
  await runCase("Grooming journey",()=>withPage(page=>grooming(page)));
  await runCase("Training journey",()=>withPage(page=>training(page)));
  await runCase("Boarding journey",()=>withPage(page=>stay(page,false)));
  await runCase("Pet Sitting journey",()=>withPage(page=>stay(page,true)));
  await runCase("Dog Walking journey",()=>withPage(page=>walking(page)));
  await runCase("Pet Taxi journey",()=>withPage(page=>taxi(page)));
  await runCase("Fresh Food journey",()=>withPage(page=>food(page)));
  await runCase("Relocation journey",()=>withPage(page=>relocation(page)));
  await runCase("no uncaught browser errors",async()=>{if(pageErrors.length)die(pageErrors.join(" | "));return"no pageerror events";});
 }finally{persist();await browser.close();}
 if(report.failures.length){console.error(`Customer UI acceptance failed: ${report.failures.length}`);process.exitCode=1;}else console.log(`Customer UI acceptance passed: ${report.summary.passed}/${report.summary.total}`);}
main().catch(error=>{report.failures.push({name:"harness",detail:error instanceof Error?error.message:String(error)});persist();console.error(error);process.exit(1);});