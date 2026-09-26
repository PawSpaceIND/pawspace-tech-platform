/** Visible local UI fixtures. Does not certify hosted identities or live transactions. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('Loopback UI review only.');
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/customer-theme/final';fs.mkdirSync(OUT+'/screens',{recursive:true});
const browser=await chromium.launch({headless:false,slowMo:80,args:['--remote-debugging-port=9231','--remote-debugging-address=127.0.0.1'],executablePath:process.env.STAFF_UI_CHROMIUM_PATH||process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
const results=[],reads=[],writes=[],blocked=[],pageErrors=[]; const runMode=process.env.UI_TEST_MODE||'all', batch=process.env.UI_THEME_BATCH||'';
function persist(){fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible Chromium; intercepted API fixtures only',runMode,batch,completed:false,results,reads,writes,blocked,pageErrors},null,2));}
process.on('SIGTERM',async()=>{persist();await browser.close();process.exit(143);});
process.on('SIGINT',async()=>{persist();await browser.close();process.exit(130);});page.on('pageerror',e=>pageErrors.push(String(e)));
let identity='customer',accountDenied=false,caseDenied=false,createDenied=false,caseRecord=null,providerSignedIn=false;
const account={customerId:'UI-CUSTOMER',cityId:'blr',name:'Theme Fixture',primaryPhone:'9000000001',secondaryPhone:null,email:'fixture@example.test',memberSince:Date.now(),addresses:[],pets:[],bookings:[],foodOrders:[]};
const future=new Date(Date.now()+60*86400000).toISOString().slice(0,10);
const json=(r,body,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
let foodQuoteDenied=false, foodFulfilment='reserved', subscriptionStatus='active';
const foodPet={id:'UI-PET-DOG',sourceId:null,name:'Milo Fixture',species:'dog',breed:'Indie',vaccinationStatus:'verified',ageYears:2,weightKg:10,profile:null};
const foodItems=[{sku:'food-uat-dog-adult-2kg',name:'Fresh Dog Food Fixture',pet_type:'dog',pack_size:'2 kg',unit_price:650,currency:'INR',max_qty_per_order:5,version:1,uat_available_units:20,inventory_mode:'uat_seed',production_inventory_verified:false}];
const foodQuote=body=>({quoteId:'UI-QUOTE-'+body.quantity,sku:body.sku,name:foodItems[0].name,version:1,petType:'dog',petIds:body.petIds,packSize:'2 kg',quantity:body.quantity,unitPrice:650,deliveryFee:0,totalAmount:650*body.quantity,amountDueNow:0,currency:'INR',zoneId:'blr-east',paymentMode:'sandbox_deferred',expiresAt:Date.now()+600000,inventoryMode:'uat_seed',productionInventoryVerified:false,liveMoney:false});
const foodSnapshot=()=>({subscription:{id:'UI-FOOD-SUB',status:subscriptionStatus,next_renewal_at:Date.now()+86400000,renewal_interval_days:14},renewals:[{id:'UI-RENEWAL',subscription_id:'UI-FOOD-SUB',status:'payment_pending',total_amount:1300,cycle_no:1,payment_link_path:'/food/subscription-payment?renewalId=UI-RENEWAL'}],invoices:[{id:'UI-INVOICE',subscription_id:'UI-FOOD-SUB',renewal_id:'UI-RENEWAL',invoice_number:'UAT-FOOD-001',net_amount:1300,gross_amount:1300,tax_amount:0,status:'issued',tax_rule_status:'configuration_pending'}],events:[],truth:{liveMoney:false},petIds:[foodPet.id]});
async function foodFixture(route,url,method,body){
 if(method==='GET'){
  if(url.pathname==='/api/food-commercial')return json(route,{data:{items:foodItems,source:'fixture',inventoryMode:'uat_seed',productionInventoryVerified:false,liveMoney:false}});
  if(url.pathname==='/api/food-subscriptions')return json(route,{data:foodSnapshot()});
  if(url.pathname==='/api/food-fulfilment')return json(route,{data:[{id:'UI-FOOD-ORDER',customer_id:account.customerId,status:'reserved',sku:foodItems[0].sku,item_name:foodItems[0].name,quantity:2,fulfilment_status:foodFulfilment,reservation_status:'reserved',events:[]}]});
  if(url.pathname==='/api/food-proof')return json(route,{data:{incidents:[]}});
 }else{
  if(url.pathname==='/api/food-commercial')return foodQuoteDenied?json(route,{error:'Fixture quote unavailable; no order allowed.'},503):json(route,{data:foodQuote(body)});
  if(url.pathname==='/api/food-orders'){await new Promise(r=>setTimeout(r,150));return json(route,{data:{orderId:'UI-FOOD-ORDER',status:'reserved',petIds:[foodPet.id],totalAmount:1300,amountDueNow:0,inventoryMode:'uat_seed',productionInventoryVerified:false,deliveryStatus:'not_dispatched',liveMoney:false}});}
  if(url.pathname==='/api/food-subscriptions'){
   if(body.action==='create')return json(route,{data:{subscriptionId:'UI-FOOD-SUB',nextRenewalAt:Date.now()+86400000}});
   if(body.action==='pause'||body.action==='resume'||body.action==='cancel'){subscriptionStatus={pause:'paused',resume:'active',cancel:'cancelled'}[body.action];return json(route,{data:{status:subscriptionStatus}});}
   return json(route,{error:'Fixture payment refused; no money changed.'},403);
  }
  if(url.pathname==='/api/food-finance')return json(route,{data:{status:'requested'}});
 }
 return json(route,{error:'Unconfigured Food fixture; request not forwarded.'},503);
}

await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.origin!==ORIGIN){blocked.push(url.origin+url.pathname);return route.abort();}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 if(req.method()!=='GET'){
  const body=req.postData()?req.postDataJSON():null;writes.push({path:url.pathname,method:req.method(),body});
  if(url.pathname.startsWith('/api/food-'))return foodFixture(route,url,req.method(),body);
  if(url.pathname==='/api/relocation'){
   if(body.action==='create'){
    if(createDenied)return json(route,{error:'Fixture create rejected; retry keeps the same request.'},503);
    caseRecord={id:'UI-RELOCATION-1',customer_id:body.customerId,status:'inquiry',pet_name:body.petName,breed:body.breed,age_years:body.ageYears,size_class:body.sizeClass,travel_mode:body.travelMode,origin_city:body.originCity,origin_country:body.originCountry,destination_city:body.destinationCity,destination_country:body.destinationCountry,target_travel_date:body.targetTravelDate,regulation_status:'manual_review_required',documents:[],milestones:[],refunds:[],events:[],quote:{amount:25000,status:'sent'}};
    return json(route,{data:caseRecord});
   }
   return json(route,{error:'Fixture action denied; no operational change made.'},403);
  }
  if(url.pathname==='/api/partner-otp'){
   if(body.action==='request')return json(route,{data:{challengeId:'UI-CHALLENGE',sandboxCode:'123456'}});
   if(body.code!=='123456')return json(route,{error:'Fixture invalid verification code.'},400);
   providerSignedIn=true;return json(route,{data:{providerId:'UI-PROVIDER',providerName:'Provider Fixture',phone:'9000000002'}});
  }
  return json(route,{error:'Fixture action not configured; no request forwarded.'},409);
 }
 reads.push(url.pathname+url.search);
 if(url.pathname.startsWith('/api/food-'))return foodFixture(route,url,'GET');
 if(url.pathname==='/api/identity-session')return identity==='customer'?json(route,{data:{subjectType:'customer',subjectId:account.customerId}}):providerSignedIn?json(route,{data:{subjectType:'provider',subjectId:'UI-PROVIDER',roleCode:'service_provider'}}):json(route,{error:'No fixture session'},401);
 if(url.pathname==='/api/customer-account')return accountDenied?json(route,{error:'Fixture account access denied.'},401):json(route,{data:account});
 if(url.pathname==='/api/service-availability')return json(route,{data:['grooming','dog_training','boarding','pet_sitting','dog_walking','pet_taxi','food','relocation'].map(code=>({code,enabled:true}))});
 if(url.pathname==='/api/relocation')return caseDenied?json(route,{error:'Fixture inquiry access denied.'},403):json(route,{data:url.searchParams.has('caseId')?caseRecord:caseRecord?[caseRecord]:[]});
 if(url.pathname==='/api/partner-jobs')return json(route,{jobs:[]});
 if(url.pathname==='/api/partner-job-feed')return json(route,{data:{providerId:'UI-PROVIDER',needsAction:[],today:[],upcoming:[],completed:[],counts:{needsAction:0,today:0,upcoming:0,completed:0,total:0}}});
 if(url.pathname==='/api/provider-workspace')return json(route,{data:{linked:true,engagement:'commission',onboardingStatus:'active',earnings:{visible:true,netPayout:1350,orders:1,grossOrderValue:2000,commissionOrders:[],payouts:[]}}});
 return json(route,{error:'Fixture endpoint unavailable; not a backend certificate.'},503);
});
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(500);await page.evaluate(()=>document.title='PawSpace V2 - VISIBLE UI FIXTURES - NO LIVE ACTIONS');}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){const space=fs.statfsSync('.');if(space.bavail*space.bsize<180*1024*1024){persist();await browser.close();throw new Error('Review stopped to protect local disk space; partial results retained.');}try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',error:String(error)});console.log('FAIL '+name+' '+String(error));await shot('failure-'+results.length).catch(()=>{});}fs.writeFileSync(OUT+'/progress.json',JSON.stringify(results,null,2));}
async function palette(theme,mode){await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await page.waitForTimeout(150);}
function contrast(fg,bg){const lum=s=>{const v=s.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return v[0]*.2126+v[1]*.7152+v[2]*.0722;};const a=lum(fg),b=lum(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
async function style(locator){return locator.evaluate(e=>{const s=getComputedStyle(e);let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;return {font:parseFloat(s.fontSize),family:s.fontFamily,fg:s.color,bg:p?getComputedStyle(p).backgroundColor:'rgb(255,255,255)',primary:s.getPropertyValue('--brand-primary').trim(),surface:s.getPropertyValue('--brand-surface').trim()};});}
async function overflow(){const s=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(s.sw<=s.w+1,JSON.stringify(s));}
if(runMode!=='appearance'){
await check('Relocation: unchanged required fields reject an empty inquiry without sending a request',async()=>{
 identity='customer';await open('/v2/relocation');await page.getByText('No relocation inquiries yet.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Destination city',{exact:true}).inputValue(),'');
 const before=writes.length;await page.getByRole('button',{name:'Create relocation inquiry',exact:true}).click();
 assert.ok(await page.locator('[aria-invalid="true"]').count()>0);assert.equal(writes.length,before);
});
await check('Relocation: domestic route, zero age and idempotent retry preserve the original payload',async()=>{
 await page.getByLabel(/^Pet name/).fill('Milo Fixture');await page.getByLabel(/^Breed/).fill('Indie');await page.getByLabel(/^Age \(years\)/).fill('0');
 await page.getByLabel(/^Size/).selectOption('small');await page.getByLabel(/^Travel mode/).selectOption('road');
 await page.getByLabel(/^Origin country/).fill('India');await page.getByLabel(/^Origin city/).fill('Bengaluru');
 await page.getByLabel(/^Destination country/).fill('India');await page.getByLabel(/^Destination city/).fill('Pune');await page.getByLabel(/^Target date/).fill(future);
 await shot('relocation-form-filled');createDenied=true;await page.getByRole('button',{name:'Create relocation inquiry',exact:true}).click();
 await page.getByText('Fixture create rejected; retry keeps the same request.',{exact:true}).waitFor();createDenied=false;
 await page.getByRole('button',{name:'Create relocation inquiry',exact:true}).click();await page.getByRole('heading',{name:'UI-RELOCATION-1',exact:true}).waitFor();
 const sent=writes.filter(w=>w.path==='/api/relocation'&&w.body?.action==='create');assert.equal(sent.length,2);assert.deepEqual(sent[0].body,sent[1].body);
 const {idempotencyKey,...body}=sent[1].body;assert.match(idempotencyKey,/^relocation:/);
 assert.deepEqual(body,{action:'create',customerId:'UI-CUSTOMER',petName:'Milo Fixture',breed:'Indie',ageYears:0,sizeClass:'small',travelMode:'road',originCountry:'India',originCity:'Bengaluru',destinationCountry:'India',destinationCity:'Pune',targetTravelDate:future,crateRequirement:'assessment_required'});
 assert.equal(new URL(page.url()).searchParams.get('caseId'),'UI-RELOCATION-1');await shot('relocation-inquiry');
});
await check('Relocation: refused quote action does not change case state; saved inquiries retain V2 links',async()=>{
 await page.getByRole('button',{name:'Accept quote',exact:true}).click();await page.getByText('Fixture action denied; no operational change made.',{exact:true}).waitFor();
 assert.deepEqual(writes.at(-1).body,{caseId:'UI-RELOCATION-1',action:'accept_quote'});assert.equal(caseRecord.quote.status,'sent');
 await open('/v2/activity');await page.getByRole('link',{name:'Open inquiry UI-RELOCATION-1',exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open inquiry UI-RELOCATION-1',exact:true}).getAttribute('href'),'/v2/relocation?caseId=UI-RELOCATION-1');
 await page.getByRole('link',{name:'Open inquiry UI-RELOCATION-1',exact:true}).click();await page.getByRole('heading',{name:'UI-RELOCATION-1',exact:true}).waitFor();
});
await check('Relocation: denied account disables create; denied case retains retry and never renders another inquiry',async()=>{
 accountDenied=true;await open('/v2/relocation');await page.getByText('Fixture account access denied.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Create relocation inquiry',exact:true}).isDisabled(),true);accountDenied=false;
 caseDenied=true;await open('/v2/relocation?caseId=UI-DENIED');await page.getByRole('button',{name:'Retry inquiry',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Accept quote',exact:true}).count(),0);caseDenied=false;
});
await check('Partner V2: visible OTP validation, failed verification and server identity recheck remain intact',async()=>{
 identity='provider';providerSignedIn=false;await open('/v2/partner');await page.getByRole('button',{name:'Send OTP',exact:true}).waitFor();const before=writes.length;
 await page.getByRole('button',{name:'Send OTP',exact:true}).click();await page.getByText('Enter a valid 10-digit phone number',{exact:true}).waitFor();assert.equal(writes.length,before);
 await page.getByPlaceholder('10-digit phone number',{exact:true}).fill('9000000002');await page.getByRole('button',{name:'Send OTP',exact:true}).click();await page.getByPlaceholder('6-digit code',{exact:true}).fill('654321');
 await page.getByRole('button',{name:'Verify & continue',exact:true}).click();await page.getByText('Fixture invalid verification code.',{exact:true}).waitFor();assert.equal(providerSignedIn,false);
 await page.getByPlaceholder('6-digit code',{exact:true}).fill('123456');await page.getByRole('button',{name:'Verify & continue',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
 const req=writes.filter(w=>w.path==='/api/partner-otp');assert.deepEqual(req[0].body,{action:'request',phone:'9000000002'});assert.deepEqual(req.at(-1).body,{action:'verify',challengeId:'UI-CHALLENGE',code:'123456',cityId:'blr'});await shot('partner-verified-empty-jobs');
 identity='customer';
});
await check('Fresh Food: quote identity, quantity, refusal and duplicate-click order guard remain unchanged',async()=>{
 identity='customer';account.pets=[foodPet];foodQuoteDenied=false;await open('/v2/food');
 const reserve=page.getByRole('button',{name:'Reserve canonical UAT order',exact:false});await page.locator('button:not([disabled])').filter({hasText:'Reserve canonical UAT order'}).waitFor();
 const quoteRead=()=>writes.filter(w=>w.path==='/api/food-commercial').at(-1)?.body;
 assert.equal(quoteRead().customerId,account.customerId);assert.deepEqual(quoteRead().petIds,[foodPet.id]);
 const qty=page.locator('section').filter({has:page.getByRole('heading',{name:'Quantity',exact:true})}).locator('select');
 foodQuoteDenied=true;await qty.selectOption('3');await page.getByText('Fixture quote unavailable; no order allowed.',{exact:true}).waitFor();assert.equal(await reserve.isDisabled(),true);
 foodQuoteDenied=false;await qty.selectOption('2');await page.locator('button:not([disabled])').filter({hasText:'Reserve canonical UAT order'}).waitFor();
 await page.getByRole('button',{name:'Repeat subscription',exact:true}).click();await page.getByRole('combobox',{name:/^Renewal interval/}).selectOption('14');await shot('food-repeat-order');
 const before=writes.filter(w=>w.path==='/api/food-orders').length;await page.getByRole('button',{name:'Reserve order + create subscription',exact:false}).dblclick();await page.getByRole('heading',{name:'UI-FOOD-ORDER',exact:true}).waitFor();await page.getByRole('link',{name:'Manage subscription',exact:true}).waitFor();
 const sent=writes.filter(w=>w.path==='/api/food-orders');assert.equal(sent.length,before+1);assert.deepEqual(sent.at(-1).body,{idempotencyKey:'food:UI-QUOTE-2:UI-CUSTOMER',quoteId:'UI-QUOTE-2',customer:{id:account.customerId,name:account.name,primaryPhone:account.primaryPhone,email:account.email},cityId:'blr',zoneId:'blr-east'});
 assert.deepEqual(writes.filter(w=>w.path==='/api/food-subscriptions').at(-1).body,{action:'create',sourceOrderId:'UI-FOOD-ORDER',renewalIntervalDays:14,communicationChannel:'whatsapp'});
 assert.equal(await page.getByRole('link',{name:'Manage order',exact:true}).getAttribute('href'),'/v2/food/manage?orderId=UI-FOOD-ORDER');await shot('food-order-confirmed');
 await page.setViewportSize({width:390,height:1000});await overflow();await shot('food-order-confirmed-mobile');await page.setViewportSize({width:1440,height:1000});
});
await check('Food subscriptions: original pause, resume, cancel and payment-link navigation are retained',async()=>{
 subscriptionStatus='active';await open('/v2/food/subscriptions?subscriptionId=UI-FOOD-SUB');await page.getByRole('button',{name:'Pause',exact:true}).click();await page.locator('button:not([disabled])').filter({hasText:/^Resume$/}).waitFor();
 assert.deepEqual(writes.at(-1).body,{subscriptionId:'UI-FOOD-SUB',action:'pause',reason:'Customer pause request from Food subscription workspace'});
 await page.getByRole('button',{name:'Resume',exact:true}).click();await page.locator('button:not([disabled])').filter({hasText:/^Pause$/}).waitFor();assert.equal(subscriptionStatus,'active');
 assert.equal(await page.getByRole('link',{name:'Open UAT payment request',exact:true}).getAttribute('href'),'/v2/food/subscription-payment?renewalId=UI-RENEWAL');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.locator('button[disabled]').filter({hasText:/^Cancel$/}).waitFor();assert.equal(subscriptionStatus,'cancelled');assert.equal(writes.at(-1).body.action,'cancel');await shot('food-subscription-controls');
});
await check('Food renewal and invoice: refused payment stays unpaid; invoice values and identifiers remain intact',async()=>{
 await open('/v2/food/subscription-payment?renewalId=UI-RENEWAL');await page.getByRole('button',{name:'Pay online (sandbox)',exact:true}).click();await page.getByText('Fixture payment refused; no money changed.',{exact:true}).waitFor();assert.deepEqual(writes.at(-1).body,{action:'pay_online_sandbox',renewalId:'UI-RENEWAL'});
 assert.equal(await page.getByText('Payment recorded. Invoice will follow the paid confirmation path.',{exact:true}).count(),0);
 await open('/v2/food/subscription-invoice?invoiceId=UI-INVOICE');await page.getByRole('heading',{name:'UAT-FOOD-001',exact:true}).waitFor();assert.match(await page.locator('main').innerText(),/1,300/);assert.match(await page.locator('main').innerText(),/configuration_pending/);await shot('food-invoice');
});
await check('Food management: cancellation stays request-only and dispatched orders remain blocked',async()=>{
 foodFulfilment='reserved';await open('/v2/food/manage?orderId=UI-FOOD-ORDER');await page.getByRole('button',{name:'Request Finance review',exact:true}).click();await page.getByText(/Cancellation request requested/).waitFor();
 assert.deepEqual(writes.filter(w=>w.path==='/api/food-finance').at(-1).body,{orderId:'UI-FOOD-ORDER',action:'request_cancel',reason:'Order no longer needed',idempotencyKey:'food-cancel:UI-FOOD-ORDER:order no longer needed'});
 foodFulfilment='dispatched';const before=writes.length;await open('/v2/food/manage?orderId=UI-FOOD-ORDER');const cancel=page.getByRole('button',{name:'Request Finance review',exact:true});await cancel.waitFor();assert.equal(await cancel.isDisabled(),true);assert.equal(writes.length,before);await shot('food-dispatched-management');foodFulfilment='reserved';
});

await check('Appearance controls: chosen palette and display persist through real V2 navigation and reload',async()=>{
 identity='customer';accountDenied=false;await page.setViewportSize({width:1440,height:1000});await open('/v2/relocation');
 await page.getByRole('button',{name:'Change PawSpace appearance',exact:true}).click();
 await page.locator('input[name="paw-theme"][value="signature"]').check();await page.getByLabel('dark',{exact:true}).check();
 await page.getByRole('button',{name:'Done',exact:true}).click();
 assert.equal(await page.locator('html').getAttribute('data-paw-theme'),'signature');assert.equal(await page.locator('html').getAttribute('data-paw-mode'),'dark');
 await page.getByRole('link',{name:'Home',exact:true}).click();await page.locator('a[href="/v2/food"]').first().click();
 await page.getByRole('heading',{name:'Server-owned UAT catalogue',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/v2/food');
 assert.equal((await style(page.locator('main').first())).primary,'#d3b8ff');
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(500);assert.equal((await style(page.locator('main').first())).primary,'#d3b8ff');
 await page.getByRole('button',{name:'Change PawSpace appearance',exact:true}).click();await page.locator('input[name="paw-theme"][value="emerald"]').check();await page.getByLabel('light',{exact:true}).check();await page.getByRole('button',{name:'Done',exact:true}).click();
 assert.equal((await style(page.locator('main').first())).primary,'#01261f');await shot('food-real-appearance-control');
});

}
if(runMode==='appearance')account.pets=[foodPet];
assert.ok(['all','workflows','appearance'].includes(runMode),'Invalid UI_TEST_MODE');
assert.ok(!batch||/^(1440|390):(emerald|signature):(light|dark)$/.test(batch),'Invalid UI_THEME_BATCH');
const paths=['/v2/funeral-memorial','/v2','/v2/account','/v2/activity','/v2/chat','/v2/grooming','/v2/training','/v2/boarding','/v2/sitting','/v2/taxi','/v2/walking','/v2/food','/v2/relocation','/v2/partner','/partner','/v2/booking','/v2/booking-confirmation','/v2/boarding/manage','/v2/sitting/manage','/v2/grooming/manage','/v2/taxi/manage','/v2/walking/manage','/v2/food/manage?orderId=UI-FOOD-ORDER','/v2/food/subscriptions?subscriptionId=UI-FOOD-SUB','/v2/food/subscription-payment?renewalId=UI-RENEWAL','/v2/food/subscription-invoice?invoiceId=UI-INVOICE'];
const themeMetrics=[];
for(const width of [1440,390])for(const theme of ['emerald','signature'])for(const mode of ['light','dark'])for(const path of paths)if(runMode!=='workflows'&&(!batch||batch===width+':'+theme+':'+mode))await check('Appearance '+width+' '+theme+'/'+mode+' '+path,async()=>{
 identity=path.includes('partner')?'provider':'customer';providerSignedIn=false;await page.setViewportSize({width,height:1000});await open(path);await palette(theme,mode);
 await overflow();assert.equal(await page.locator('[data-staff-workspace]').count(),0);
 const main=page.locator('main').first();await main.waitFor();const s=await style(main);themeMetrics.push({path,width,theme,mode,...s});assert.match(s.family,/PawSpaceNunito/,'Font '+JSON.stringify(s));
 const expected=mode==='dark'?(theme==='signature'?'#d3b8ff':'#c2e6d1'):(theme==='signature'?'#894aed':'#01261f');assert.equal(s.primary,expected,'Palette '+path);
 const h=page.locator('main h1').first();if(await h.count()){const x=await style(h);assert.ok(x.font>=24,'Heading '+JSON.stringify(x));assert.ok(contrast(x.fg,x.bg)>=3,'Heading contrast '+JSON.stringify(x));}
 if(path==='/v2/food'){const selected=page.getByRole('button',{name:'Single order',exact:true});const b=await style(selected);assert.ok(b.font>=16);assert.ok(contrast(b.fg,b.bg)>=4.5,JSON.stringify(b));await shot('food-'+width+'-'+theme+'-'+mode);}
 if(path==='/v2/relocation'){
  const b=await style(page.getByRole('button',{name:'Create relocation inquiry',exact:true}));assert.ok(b.font>=16);assert.ok(contrast(b.fg,b.bg)>=4.5,JSON.stringify(b));
  const labels=page.locator('section').filter({has:page.locator('input[type="date"]')}).locator('label');assert.equal(await labels.count(),11);const columns=await labels.evaluateAll(nodes=>nodes.slice(0,2).map(n=>Math.round(n.getBoundingClientRect().x)));assert.equal(columns[0]===columns[1],width===390);await shot('relocation-'+width+'-'+theme+'-'+mode);
 }else if(width===1440&&['/v2','/v2/partner','/partner'].includes(path))await shot(path.replaceAll('/','_')+'-'+theme+'-'+mode);
});

await check('No unhandled browser errors',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible Chromium; all API responses are synthetic and all external requests blocked',runMode,batch,completed:true,results,themeMetrics,reads,writes,blocked,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
