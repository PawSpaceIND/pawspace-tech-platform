import fs from "node:fs";
import { chromium } from "playwright";

const readArg=(name,fallback="")=>{const item=process.argv.find(value=>value.startsWith(`--${name}=`));return item?item.slice(name.length+3):fallback;};
const BASE=readArg("base",process.env.PREVIEW_URL||"").replace(/\/$/,"");
const OUT=readArg("json","customer-ui-acceptance-report.json");
const PHONE=readArg("phone","9000000911"),PIN="560038",PET="UI Test Bruno",CUSTOMER="UI Acceptance Customer",ADDRESS="12 Acceptance Road, Indiranagar, Bengaluru";
const TIMEOUT=Number(readArg("timeout","18000"));
const SERVER_TIMEOUT=Number(readArg("server-timeout","60000"));
if(!BASE)throw new Error("--base or PREVIEW_URL is required");

const report={generatedAt:new Date().toISOString(),base:BASE,pincode:PIN,cases:[],failures:[],sittingProfileRateEvidence:[]};
const persist=()=>{report.summary={total:report.cases.length,passed:report.cases.filter(x=>x.ok).length,failed:report.cases.filter(x=>!x.ok).length};fs.writeFileSync(OUT,`${JSON.stringify(report,null,2)}\n`);};
const die=(message)=>{throw new Error(message);};
const wait=async(page,ms=350)=>{await page.waitForLoadState("domcontentloaded",{timeout:TIMEOUT}).catch(()=>undefined);await page.waitForTimeout(ms);};
async function runCase(name,fn){const started=Date.now();try{const detail=await fn();report.cases.push({name,ok:true,ms:Date.now()-started,detail:detail||"passed"});console.log(`PASS ${name}${detail?` — ${detail}`:""}`);}catch(error){const detail=error instanceof Error?error.message:String(error);report.cases.push({name,ok:false,ms:Date.now()-started,detail});report.failures.push({name,detail});console.error(`FAIL ${name} — ${detail}`);}finally{persist();}}
async function bottomNav(page){const nav=page.locator("nav");await nav.waitFor({state:"visible",timeout:TIMEOUT});return nav;}
async function gotoApp(page){const response=await page.goto(`${BASE}/mobile-app`,{waitUntil:"domcontentloaded",timeout:TIMEOUT});if(!response||response.status()>=500)die(`mobile app HTTP ${response?.status()??0}`);await bottomNav(page);}
async function nav(page,label){const buttons=(await bottomNav(page)).getByRole("button").filter({hasText:new RegExp(label,"i")});const count=await buttons.count();if(!count)die(`bottom navigation ${label} not found`);await buttons.last().click();await wait(page,220);}
async function text(page,value,timeout=TIMEOUT){await page.getByText(value,{exact:false}).first().waitFor({state:"visible",timeout});}
async function ready(page,button,label,timeout=TIMEOUT){
 await button.waitFor({state:"visible",timeout});
 try{await button.click({trial:true,timeout});}
 catch(error){const alerts=(await page.getByRole("alert").allTextContents()).map(value=>value.replace(/\s+/g," ").trim()).filter(Boolean);die(`${label} did not become available${alerts.length?`: ${alerts.join(" | ")}`:""} (${error instanceof Error?error.message.split("\n")[0]:String(error)})`);}
 return button;
}
async function petsReady(page){const loading=page.getByText("Loading your pets…",{exact:true}).first();if(await loading.count())await loading.waitFor({state:"hidden",timeout:SERVER_TIMEOUT});}
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
 await nav(page,"Account");await page.getByPlaceholder("10-digit phone number").fill(PHONE);await page.getByRole("button",{name:"Send OTP"}).click();
 const sandbox=page.getByText(/Sandbox code \(no real SMS yet\):/i);await sandbox.waitFor({state:"visible",timeout:TIMEOUT});const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];if(!code)die("sandbox OTP not rendered");
 const codeInput=page.getByPlaceholder("6-digit code");await codeInput.fill(code);await page.getByPlaceholder("Your name (first time only)").fill(CUSTOMER);await page.getByRole("button",{name:"Verify & continue"}).click();await codeInput.waitFor({state:"hidden",timeout:TIMEOUT});
 const verified=await context.request.get(`${BASE}/api/identity-session`),body=await verified.json().catch(()=>({}));if(!verified.ok()||body?.data?.subjectType!=="customer")die(`OTP did not establish customer session (HTTP ${verified.status()})`);return`real OTP -> ${body.data.subjectId}`;
}

