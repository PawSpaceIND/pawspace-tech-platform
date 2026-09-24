/** Visible loopback UI tests; every API is intercepted and no real mutation is sent. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('Loopback only.');
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/phase5';fs.mkdirSync(OUT+'/screens',{recursive:true});
const executablePath=process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium':undefined);
const browser=await chromium.launch({headless:process.env.STAFF_UI_HEADLESS==='1',executablePath,slowMo:Number(process.env.STAFF_UI_SLOW_MS||100)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(15000);
const results=[],reads=[],writes=[],external=[],pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
let role='founder',denyOverview=false,denyCrm=false,denySave=false,integrationState='code_ready';
const permissions={founder:['*'],finance:['finance.view','payroll.view','reports.view','audit.view'],sales:['customers.view','communications.manage','bookings.view']};
const overview=()=>({data:{actor:{name:'UI Fixture '+role,email:role+'@example.test',roleCode:role,permissions:permissions[role]}}});
let contacts=[{id:'UI-CRM-1',name:'Asha Fixture',primary_phone:'9000000001',pet_names:'Milo',stage:'Follow-up',owner:'UI Sales',lifetime_value:5400,lifetime_value_basis:'recognized_bookings',latest_booking_id:'UI-BOOKING-1'}];
const item=()=>({integrationCode:'UI-INT-1',category:'communications',capability:'Fixture channel',provider:'Synthetic provider',owner:'UI Ops',priority:'P0',required:true,environment:'sandbox',codeBoundaryStatus:'code_ready',credentialStatus:'not_configured',readinessState:integrationState,evidenceReference:null,blockerReason:'No live service',updatedAt:Date.now()});
const readiness=()=>({data:{items:[item()],summary:{total:1,required:1,p0Required:1,p0ControlledLive:0,controlledLiveVerified:0},productionReady:false},blockers:[item()],uatSandbox:{status:'sandbox_setup_required',configuredForExternalTest:false,sandboxEvidenceVerified:false,syntheticLogicReady:true,productionEnabled:false,modules:[]},productionReady:false});
const tower={data:{date:'2026-09-24',timezone:'Asia/Kolkata',headline:{signalsTracked:4,signalsClear:3,needsAttention:1,openItems:1},signals:[{code:'UI-SIGNAL',severity:'attention',label:'Fixture approval needed',detail:'Synthetic review only',count:1,view:'approvals'}],posture:[],recentChanges:[],sourceStatus:{}}};
const customer={id:'UI-CRM-1',name:'Asha Fixture',primaryPhone:'9000000001',pets:[{sourceId:'Milo',canonicalId:'UI-PET-1',name:'Milo',species:'dog'}]};
const assisted={data:{environment:'UAT',testOnly:true,liveMoney:false,serviceCode:'grooming',customers:[customer],packages:[{code:'UI-BATH',name:'Fixture Bath',eligiblePetTypes:['dog'],singlePrice:1350,multiPetPrice:1200,version:'ui-fixture'}]}};
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async route=>{
 const request=route.request(),u=new URL(request.url());
 if(u.origin!==ORIGIN){external.push(u.origin+u.pathname);return route.abort();}
 if(!u.pathname.startsWith('/api/'))return route.continue();
 if(request.method()!=='GET'){
  const body=request.postDataJSON();writes.push({path:u.pathname,method:request.method(),body});
  if(u.pathname==='/api/crm'){
   if(denySave)return json(route,{error:'Fixture lead save denied'},403);
   const id='UI-CRM-NEW';contacts.unshift({id,name:body.name,primary_phone:body.primaryPhone,pet_names:body.petNames,stage:'New lead'});return json(route,{id,assignedOwner:'UI Sales',whatsappAi:{status:'blocked'}});
  }
  if(u.pathname==='/api/integration-readiness'){integrationState=body.changes.readinessState;return json(route,{data:{updated:true}});}
  if(u.pathname==='/api/assisted-orders')return json(route,{data:{assistedOrderId:'UI-ORDER',bookingId:'UI-BOOKING-NEW',customerId:body.customer.id,scheduleGroupId:'UI-SCHEDULE',provider:{id:'UI-PROVIDER',name:'Fixture Provider',model:'full_time'},totalAmount:1350,amountDueNow:0,status:'confirmed',duplicatePrevented:false,testOnly:true,liveMoney:false}});
  return json(route,{error:'No fixture mutation configured; not sent'},409);
 }
 reads.push(u.pathname+u.search);
 if(u.pathname==='/api/team-overview')return denyOverview?json(route,{error:'Fixture navigation unavailable'},503):json(route,overview());
 if(u.pathname==='/api/crm')return denyCrm?json(route,{error:'Fixture CRM access denied'},403):json(route,{contacts:u.searchParams.has('search')?[{...contacts[0],name:'A***',primary_phone:'Masked'}]:contacts});
 if(u.pathname==='/api/control-tower')return json(route,tower);
 if(u.pathname==='/api/integration-readiness')return json(route,readiness());
 if(u.pathname==='/api/assisted-orders')return json(route,assisted);
 if(u.pathname==='/api/customer-360')return json(route,{data:{records:[{customerId:customer.id,name:customer.name,primaryPhone:customer.primaryPhone,pets:customer.pets.map(p=>({...p,id:p.canonicalId}))}]}});
 if(u.pathname==='/api/provider-onboarding-configuration')return json(route,{data:{policies:[],locales:[],content:[],productionReady:false}});
 return json(route,{error:'Fixture: unconfigured endpoint, not certified'},503);
});
const wait=ms=>page.waitForTimeout(ms);
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-module]').waitFor();await page.evaluate(()=>document.fonts.ready);await wait(450);await page.evaluate(()=>document.title='PawSpace - SYNTHETIC UI CHECK - NO LIVE ACTIONS');}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await shot('failure-'+results.length).catch(()=>{});}}
async function noOverflow(){const m=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(m.sw<=m.w+1,JSON.stringify(m));}
const lastWrite=p=>writes.filter(w=>w.path===p).at(-1)?.body;
async function contextLinks(){const d=page.locator('details[data-staff-context]').first();if(await d.count()&&!await d.evaluate(e=>e.open))await d.locator('summary').click();}
await check('CRM: one staff frame, existing record and customer-ID booking handoff',async()=>{
 await open('/crm');await page.getByRole('heading',{name:'Asha Fixture',exact:true}).waitFor();assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 assert.equal(await page.getByRole('link',{name:'Book this customer'}).getAttribute('href'),'/assisted-booking?customerId=UI-CRM-1');await shot('crm-populated');
});
await check('CRM: original local views still mount and return without losing the customer',async()=>{
 await contextLinks();await page.getByRole('button',{name:'Revenue & CX engine'}).click();await page.getByRole('heading',{level:1,name:'Revenue & CX engine'}).waitFor();
 await page.getByRole('button',{name:'WhatsApp Live Chat'}).click();await page.getByRole('heading',{level:1,name:'WhatsApp Live Chat'}).waitFor();
 await page.getByRole('button',{name:'Customers & pets'}).click();await page.getByRole('heading',{name:'Asha Fixture',exact:true}).waitFor();
});
await check('CRM: server search preserves masked API results',async()=>{
 await page.getByPlaceholder('Search customer, phone or pet').fill('original-name');await wait(800);assert.ok(reads.includes('/api/crm?search=original-name'));assert.ok((await page.locator('main').innerText()).includes('A***'));
 await page.getByPlaceholder('Search customer, phone or pet').fill('');await wait(700);
});
await check('CRM lead: failed save stays in form; successful save retains explicit consent payload',async()=>{
 await page.getByRole('button',{name:'Add lead'}).click();const form=page.locator('form').filter({has:page.locator('input[name="name"]')});
 await form.locator('input[name="name"]').fill('UI New Lead');await form.locator('input[name="phone"]').fill('9000000002');await form.locator('input[name="pet"]').fill('Bruno');await form.locator('select[name="service"]').selectOption({label:'Dog Training'});
 await form.locator('input[name="whatsappConsent"]').check();await form.locator('input[name="whatsappConsentEvidence"]').fill('UI evidence only');denySave=true;
 await form.getByRole('button',{name:'Save lead & create follow-up'}).click();await form.getByRole('alert').waitFor();assert.ok(await form.isVisible());denySave=false;
 await form.getByRole('button',{name:'Save lead & create follow-up'}).click();await page.getByRole('heading',{name:'UI New Lead',exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/crm'),{name:'UI New Lead',primaryPhone:'9000000002',petNames:'Bruno',service:'Dog Training',source:'Manual CRM',stage:'New lead',whatsappConsent:true,whatsappConsentSource:'staff_recorded_customer_request',whatsappConsentEvidence:'UI evidence only'});
});
await check('Control: preserved metrics, original local permissions and all section switches',async()=>{
 role='founder';await open('/control');await page.getByRole('heading',{name:'Control tower',exact:true}).waitFor();await contextLinks();
 const buttons=page.locator('details[data-staff-context] nav button');const labels=await buttons.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')));assert.equal(labels.length,23);
 for(const label of labels){await page.locator('details[data-staff-context]').getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{level:1,name:label,exact:true}).waitFor();await wait(150);}
 await page.getByRole('button',{name:'Control tower',exact:true}).click();await shot('control-populated');
});
await check('Control: finance role retains only its existing permitted local sections',async()=>{
 role='finance';await open('/control');await contextLinks();assert.equal(await page.getByRole('button',{name:'Users, roles & access',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Master settings',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Finance, expenses & accounts',exact:true}).count(),1);role='founder';
});
await check('Integration register: required reason and original PATCH contract',async()=>{
 await open('/control/integrations');await page.getByRole('button',{name:'Update',exact:true}).click();await page.getByRole('button',{name:'Save governed change',exact:true}).click();await page.getByText('A governed change reason is required',{exact:true}).waitFor();
 await page.getByRole('combobox',{name:'New state',exact:true}).selectOption('sandbox_ready_for_test');await page.getByLabel('Evidence reference',{exact:true}).fill('UI evidence');await page.getByLabel('Change reason',{exact:true}).fill('UI review only');await page.getByRole('button',{name:'Save governed change',exact:true}).click();await page.getByRole('button',{name:'Update',exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/integration-readiness'),{integrationCode:'UI-INT-1',changes:{readinessState:'sandbox_ready_for_test',evidenceReference:'UI evidence'},reason:'UI review only'});await shot('integrations-populated');
});
await check('Assisted booking: customer deep link, consent gate and original order payload',async()=>{
 await open('/assisted-booking?customerId=UI-CRM-1');await page.getByRole('heading',{name:'Book the selected CRM customer',exact:true}).waitFor();
 const form=page.locator('form').filter({has:page.locator('input[type="datetime-local"]')});const submit=form.getByRole('button',{name:'Create CRM-assisted UAT order',exact:true});await submit.waitFor();
 const consent=form.locator('input[type="checkbox"]');await consent.uncheck();assert.equal(await submit.isDisabled(),true);await consent.check();
 await form.getByLabel('Start',{exact:true}).fill('2026-09-29T10:00');await form.getByLabel('End',{exact:true}).fill('2026-09-29T12:00');await submit.click();await page.getByRole('heading',{name:'UI-BOOKING-NEW',exact:true}).waitFor();
 const b=lastWrite('/api/assisted-orders');assert.equal(b.customer.id,'UI-CRM-1');assert.equal(b.pets[0].canonicalId,'UI-PET-1');assert.equal(b.packageCode,'UI-BATH');assert.equal(b.consent.captured,true);assert.equal(b.cityId,'blr');assert.ok(b.idempotencyKey);assert.equal(b.price,undefined);await shot('assisted-created-fixture');
});
const paths=['/crm','/control','/control/appearance','/control/integrations','/control/provider-onboarding','/assisted-booking','/system-integration'];
function contrast(fg,bg){const l=s=>{const v=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];};const a=l(fg),b=l(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
for(const path of ['/crm','/control','/control/integrations','/assisted-booking'])for(const theme of ['emerald','signature'])for(const mode of ['light','dark'])await check('Theme '+theme+'/'+mode+' '+path,async()=>{
 await open(path);await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await wait(500);
 const root=page.locator('[data-staff-module]');assert.match(await root.evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);
 const heading=page.locator('h1').first();await heading.waitFor();const style=await heading.evaluate(e=>{let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;const s=getComputedStyle(e);return {fg:s.color,bg:getComputedStyle(p).backgroundColor,size:parseFloat(s.fontSize)};});assert.ok(style.size>=24);assert.ok(contrast(style.fg,style.bg)>=4.5,JSON.stringify(style));await noOverflow();await shot(path.replaceAll('/','_')+'-'+theme+'-'+mode);
});
for(const width of [1440,1280,390])for(const path of paths)await check('Responsive '+width+' '+path+' (fixture/unavailable boundary)',async()=>{
 await page.setViewportSize({width,height:1000});await open(path);await noOverflow();assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 if(await page.locator('details[data-staff-context]').count()){await contextLinks();await noOverflow();await page.locator('details[data-staff-context]>summary').first().click();}
 if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
 await shot(path.replaceAll('/','_')+'-'+width);
});
await check('CRM alias preserves the same scoped component without duplicate navigation',async()=>{await open('/v2/crm');assert.equal(await page.locator('[data-staff-workspace]').count(),1);await page.getByRole('heading',{level:1,name:'Customers & pets'}).waitFor();});
await check('V2 hub opens the shared CRM and browser Back keeps the V2 hub',async()=>{
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(ORIGIN+'/v2/workspaces',{waitUntil:'domcontentloaded'});
 await page.getByRole('heading',{name:'One build. Every workspace.',exact:true}).waitFor();
 const crm=page.getByRole('link',{name:/Customer & Revenue CRM/});
 assert.equal(await crm.getAttribute('href'),'/v2/crm');await crm.click();
 await page.waitForURL(ORIGIN+'/v2/crm');
 await page.getByRole('heading',{level:1,name:'Customers & pets',exact:true}).waitFor();
 assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 assert.equal(await page.getByRole('link',{name:'Book this customer'}).getAttribute('href'),'/assisted-booking?customerId=UI-CRM-NEW');
 await wait(500);await shot('v2-crm-shared-workspace');
 await page.goBack({waitUntil:'domcontentloaded'});await page.waitForURL(ORIGIN+'/v2/workspaces');
 await page.getByRole('heading',{name:'One build. Every workspace.',exact:true}).waitFor();
});
await check('V2 hub opens the shared Booking Command Center without changing its URL',async()=>{
 const booking=page.getByRole('link',{name:/Booking Command Center/});
 assert.equal(await booking.getAttribute('href'),'/v2/control-center');await booking.click();
 await page.waitForURL(ORIGIN+'/v2/control-center');
 await page.getByRole('heading',{level:1,name:'Booking Command Center',exact:true}).waitFor();
 assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 const retry=page.getByRole('button',{name:'Try again',exact:true});await retry.waitFor();
 assert.match(await retry.locator('..').innerText(),/Fixture: unconfigured endpoint, not certified/);
 const requestCount=reads.filter(path=>path.startsWith('/api/booking-command-center')).length;assert.ok(requestCount>0);
 await retry.click();await retry.waitFor();assert.ok(reads.filter(path=>path.startsWith('/api/booking-command-center')).length>requestCount);
 await wait(500);await shot('v2-control-center-shared-workspace');
});
await check('Access failure does not grant permissions or hide the CRM error',async()=>{denyCrm=true;denyOverview=true;await open('/crm');await page.getByRole('alert').filter({hasText:'Fixture CRM access denied'}).waitFor();assert.equal(await page.locator('nav[aria-label="Staff workspaces"] details').count(),0);denyCrm=false;denyOverview=false;});
await check('Customer and partner remain outside the staff frame',async()=>{for(const p of ['/v2','/partner-app']){await page.goto(ORIGIN+p,{waitUntil:'domcontentloaded'});await wait(400);assert.equal(await page.locator('[data-staff-module]').count(),0);}});
await check('No unhandled browser exceptions',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible synthetic loopback UI, all API calls intercepted; not authenticated backend certification',results,reads,writes,external,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
