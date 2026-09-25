/** Local visible fixtures only; no hosted identity or real provider action is certified. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
assert.ok(['127.0.0.1','localhost'].includes(new URL(ORIGIN).hostname));
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/partner-services-20260925/browser';
fs.mkdirSync(OUT+'/screens',{recursive:true});
const browser=await chromium.launch({headless:false,slowMo:70,args:['--remote-debugging-port=9231','--remote-debugging-address=127.0.0.1'],executablePath:process.env.STAFF_UI_CHROMIUM_PATH||process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();
page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(25000);
const results=[],reads=[],writes=[],pageErrors=[],external=[];page.on('pageerror',e=>pageErrors.push(String(e)));
const mode=process.env.PARTNER_UI_MODE||'all',batch=process.env.PARTNER_UI_BATCH||'';
function persist(completed=false){fs.writeFileSync(OUT+'/results.json',JSON.stringify({boundary:'Visible local Chromium; all APIs intercepted',mode,batch,completed,results,reads,writes,pageErrors,external},null,2));}
process.on('SIGTERM',async()=>{persist();await browser.close();process.exit(143);});
async function check(name,fn){const s=fs.statfsSync('.');if(s.bavail*s.bsize<180*1024*1024){persist();await browser.close();throw new Error('Stopped for local disk-space safety; incomplete evidence retained.');}try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await page.screenshot({path:OUT+'/screens/fail-'+results.length+'.png'}).catch(()=>{});}persist();}
const json=(r,data,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
let authorized=true,ratesDenied=false,actionDenied=true,trainerState='scheduled',sitterState='confirmed';
const when=new Date(Date.now()+86400000).toISOString(),end=new Date(Date.now()+2*86400000).toISOString();
const feedJob={bookingId:'UI-BOARDING',serviceCode:'boarding',packageName:'Fixture overnight stay',scheduledStart:when,scheduledEnd:end,petCount:1,status:'awaiting_host_acceptance',customerFirstName:'Fixture',group:'needsAction',needsActionReason:null,stayId:'UI-STAY',carePlanStatus:null,nextSlotStart:null,addOns:[],safetyRequirements:[]};
const training=()=>({id:'UI-SESSION',programme_id:'UI-PROGRAMME',booking_id:'UI-TRAIN',sequence_no:1,provider_id:'UI-PROVIDER',scheduled_start:when,scheduled_end:end,status:trainerState,customer_id:'UI-CUSTOMER',customer_name:'Fixture Customer',plan_code:'fixture',plan_name:'Fixture training plan',total_sessions:4,completed_sessions:0,no_show_sessions:0,cancelled_sessions:0,programme_status:'active',petIds:['UI-PET'],requirements:['Recall'],attendance:{},homework:{},progress:{},evidenceRefs:[],ownerHandover:null,events:[]});
const taxi=()=>({id:'UI-TAXI',status:'confirmed',trip_status:'awaiting_acceptance',provider_id:'UI-PROVIDER',provider_name:'Fixture Driver',origin_label:'Fixture Pickup',destination_label:'Fixture Dropoff',scheduled_start:when,reserved_vehicle_id:'UI-VEHICLE',events:[]});
const workspace={linked:true,engagement:'commission',onboardingStatus:'active',bookings:{today:[],upcoming:[],past:[],paymentPending:[]},liveAssignments:[{bookingId:'UI-OFFER',serviceCode:'boarding',package:'Fixture stay',start:when,orderValue:1350}],earnings:{visible:true,netPayout:945,orders:1,grossOrderValue:1350,commissionOrders:[],payouts:[]},pendingProof:[]};
let savedRate=1000;
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url());
 if(url.origin!==ORIGIN){external.push(url.origin+url.pathname);return route.abort();}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 const method=req.method(),body=method!=='GET'&&req.postData()?req.postDataJSON():null;
 if(method!=='GET'){
  writes.push({path:url.pathname,method,body});
  if(url.pathname==='/api/provider-service-rates'&&!actionDenied){savedRate=body.rate;return json(route,{data:{}});}
  return json(route,{error:'Fixture provider action refused; no operational change.'},403);
 }
 reads.push(url.pathname+url.search);
 if(!authorized)return json(route,{error:'Fixture provider sign-in required.'},401);
 if(url.pathname==='/api/identity-session')return json(route,{data:{subjectType:'provider',subjectId:'UI-PROVIDER',roleCode:'service_provider'}});
 if(url.pathname==='/api/provider-service-rates')return ratesDenied?json(route,{error:'Permission denied'},403):json(route,{data:{options:[{serviceCode:'boarding',packageCode:'UI-PACKAGE',name:'Fixture Boarding',floorPrice:1000,cityId:'blr',zoneId:'UI-ZONE'}],rates:[{serviceCode:'boarding',packageCode:'UI-PACKAGE',cityId:'blr',zoneId:'UI-ZONE',rate:savedRate}]}});
 if(url.pathname==='/api/partner-job-feed')return json(route,{data:{providerId:'UI-PROVIDER',needsAction:[feedJob],today:[],upcoming:[],completed:[],counts:{needsAction:1,today:0,upcoming:0,completed:0,total:1}}});
 if(url.pathname==='/api/provider-workspace')return json(route,{data:workspace});
 if(url.pathname==='/api/taxi-lifecycle')return json(route,{data:[taxi()]});
 if(url.pathname==='/api/taxi-proof')return json(route,{data:{bookingId:'UI-TAXI',tripId:'UI-TRIP',providerId:'UI-PROVIDER',customerId:'UI-CUSTOMER',status:'assigned',tripStatus:'assigned',media:[],routeSamples:[],incidents:[],routeEnvironment:'sandbox',productionGpsConnected:false,productionMapsVerified:false,communications:{},sandboxOnly:true}});
 if(url.pathname==='/api/sitting-lifecycle')return json(route,{data:[{id:'UI-SIT',provider_id:'UI-PROVIDER',customer_id:'UI-CUSTOMER',status:sitterState,scheduled_start:when,scheduled_end:end,events:[],carePlan:{status:'submitted',plan:{feeding:'Fixture food instructions',homeAccess:'Fixture access note'}}}]});
 if(url.pathname==='/api/training-sessions')return json(route,{data:[training()]});
 if(url.pathname==='/api/training-session-media')return json(route,{data:{sessionId:'UI-SESSION',assets:[]}});
 if(url.pathname==='/api/training-provider-earnings')return json(route,{data:{providerId:'UI-PROVIDER',earnings:[],payouts:[],livePayout:false,executionMode:'sandbox'}});
 if(url.pathname==='/api/boarding-stays')return json(route,{data:[],scope:{providerId:'UI-PROVIDER',cityId:'blr',zoneId:'UI-ZONE'}});
 if(url.pathname==='/api/provider-onboarding-self-service')return json(route,{data:{applications:[]}});
 return json(route,{error:'Unconfigured fixture; not a backend certificate.'},503);
});
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350);await page.evaluate(()=>document.title='PawSpace V2 - PARTNER UI FIXTURES - NO LIVE ACTIONS');}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function palette(theme,display){await page.evaluate(({theme,display})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',display);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,display});await page.waitForTimeout(100);}
if(mode!=='appearance'){
await check('Assigned jobs retain canonical workspace links and refused boarding accept/decline requests',async()=>{
 await open('/partner/jobs');const link=page.getByTestId('partner-workspace-UI-BOARDING');await link.waitFor();assert.equal(await link.getAttribute('href'),'/host?bookingId=UI-BOARDING');
 await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();
 const accept=writes.at(-1);assert.equal(accept.path,'/api/boarding-stays');assert.equal(accept.body.stayId,'UI-STAY');assert.equal(accept.body.action,'accept');assert.ok(accept.body.idempotencyKey);
 await page.getByRole('button',{name:'Decline',exact:true}).click();await page.waitForTimeout(150);assert.equal(writes.at(-1).body.action,'decline');assert.equal(writes.at(-1).body.reason,'Declined from partner job feed');await shot('assigned-jobs');
});
await check('Partner workspace preserves commission amounts and offer identifiers on refusal',async()=>{
 await open('/partner/workspace');await page.getByText('Commission earned (governed)',{exact:true}).waitFor();assert.match(await page.locator('main').innerText(),/945/);
 await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();assert.deepEqual(writes.at(-1).body,{action:'accept_job',bookingId:'UI-OFFER'});
 assert.equal(await page.getByRole('link',{name:'People, attendance & leave',exact:false}).count(),0);
});
await check('Provider rates retain price floor, saved amount and exact service/zone payload',async()=>{
 actionDenied=false;await open('/partner/rates');await page.getByRole('spinbutton').fill('999');assert.equal(await page.getByRole('button',{name:'Save rate',exact:true}).isDisabled(),true);
 await page.getByRole('spinbutton').fill('1450');await page.getByRole('button',{name:'Save rate',exact:true}).click();await page.getByText(/Fixture Boarding saved at/).waitFor();
 assert.deepEqual(writes.at(-1).body,{serviceCode:'boarding',packageCode:'UI-PACKAGE',cityId:'blr',zoneId:'UI-ZONE',rate:1450});actionDenied=true;await shot('provider-rates');
 ratesDenied=true;await open('/partner/rates');await page.getByText(/This page is for a signed-in commission/).waitFor();assert.equal(await page.getByRole('button',{name:'Save rate',exact:true}).count(),0);ratesDenied=false;
});
await check('Driver acceptance refusal keeps pickup locked and booking-ID proof handoff intact',async()=>{
 await open('/driver?bookingId=UI-TAXI');await page.getByRole('button',{name:'Accept trip',exact:true}).click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();
 assert.equal(writes.at(-1).body.bookingId,'UI-TAXI');assert.equal(writes.at(-1).body.action,'accept');assert.equal(await page.getByRole('button',{name:'Confirm owner pickup',exact:false}).isDisabled(),true);
 assert.equal(await page.getByRole('link',{name:'Route · proof · incident',exact:false}).getAttribute('href'),'/driver/proof?bookingId=UI-TAXI');await shot('driver-locked-actions');
});
await check('Driver proof still needs coordinates and incident description before submitting',async()=>{
 await open('/driver/proof?bookingId=UI-TAXI');const record=page.getByRole('button',{name:'Record sandbox location sample',exact:true});await record.waitFor();assert.equal(await record.isDisabled(),true);
 const incident=page.getByRole('button',{name:'Report governed incident',exact:true});assert.equal(await incident.isDisabled(),true);await page.getByPlaceholder('What happened?',{exact:true}).fill('Fixture incident only');await incident.click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();
 assert.equal(writes.at(-1).body.bookingId,'UI-TAXI');assert.equal(writes.at(-1).body.action,'report_incident');assert.equal(writes.at(-1).body.summary,'Fixture incident only');await shot('proof-incident');
});
await check('Sitter retains care instructions, pre-acceptance check-in lock and reason validation',async()=>{
 await open('/sitter?bookingId=UI-SIT');await page.getByText('Fixture food instructions',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Check in with my location',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Accept booking',exact:true}).click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();assert.equal(writes.at(-1).body.bookingId,'UI-SIT');assert.equal(writes.at(-1).body.action,'accept');
 assert.equal(await page.getByRole('button',{name:'Mark unavailable',exact:true}).isDisabled(),true);await page.getByLabel('Reason you are unavailable',{exact:true}).fill('Fixture unable to attend');await page.getByRole('button',{name:'Mark unavailable',exact:true}).click();await page.waitForTimeout(150);assert.equal(writes.at(-1).body.reason,'Fixture unable to attend');await shot('sitter-care');
});
await check('Trainer session identity and missing-proof completion guards remain intact',async()=>{
 trainerState='scheduled';await open('/trainer?bookingId=UI-TRAIN&sessionId=UI-SESSION');await page.getByRole('button',{name:'Accept',exact:true}).click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();assert.equal(writes.at(-1).body.sessionId,'UI-SESSION');assert.equal(writes.at(-1).body.action,'accept');
 trainerState='in_session';await open('/trainer?bookingId=UI-TRAIN&sessionId=UI-SESSION');const complete=page.getByRole('button',{name:'Complete & consume one session',exact:true});await complete.waitFor();assert.equal(await complete.isDisabled(),true);await page.getByLabel('Homework for pet parent',{exact:true}).fill('Fixture homework with enough detail');assert.equal(await complete.isDisabled(),true);await shot('trainer-proof-gate');trainerState='scheduled';
});
await check('Replacement recovery forwards the same booking and refuses without claiming acceptance',async()=>{
 for(const [path,label] of [['/walker/recovery?bookingId=UI-WALK','Accept remaining walk schedule'],['/driver/recovery?bookingId=UI-TAXI','Accept replacement Taxi trip']]){
  await open(path);const button=page.getByRole('button',{name:label,exact:true});await button.click();await page.getByText('Fixture provider action refused; no operational change.',{exact:true}).waitFor();assert.equal(writes.at(-1).body.bookingId,path.includes('walker')?'UI-WALK':'UI-TAXI');assert.ok(writes.at(-1).body.idempotencyKey);
 }
});
}
function contrast(a,b){const lum=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
async function style(locator){return locator.evaluate(e=>{const s=getComputedStyle(e);let n=e;while(n&&getComputedStyle(n).backgroundColor==='rgba(0, 0, 0, 0)')n=n.parentElement;return{family:s.fontFamily,size:parseFloat(s.fontSize),color:s.color,background:n?getComputedStyle(n).backgroundColor:'rgb(255,255,255)',primary:s.getPropertyValue('--brand-primary').trim()};});}
const manifest=JSON.parse(fs.readFileSync('tests/fixtures/partner-services-presentation-contract.json','utf8'));
const variants=[1440,390].flatMap(w=>['emerald','signature'].flatMap(t=>['light','dark'].map(m=>[w,t,m])));
assert.ok(!batch||variants.some(v=>v.join(':')===batch),'Unknown batch');
if(mode!=='workflows')for(const [width,theme,display] of variants.filter(v=>!batch||v.join(':')===batch))for(const path of manifest.routes)await check('Appearance '+width+' '+theme+'/'+display+' '+path,async()=>{
 authorized=true;await page.setViewportSize({width,height:1000});await open(path);await palette(theme,display);
 assert.equal(await page.locator('[data-partner-presentation]').count(),1);assert.equal(await page.locator('[data-staff-workspace]').count(),0);
 const s=await style(page.locator('main').first());assert.match(s.family,/PawSpaceNunito/);const expected=display==='dark'?(theme==='signature'?'#d3b8ff':'#c2e6d1'):(theme==='signature'?'#894aed':'#01261f');assert.equal(s.primary,expected);
 const h=page.locator('main h1').first();await h.waitFor();const hs=await style(h);assert.ok(hs.size>=24,JSON.stringify(hs));assert.ok(contrast(hs.color,hs.background)>=3,JSON.stringify(hs));
 const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));
 const controls=await page.locator('main button:visible').evaluateAll(nodes=>nodes.map(e=>({text:e.textContent?.slice(0,45),size:parseFloat(getComputedStyle(e).fontSize),height:e.getBoundingClientRect().height})));assert.ok(controls.every(x=>x.size>=14&&x.height>=40),JSON.stringify(controls));
 if(['/trainer','/partner/jobs','/partner/rates'].includes(path))await shot(path.replaceAll('/','_')+'-'+width+'-'+theme+'-'+display);
});
if(mode!=='appearance')await check('Customer V2 and main Partner entries remain outside the service workspace frame',async()=>{
 for(const path of ['/v2','/v2/food','/v2/partner','/partner']){
  await open(path);assert.equal(await page.locator('[data-partner-presentation]').count(),0,path);assert.equal(await page.locator('[data-staff-workspace]').count(),0,path);
 }
});
await check('No staff navigation request or unhandled browser errors',async()=>{
 assert.deepEqual(pageErrors,[]);assert.ok(!reads.some(path=>path.startsWith('/api/team-overview')));
});
const failed=results.filter(r=>r.status==='FAIL').length;
persist(true);console.log('TOTAL '+results.length+' PASS '+(results.length-failed)+' FAIL '+failed);
await context.close();await browser.close();process.exitCode=failed?1:0;