async function ensurePet(page){
 await nav(page,"My Pets");await petsReady(page);if(await page.getByText(PET,{exact:true}).count())return`${PET} reused`;
 const add=page.getByRole("button",{name:/Add pet/i}).first();await add.waitFor({state:"visible",timeout:TIMEOUT});await add.click();await page.getByPlaceholder("Pet name").fill(PET);
 await page.getByLabel("Breed").selectOption({index:1});await page.getByLabel("Age").selectOption({index:1});await page.getByLabel("Weight").selectOption({index:1});await page.getByLabel("Temperament").selectOption({index:1});await page.getByLabel("Vaccinated?").selectOption("yes");
 const gender=page.getByLabel("Gender (optional)");if(await gender.count())await gender.selectOption({index:1});await page.getByRole("button",{name:"Add pet",exact:true}).click();await page.getByText(PET,{exact:true}).first().waitFor({state:"visible",timeout:TIMEOUT});return`${PET} created through UI`;
}

const care=(page)=>page.getByRole("region",{name:"Care services"});
async function goHome(page){await gotoApp(page);await nav(page,"Home");await page.getByText("Everything they need",{exact:true}).waitFor({state:"visible",timeout:TIMEOUT});}
async function openService(page,name){await goHome(page);const card=care(page).getByRole("button",{name:new RegExp(name,"i")});const count=await card.count();if(count!==1)die(`${name} discovery card count=${count}`);if(await card.isDisabled())die(`${name} discovery card disabled`);await card.click();await wait(page,450);}

async function observeFinal(page,button,target,safePosts=[],timeout=SERVER_TIMEOUT){
 const seen=[],unexpected=[];const handler=async(route)=>{const req=route.request(),method=req.method(),path=new URL(req.url()).pathname,label=`${method} ${path}`;if(!["POST","PUT","PATCH","DELETE"].includes(method)){await route.continue();return;}if(target.test(label)){seen.push(label);await route.abort("blockedbyclient");return;}if(safePosts.some(pattern=>pattern.test(label))){await route.continue();return;}unexpected.push(label);await route.abort("blockedbyclient");};
 await page.route("**/api/**",handler);try{await button.click({timeout:TIMEOUT});const deadline=Date.now()+timeout;while(!seen.length&&!unexpected.length&&Date.now()<deadline)await page.waitForTimeout(100);}finally{await page.unroute("**/api/**",handler);}if(unexpected.length)die(`unexpected committing request(s) before target: ${unexpected.join(", ")}`);if(!seen.length)die(`expected final mutation ${target} not attempted within ${timeout}ms`);return seen.join(", ");
}

async function homeControls(page){
 await goHome(page);for(const name of["Grooming","Training","Boarding","Pet Sitting","Pet Taxi","Dog Walking","Fresh Food","Relocation"]){const card=care(page).getByRole("button",{name:new RegExp(name,"i")});if(await card.count()!==1)die(`${name} missing/duplicated`);if(await card.isDisabled())die(`${name} disabled`);}
 const guides=page.getByRole("region",{name:"Quick service guides"}).getByRole("button");if(await guides.count()!==6)die(`guide slots=${await guides.count()}, expected 6`);
 await page.getByRole("button",{name:"Choose your service location"}).click();await page.getByPlaceholder("e.g. HSR Layout, Bengaluru").fill("Indiranagar, Bengaluru");await page.getByRole("button",{name:"Save location"}).click();await text(page,"Indiranagar, Bengaluru");
 const search=page.getByLabel("Search PawSpace services");await search.fill("food");await care(page).getByRole("button",{name:/Fresh Food/i}).waitFor({state:"visible",timeout:TIMEOUT});if(await care(page).getByRole("button",{name:/Grooming/i}).count())die("search failed to filter service cards");await search.fill("");
 await page.getByRole("button",{name:/View your bookings/i}).click();await wait(page,200);await nav(page,"Home");await page.getByRole("button",{name:"Open pet profiles"}).click();await text(page,"Your pets");return"8 services + search + location + six guides + bookings + pets";
}

async function grooming(page){await openService(page,"Grooming");await text(page,"Who needs grooming?");const next=page.getByRole("button",{name:/Choose a package/i});await ensurePetProgress(page,next,"Grooming package progression");await next.click();for(const label of["Essential Bath","Bath & Basic","Complete Makeover","Just Trim"])await text(page,label);return"pet -> package stage + legacy packages";}

