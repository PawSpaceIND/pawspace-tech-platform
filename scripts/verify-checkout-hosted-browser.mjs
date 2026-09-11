import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const root=process.env.CANDIDATE_DIR;
if(!root)throw Error("Tool dependency root required");
const require=createRequire(resolve(root,"package.json"));
const {chromium,expect}=require("@playwright/test");
const evidence=resolve(process.env.CHECKOUT_EVIDENCE_DIR||"checkout-sandbox-evidence");
const hosting=JSON.parse(readFileSync(resolve(evidence,"hosting-report.json"),"utf8"));
const origin=hosting.origin;
const expectedWorker=String(process.env.EXPECTED_WORKER_NAME||`pawspace-checkout-736-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
if(hosting.hosted!==true||hosting.candidateSha!==process.env.EXPECTED_SHA||hosting.worker!==expectedWorker)throw Error("Hosted browser candidate provenance mismatch");
const accessCode=String(process.env.PAWSPACE_UAT_ACCESS_CODE||"");
if(accessCode.trim()!==accessCode||accessCode.length<32)throw Error("Private UAT access is required for the hosted browser check");
if(!/^https:\/\/pawspace-checkout-736-[0-9]+-[0-9]+\.[a-z0-9-]+\.workers\.dev$/.test(origin||""))throw Error("Only the dedicated checkout sandbox origin is allowed");
if(!new URL(origin).hostname.startsWith(`${hosting.worker}.`))throw Error("Browser origin does not match the created Worker identity");
const output=resolve(evidence,"browser");mkdirSync(output,{recursive:true});
const report={origin,candidateSha:hosting.candidateSha,kind:"real hosted guest browser actions; no session/payment/provider mock",capture:"NOT_RUN",providerWebhookDelivery:"NOT_RUN",viewports:[]};
const browser=await chromium.launch({headless:true});
try{
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const label=viewport.width===390?"mobile":"desktop",context=await browser.newContext({viewport});const page=await context.newPage();page.setDefaultTimeout(20000);
  const row={label,viewport,errors:[],failedRequests:[],services:[]};report.viewports.push(row);
  page.on("pageerror",error=>row.errors.push(error.message.slice(0,300)));
  page.on("requestfailed",r=>{const u=new URL(r.url());row.failedRequests.push({path:u.origin+u.pathname,error:r.failure()?.errorText});});
  try{
   // Use the application's real protected UAT sign-in; do not manufacture an auth cookie.
   const login=await context.request.post(origin+"/api/staging-login",{headers:{origin},data:{email:"founder@pawspace.in",code:accessCode},timeout:20000});
   if(login.status()!==200)throw Error(`Hosted UAT sign-in refused with HTTP ${login.status()}`);
   const response=await page.goto(origin+"/mobile-app",{waitUntil:"domcontentloaded"});expect(response.status()).toBe(200);
   const home=page.locator('[data-home-design="pawspace-prototype-converged"]');await expect(home).toBeVisible();
   await expect(page.locator('[data-home-design="option-5-premium-visual"]')).toHaveCount(0);
   const care=page.getByRole("region",{name:"Care services",exact:true});const names=["Grooming","Training","Boarding","Pet Sitting","Pet Taxi","Dog Walking","Fresh Food","Relocation"];
   await expect(care.getByRole("button")).toHaveCount(8);await expect(page.locator("html")).toHaveAttribute("data-paw-style","professional");
   await page.screenshot({path:resolve(output,`${label}-professional.png`),fullPage:true});
   await page.getByRole("button",{name:"Change PawSpace appearance"}).click();const appearance=page.getByRole("dialog",{name:"Make PawSpace yours."});
   await appearance.getByRole("radio",{name:/^Cartoon/}).check();await appearance.getByRole("button",{name:"Done",exact:true}).click();
   await expect(page.locator("html")).toHaveAttribute("data-paw-style","cartoon");
   for(const name of names){
    const card=care.getByRole("button",{name:new RegExp(name,"i")});await expect(card).toBeEnabled();await card.scrollIntoViewIfNeeded();await card.click({trial:true});
    const bounds=await card.boundingBox();expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);
    const images=card.locator("..").locator("img");await expect.poll(()=>images.evaluateAll(nodes=>nodes.some(n=>n.complete&&n.naturalWidth>0)),{timeout:20_000}).toBe(true);
    const image=await images.evaluateAll(nodes=>nodes.find(n=>n.complete&&n.naturalWidth>0)?.getAttribute("src")||null);expect(image).toBeTruthy();
    row.services.push({name,width:bounds.width,height:bounds.height,image,enabled:true,actionable:true});
   }
   await home.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,`${label}-cartoon.png`),fullPage:true});
   const search=home.getByRole("textbox",{name:"Search PawSpace services"});await search.fill("food");await expect(care.getByRole("button")).toHaveCount(1);await search.fill("");await expect(care.getByRole("button")).toHaveCount(8);row.search=true;
   await home.getByRole("button",{name:"Choose your service location",exact:true}).click();const location=page.getByRole("dialog",{name:"Choose your service area"});await expect(location).toBeVisible();await location.getByRole("button",{name:"Close location",exact:true}).click();row.locationDialog=true;
   const nav=page.getByRole("navigation",{name:"Customer navigation"});
   for(const name of names){await care.getByRole("button",{name:new RegExp(name,"i")}).click();await expect(page.getByRole("heading",{name:`Book ${name}`,exact:true})).toBeVisible();await nav.getByRole("button",{name:/Home$/i}).click();await expect(home).toBeVisible();}
   row.allServiceEntries=true;
   await page.getByRole("button",{name:"Change PawSpace appearance"}).click();await appearance.getByRole("radio",{name:/^Professional/}).check();await appearance.getByRole("button",{name:"Done",exact:true}).click();await page.reload();await expect(home).toBeVisible();await expect(page.locator("html")).toHaveAttribute("data-paw-style","professional");row.preferencePersistence=true;
   row.pass=row.errors.length===0;
  }catch(error){row.pass=false;row.error=String(error.message).split(accessCode).join("[REDACTED]").slice(0,2000);await page.screenshot({path:resolve(output,`${label}-failure.png`),fullPage:true}).catch(()=>{});}
  await context.close();writeFileSync(resolve(output,"browser-report.json"),JSON.stringify(report,null,2));console.log(label,row.pass?"PASS":"FAIL",row.services.length,"service controls",row.error||"");
 }
}finally{await browser.close();writeFileSync(resolve(output,"browser-report.json"),JSON.stringify(report,null,2));}
if(report.viewports.some(row=>!row.pass))process.exitCode=1;
else{hosting.customerUiVerified=true;hosting.browserEvidence="browser/browser-report.json";writeFileSync(resolve(evidence,"hosting-report.json"),JSON.stringify(hosting,null,2));console.log("Authenticated hosted customer UI verified on desktop and mobile viewport; payment capture remains NOT_RUN.");}
