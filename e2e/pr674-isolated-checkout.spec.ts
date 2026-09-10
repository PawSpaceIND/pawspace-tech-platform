import { test, expect, type Page } from "@playwright/test";

const ORIGIN="https://pawspace-checkout-674-34456730410-1.karthik-fce.workers.dev";
const WORKER="pawspace-checkout-674-34456730410-1";
const ACCOUNT=process.env.CLOUDFLARE_ACCOUNT_ID||"";
const TOKEN=process.env.CLOUDFLARE_API_TOKEN||"";
type Json=Record<string,unknown>;

async function cf(path:string,init:RequestInit={}){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,{...init,headers:{authorization:`Bearer ${TOKEN}`,"content-type":"application/json",...(init.headers||{})}});
 const b=await r.json() as {success?:boolean;result?:unknown};
 if(!r.ok||b.success!==true)throw new Error(`Cloudflare diagnostic failed (${r.status})`);
 return b.result;
}
async function dbId(){for(let page=1;page<=10;page++){const rows=await cf(`/d1/database?per_page=100&page=${page}`) as Json[],hit=rows.find(r=>r.name===WORKER);if(hit?.uuid)return String(hit.uuid);if(!rows.length)break}throw new Error("isolated D1 not found")}
async function query(id:string,sql:string,params:unknown[]=[]){const r=await cf(`/d1/database/${id}/query`,{method:"POST",body:JSON.stringify({sql,params})}) as Array<{results?:Array<Record<string,unknown>>}>;return Array.isArray(r?.[0]?.results)?r[0].results:[]}
async function post(page:Page,path:string,body:Json){return page.evaluate(async({path,body})=>{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"});return{status:r.status,body:await r.json()}},{path,body})}
async function seed(id:string,customerId:string){const now=Date.now(),bookingId=`PR674-DIAG-${now}`,paymentId=`PR674-DIAG-PAY-${now}`,start=new Date(now+7*86400000).toISOString(),end=new Date(now+7*86400000+7200000).toISOString();
 await query(id,"CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 await query(id,"CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
 await query(id,"INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','pr674-sandbox','PR674 Checkout Sandbox',?,'groom_kiran',?,?,'confirmed','customer_app',1,'INR','{}','pr674_diag',?,?)",[bookingId,`idem-${bookingId}`,customerId,"[]","[]",`group-${bookingId}`,start,end,now,now]);
 await query(id,"INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1,1,'INR','upi','prepaid','created','uat_sandbox',?,'{}',?,?)",[paymentId,bookingId,customerId,`idem-${paymentId}`,now,now]);return{bookingId,paymentId}}

test("current isolated PR674 checkout reuses order and exposes loaded Razorpay Test modal",async({page},testInfo)=>{
 test.skip(testInfo.project.name!=="chromium");test.setTimeout(180000);expect(ACCOUNT).toMatch(/^[a-f0-9]{32}$/i);expect(TOKEN.length).toBeGreaterThan(20);
 await page.goto(`${ORIGIN}/mobile-app`,{waitUntil:"domcontentloaded"});
 const otp=await post(page,"/api/customer-otp",{action:"request",phone:"9000000674"});expect(otp.status).toBe(200);
 const verified=await post(page,"/api/customer-otp",{action:"verify",challengeId:otp.body.data.challengeId,code:otp.body.data.sandboxCode,name:"PR674 Diagnostic",cityId:"blr"});expect(verified.status).toBe(200);
 const id=await dbId(),fixture=await seed(id,String(verified.body.data.customerId));
 const start=await post(page,"/api/customer-checkout",{action:"start",bookingId:fixture.bookingId});
 const intents=await query(id,"SELECT id,booking_id,payment_id,environment,amount_paise,currency,state,order_request_state,gateway_order_id FROM payment_intents WHERE booking_id=?",[fixture.bookingId]).catch((e:unknown)=>[{queryError:e instanceof Error?e.message:String(e)}]);
 const outbox=await query(id,"SELECT aggregate_id,status,attempts,last_error FROM financial_outbox WHERE aggregate_type='payment_intent' AND aggregate_id IN (SELECT id FROM payment_intents WHERE booking_id=?)",[fixture.bookingId]).catch((e:unknown)=>[{queryError:e instanceof Error?e.message:String(e)}]);
 const safe={http:start.status,response:start.body,intents,outbox,bookingId:fixture.bookingId};console.log(`[PR674-DIAG] ${JSON.stringify(safe)}`);
 await testInfo.attach("pr674-checkout-start-diagnostic",{body:JSON.stringify(safe,null,2),contentType:"application/json"});
 expect(start.status,JSON.stringify(safe)).toBe(201);
 expect(start.body?.data?.orderId).toMatch(/^order_/);
 const firstOrder=String(start.body.data.orderId);
 await page.goto(`${ORIGIN}/mobile-app`,{waitUntil:"domcontentloaded"});
 await page.locator("nav").getByRole("button",{name:/account/i}).last().click();
 await expect(page.getByText("Payments & invoice summaries",{exact:true})).toBeVisible({timeout:30000});
 await page.getByText("Payments & invoice summaries",{exact:true}).click();
 const card=page.locator("article").filter({hasText:fixture.bookingId});
 const pay=card.getByRole("button",{name:"Review & pay (test)",exact:true});
 await expect(pay).toBeVisible();
 const reused=page.waitForResponse(r=>{if(r.url()!==`${ORIGIN}/api/customer-checkout`||r.request().method()!=="POST")return false;try{return r.request().postDataJSON()?.action==="start"}catch{return false}});
 await pay.click();
 const reuseResponse=await reused,reuseBody=await reuseResponse.json();
 expect(reuseResponse.status()).toBe(201);expect(reuseBody.data.orderId).toBe(firstOrder);expect(reuseBody.data.environment).toBe("sandbox");expect(String(reuseBody.data.keyId)).toMatch(/^rzp_test_/);expect(reuseBody.data.locks.FORBID_PRODUCTION).toBe("true");expect(reuseBody.data.locks.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
 await page.waitForTimeout(12000);
 const frames=[];for(const [index,frame] of page.frames().entries()){const text=await frame.locator("body").innerText().catch(()=>"");const controls=await frame.locator("input,button,[role=button]").evaluateAll(nodes=>nodes.slice(0,80).map(node=>({tag:node.tagName,text:(node.textContent||"").trim().replace(/\s+/g," ").slice(0,140),placeholder:node.getAttribute("placeholder"),aria:node.getAttribute("aria-label"),type:node.getAttribute("type")}))).catch(()=>[]);frames.push({index,url:frame.url(),text:text.slice(0,5000),controls});}
 console.log(`[PR674-MODAL] ${JSON.stringify(frames)}`);await testInfo.attach("pr674-razorpay-modal-structure",{body:JSON.stringify(frames,null,2),contentType:"application/json"});await page.screenshot({path:testInfo.outputPath("pr674-razorpay-modal-loaded.png"),fullPage:true});
 const razor=page.frames().find(frame=>/api\.razorpay\.com\/v1\/checkout\/public/.test(frame.url()));
 expect(razor,"Razorpay Test checkout frame must be present").toBeTruthy();
 await razor!.getByRole("button",{name:"Close",exact:true}).click();
 await expect(card.getByRole("alert")).toContainText("Checkout closed. No payment confirmation has been recorded here.",{timeout:10000});
 await expect(pay).toBeEnabled();
 const paymentAfterDismiss=await query(id,"SELECT status,amount,amount_due_now,gateway FROM booking_payments WHERE id=?",[fixture.paymentId]);
 const intentAfterDismiss=await query(id,"SELECT state,order_request_state,gateway_order_id FROM payment_intents WHERE booking_id=?",[fixture.bookingId]);
 expect(paymentAfterDismiss[0]?.status).toBe("created");
 expect(intentAfterDismiss[0]?.state).toBe("CREATED");
 expect(intentAfterDismiss[0]?.gateway_order_id).toBe(firstOrder);
 console.log(`[PR674-DISMISS] ${JSON.stringify({payment:paymentAfterDismiss[0],intent:intentAfterDismiss[0]})}`);

 const retry=page.waitForResponse(r=>{if(r.url()!==`${ORIGIN}/api/customer-checkout`||r.request().method()!=="POST")return false;try{return r.request().postDataJSON()?.action==="start"}catch{return false}});
 await pay.click();
 const retryResponse=await retry,retryBody=await retryResponse.json();
 expect(retryResponse.status()).toBe(201);expect(retryBody.data.orderId).toBe(firstOrder);
 await expect.poll(()=>page.frames().some(frame=>/api\.razorpay\.com\/v1\/checkout\/public/.test(frame.url())),{timeout:15000}).toBe(true);
 const retryRazor=page.frames().find(frame=>/api\.razorpay\.com\/v1\/checkout\/public/.test(frame.url()));
 expect(retryRazor).toBeTruthy();
 const mobile=retryRazor!.locator('input[placeholder="Mobile number"]');
 await expect(mobile).toBeVisible({timeout:15000});
 await mobile.fill("9000000674");
 await retryRazor!.getByRole("button",{name:"Continue",exact:true}).click();
 await page.waitForTimeout(5000);
 const methodFrames=[];for(const [index,frame] of page.frames().entries()){const text=await frame.locator("body").innerText().catch(()=>"");const controls=await frame.locator("input,button,[role=button]").evaluateAll(nodes=>nodes.slice(0,100).map(node=>({tag:node.tagName,text:(node.textContent||"").trim().replace(/\s+/g," ").slice(0,160),placeholder:node.getAttribute("placeholder"),aria:node.getAttribute("aria-label"),type:node.getAttribute("type")}))).catch(()=>[]);methodFrames.push({index,url:frame.url(),text:text.slice(0,6000),controls});}
 console.log(`[PR674-METHODS] ${JSON.stringify(methodFrames)}`);await testInfo.attach("pr674-payment-method-structure",{body:JSON.stringify(methodFrames,null,2),contentType:"application/json"});await page.screenshot({path:testInfo.outputPath("pr674-payment-methods.png"),fullPage:true});
 expect(methodFrames.some(frame=>/UPI|Netbanking|Cards/i.test(frame.text))).toBe(true);
 await page.frames().find(frame=>/api\.razorpay\.com\/v1\/checkout\/public/.test(frame.url()))?.getByRole("button",{name:"Close",exact:true}).click().catch(()=>{});
});

// Harness refresh marker: exact PR674 external modal diagnostic only.