async function training(page){
 await openService(page,"Training");await text(page,"Build better days together.");await petsReady(page);const plans=page.getByRole("button",{name:/See PawSpace plans/i});await ready(page,plans,"Training plan progression",SERVER_TIMEOUT);await plans.click();await text(page,"All training programmes");await page.getByPlaceholder("Enter six-digit PIN code").first().fill(PIN);await page.getByRole("button",{name:"Choose trainer"}).click();await text(page,"Your trainer matches");const calendar=page.getByRole("button",{name:"Build session calendar"});await ready(page,calendar,"Training trainer match",SERVER_TIMEOUT);await calendar.click();await text(page,"Plan your sessions");await page.getByRole("button",{name:"Review & pay"}).click();await text(page,"Review your programme");const final=page.getByRole("button",{name:/request trainer approval|Refreshing server quote/i});await ready(page,final,"Training server quote",SERVER_TIMEOUT);const seen=await observeFinal(page,final,/POST \/api\/uat-scheduling/,[/POST \/api\/training-commercial/]);return`5 stages + final scheduler wiring (${seen})`;
}

async function address(page){await page.getByLabel("Complete doorstep address").fill(ADDRESS);await page.getByPlaceholder("e.g., 560034").fill(PIN);await page.getByRole("button",{name:"Check",exact:true}).click();await text(page,"Indiranagar",SERVER_TIMEOUT);}
async function stay(page,sitting){
 const name=sitting?"Pet Sitting":"Boarding";await openService(page,name);await text(page,sitting?"Care at home, around their routine.":"A stay that feels like home.");await address(page);const available=page.getByRole("button",{name:sitting?/See available sitters/i:/See available homes/i});await ensurePetProgress(page,available,`${name} trip details`);await available.click();await text(page,sitting?"Choose your sitter":"Choose your host");if(sitting){const rates=await page.locator("button").filter({hasText:"/ night"}).allTextContents();report.sittingProfileRateEvidence=rates.slice(0,3).map(x=>x.replace(/\s+/g," ").trim());if(!rates.length)die("Sitting profile rates not rendered for checkout-vs-card review");}
 const next=page.getByRole("button",{name:/Continue with|Choose an available host/i});await ready(page,next,`${name} caregiver match`,SERVER_TIMEOUT);await next.click();await text(page,"Build the Care Card");await page.getByRole("button",{name:"Review protected booking"}).click();await text(page,"Review and confirm");const final=page.getByRole("button",{name:/create canonical stay|request final partner approval/i});await ready(page,final,`${name} server quote`,SERVER_TIMEOUT);const seen=await observeFinal(page,final,sitting?/POST \/api\/(sitting-payment|uat-scheduling|canonical-bookings)/:/POST \/api\/uat-scheduling/,[/POST \/api\/(boarding|sitting).*quote/,/POST \/api\/live-price-quote/]);return`4 stages + caregiver + final wiring (${seen})`;
}

async function walking(page){
 await openService(page,"Dog Walking");await text(page,"Choose a walk package");const schedule=page.getByRole("button",{name:"Plan the schedule"});await ready(page,schedule,"Walking catalogue",SERVER_TIMEOUT);await schedule.click();await page.getByRole("button",{name:"Choose your dog"}).click();await text(page,"Who's walking?");const review=page.getByRole("button",{name:"Review & confirm"});await ensurePetProgress(page,review,"Walking pet selection");await review.click();await text(page,"Review your walks");await page.getByPlaceholder("Enter six-digit PIN code").fill(PIN);const final=page.getByRole("button",{name:/Confirm \d+ walk|Refreshing server quote/i});await ready(page,final,"Walking server quote",SERVER_TIMEOUT);const seen=await observeFinal(page,final,/POST \/api\/uat-scheduling/,[/POST \/api\/walking-commercial/]);return`4 stages + fresh quote + scheduler wiring (${seen})`;
}

async function taxi(page){
 await openService(page,"Pet Taxi");await text(page,"Choose a route class");const route=page.getByRole("button",{name:"Set pickup & drop"});await ready(page,route,"Taxi catalogue",SERVER_TIMEOUT);await route.click();await page.getByPlaceholder("e.g. Indiranagar, 100 Feet Road").fill("Indiranagar");await page.getByPlaceholder("e.g. Whitefield vet clinic").fill("Whitefield Vet Clinic");const choose=page.getByRole("button",{name:"Choose your pet"});await ready(page,choose,"Taxi locations");await choose.click();const review=page.getByRole("button",{name:"Review & confirm"});await ensurePetProgress(page,review,"Taxi pet selection");await review.click();await text(page,"Review your trip");await page.getByPlaceholder("Enter six-digit PIN code").fill(PIN);const final=page.getByRole("button",{name:/Confirm trip|Refreshing server quote/i});await ready(page,final,"Taxi server quote",SERVER_TIMEOUT);const seen=await observeFinal(page,final,/POST \/api\/uat-scheduling/,[/POST \/api\/taxi-commercial/]);return`4 stages + fresh quote + scheduler wiring (${seen})`;
}

async function food(page){
 await openService(page,"Fresh Food");await text(page,"Fresh food for your pets");await page.getByPlaceholder("Enter six-digit PIN code").first().fill(PIN);await page.getByRole("button",{name:"Check service area & load catalogue"}).click();await text(page,"Delivery coverage confirmed",SERVER_TIMEOUT);const add=page.getByRole("button",{name:"Add",exact:true}).first();await add.waitFor({state:"visible",timeout:SERVER_TIMEOUT});await add.click();const cart=page.getByRole("button",{name:/Review cart/i});await ready(page,cart,"Food cart",SERVER_TIMEOUT);await cart.click();await text(page,"Your cart");const choosePlan=page.getByRole("button",{name:"Choose delivery plan"});await transition(page,choosePlan,page.getByText("One-time or repeat?",{exact:true}),"Food delivery-plan transition");const delivery=page.getByRole("button",{name:"Delivery details"});await transition(page,delivery,page.getByText("Where and when?",{exact:true}),"Food delivery-details transition");const deliveryAddress=page.getByLabel("Delivery address");await deliveryAddress.waitFor({state:"visible",timeout:TIMEOUT});await deliveryAddress.fill(ADDRESS);const review=page.getByRole("button",{name:"Review with server quote"});await ready(page,review,"Food delivery coverage",SERVER_TIMEOUT);await review.click();await text(page,"Review and confirm",SERVER_TIMEOUT);const final=page.getByRole("button",{name:/Confirm food order|Confirm order \+ repeat plan/i});await ready(page,final,"Food server quote",SERVER_TIMEOUT);const seen=await observeFinal(page,final,/POST \/api\/food-orders/);return`5 stages + catalogue + quote + order wiring (${seen})`;
}

async function relocation(page){await openService(page,"Relocation");await text(page,"PET RELOCATION · ENQUIRY");await page.getByLabel("Email").fill("ui-acceptance@pawspace.test");await page.getByLabel("Pickup location").fill("Koramangala, Bengaluru");await page.getByLabel("Drop location").fill("Indiranagar, Bengaluru");const seen=await observeFinal(page,page.getByRole("button",{name:"Request relocation plan & quote"}),/POST \/api\/relocation-enquiry/);return`enquiry-only wiring (${seen}); no payment endpoint`;}

async function main(){const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),pageErrors=[];page.on("pageerror",error=>pageErrors.push(String(error.message).slice(0,240)));try{
 await runCase("real customer OTP/session",()=>login(page,context));await runCase("customer pet profile",()=>ensurePet(page));await runCase("premium Home and controls",()=>homeControls(page));await runCase("Grooming journey",()=>grooming(page));await runCase("Training journey",()=>training(page));await runCase("Boarding journey",()=>stay(page,false));await runCase("Pet Sitting journey",()=>stay(page,true));await runCase("Dog Walking journey",()=>walking(page));await runCase("Pet Taxi journey",()=>taxi(page));await runCase("Fresh Food journey",()=>food(page));await runCase("Relocation journey",()=>relocation(page));await runCase("no uncaught browser errors",async()=>{if(pageErrors.length)die(pageErrors.join(" | "));return"no pageerror events";});
 }finally{persist();await browser.close();}if(report.failures.length){console.error(`Customer UI acceptance failed: ${report.failures.length}`);process.exitCode=1;}else console.log(`Customer UI acceptance passed: ${report.summary.passed}/${report.summary.total}`);}
main().catch(error=>{report.failures.push({name:"harness",detail:error instanceof Error?error.message:String(error)});persist();console.error(error);process.exit(1);});