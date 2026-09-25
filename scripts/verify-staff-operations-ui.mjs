/** Visible Chromium UI checks. Loopback only, all APIs intercepted; no real staff/provider/money mutations. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('UI fixtures are restricted to loopback.');
const OUT='.ui-audit/phase4';fs.mkdirSync(OUT+'/screens',{recursive:true});
const executablePath=process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?os.homedir()+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium':undefined);
const browser=await chromium.launch({headless:process.env.STAFF_UI_HEADED!=='1',executablePath,slowMo:Number(process.env.STAFF_UI_SLOW_MS||300)});
const context=await browser.newContext({viewport:{width:1440,height:950},serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(15000);
const results=[],reads=[],writes=[],external=[],pageErrors=[];let deny=false,completed=false,taskStatus='open',refuseReplacement=false;
page.on('pageerror',e=>pageErrors.push(String(e)));
const actor={name:'Observed UI Test',email:'ui@example.test',roleCode:'admin',permissions:['*']};
const overview={data:{actor,today:'2026-09-24',commandStrip:{revenueActions:0,firstResponseMinutes:null,openEscalations:0,openTickets:0,commandPackReports:0},workspaces:{}}};
const training=()=>({data:{source:'ui-fixture',liveMoney:false,metrics:{activeProgrammes:1,sessionsToday:2,openRecovery:0,paymentExceptions:0},trainers:[{id:'UI-TRAINER-2',name:'Fixture Replacement',model:'commission',rating:4.8,qualityScore:90,zones:['blr-south']}],programmes:[{id:'UI-PROG-1',booking_id:'UI-BOOKING-TRAIN',customer_name:'Training Fixture',plan_name:'Foundation Training',plan_code:'foundation',provider_id:'UI-TRAINER-1',zone_id:'blr-south',status:'active',total_sessions:2,completed_sessions:completed?1:0,no_show_sessions:0,cancelled_sessions:0,payment_status:'captured',payment_mode:'sandbox',amount_due_now:0,total_amount:5400,requirements:[],sessions:[{id:'UI-SESSION-1',sequence_no:1,provider_id:'UI-TRAINER-1',scheduled_start:'2026-09-29T09:30:00Z',scheduled_end:'2026-09-29T10:30:00Z',status:completed?'completed':'scheduled'}],recoveries:[]}]}});
const boarding=()=>({data:{source:'ui-fixture',generatedAt:Date.now(),metrics:{total:1,clear:0,needsAttention:1,recovery:1,openIncidents:0,financeReview:0,mediaBlocked:0},stays:[{id:'UI-STAY-1',booking_id:'UI-BOOKING-STAY',customer_id:'UI-CUS-1',customer_name:'Boarding Fixture',host_provider_id:'UI-HOST-1',provider_name:'Original Fixture Host',status:'recovery_required',booking_status:'confirmed',payment_status:'captured',package_name:'Home boarding',check_in_at:'2026-09-29T09:00:00Z',check_out_at:'2026-10-01T09:00:00Z',priority:'high',exceptionFlags:['host_recovery'],replacementCandidates:[{providerId:'UI-HOST-2',name:'Fixture Replacement Host',area:'HSR',model:'commission',rating:4.8,qualityScore:90,maxGuestPets:3,availableGuestPets:2,oneFamilyOnly:false,medicationSupport:true}],incidents:[],refunds:[],media:[],notes:[]}],readiness:{engineeringGate:'uat',productionReady:false,externalDependencies:{}}}});
const task=()=>({id:'UI-TASK-1',rule:'unassigned_work_order',queue:'operations',priority:'critical',title:'Fixture assignment needs review',status:taskStatus,owner:null,due_at:Date.now()+60000,escalated:0,booking_id:'UI-WORK-BOOKING',customer_id:'UI-CUS-1',provider_id:null});
const workqueue=()=>({data:{generatedAt:Date.now(),metrics:{total:1,open:1,escalated:0,critical:1,resolvedToday:0},queues:{operations:{open:1,escalated:0,tasks:[task()]}},commandCentre:{available:false}}});
const json=(route,data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());if(url.origin!==ORIGIN){external.push(url.origin+url.pathname);return route.abort();}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 if(request.method()!=='GET'){const body=request.postDataJSON();writes.push({path:url.pathname,method:request.method(),body});
  if(url.pathname==='/api/training-sessions')return json(route,{data:{status:'recorded_ui_fixture'}});
  if(url.pathname==='/api/boarding-ops')return refuseReplacement?json(route,{error:'Fixture replacement refused by server'},409):json(route,{data:{status:'offered_ui_fixture'}});
  if(url.pathname==='/api/ops-work-queue'){taskStatus=body.action==='claim'?'acknowledged':body.action==='resolve'?'resolved':taskStatus;return json(route,{data:{status:taskStatus}});}
  return json(route,{error:'Mutation is not configured in this synthetic test'},409);
 }
 reads.push(url.pathname+url.search);
 if(url.pathname==='/api/team-overview')return json(route,overview);
 if(url.pathname==='/api/training-ops')return deny?json(route,{error:'Fixture training access denied'},403):json(route,training());
 if(url.pathname==='/api/boarding-ops')return json(route,boarding());
 if(url.pathname==='/api/ops-work-queue')return json(route,workqueue());
 return json(route,{error:'Synthetic UI check: this API has no configured fixture'},503);
});
const delay=ms=>page.waitForTimeout(ms),lastWrite=p=>writes.filter(w=>w.path===p).at(-1)?.body;
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-module]').waitFor();await page.evaluate(()=>document.fonts.ready);await delay(500);await page.bringToFront();await page.evaluate(()=>{document.title='PawSpace | VISIBLE SYNTHETIC UI CHECK';});}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await shot('failure-'+results.length).catch(()=>{});}}
async function noOverflow(){const r=await page.evaluate(()=>({view:innerWidth,width:document.documentElement.scrollWidth}));assert.ok(r.width<=r.view+1,JSON.stringify(r));}
await check('Training: populated programme, session and original recovery actions',async()=>{
 await open('/team/operations/training');await page.getByRole('button',{name:'Reschedule',exact:true}).waitFor();await shot('training-populated');await delay(1800);
 assert.equal(await page.getByRole('button',{name:'Reschedule',exact:true}).isEnabled(),true);assert.match(await page.locator('main').innerText(),/UI-BOOKING-TRAIN/);
});
await check('Training: reschedule retains session, duration and idempotency key',async()=>{
 page.once('dialog',d=>d.accept('2026-09-30T09:30:00Z'));await page.getByRole('button',{name:'Reschedule',exact:true}).click();await delay(650);
 const b=lastWrite('/api/training-sessions');assert.equal(b.sessionId,'UI-SESSION-1');assert.equal(b.action,'reschedule');assert.equal(b.newStart,'2026-09-30T09:30:00.000Z');assert.equal(b.newEnd,'2026-09-30T10:30:00.000Z');assert.match(b.idempotencyKey,/^ops:reschedule:UI-SESSION-1:/);
});
await check('Training: completed session still disables all four recovery actions',async()=>{
 completed=true;await open('/team/operations/training');for(const name of ['Reschedule','Replace trainer','No-show','Cancel session'])assert.equal(await page.getByRole('button',{name,exact:true}).isDisabled(),true);completed=false;
});
await check('Training: access error keeps Retry and never renders another programme',async()=>{
 deny=true;await open('/team/operations/training');await page.getByText('Fixture training access denied',{exact:true}).waitFor();assert.equal(await page.getByText('UI-BOOKING-TRAIN',{exact:true}).count(),0);await page.getByRole('button',{name:'Retry',exact:true}).waitFor();deny=false;
});
await check('Boarding: same stay and provider in replacement request; refusal stays visible',async()=>{
 await open('/team/operations/boarding');await page.getByRole('button',{name:'Offer replacement',exact:true}).waitFor();await shot('boarding-populated');refuseReplacement=true;await page.getByRole('button',{name:'Offer replacement',exact:true}).click();await page.getByRole('alert').filter({hasText:'Fixture replacement refused by server'}).waitFor();
 const b=lastWrite('/api/boarding-ops');assert.equal(b.stayId,'UI-STAY-1');assert.equal(b.providerId,'UI-HOST-2');assert.equal(b.action,'assign_replacement');assert.equal(b.idempotencyKey,'boarding:UI-STAY-1:ops:assign_replacement:UI-HOST-2');refuseReplacement=false;
});
await check('Work queue: note gates, Claim and Resolve preserve task identity',async()=>{
 await open('/team/operations/work-queue');await page.getByRole('button',{name:'Claim',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Resolve',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Claim',exact:true}).click();await delay(500);assert.deepEqual(lastWrite('/api/ops-work-queue'),{action:'claim',taskId:'UI-TASK-1',note:''});
 await page.getByPlaceholder('Resolution / dismissal / progress note',{exact:true}).fill('UI fixture reviewed');await page.getByRole('button',{name:'Resolve',exact:true}).click();await delay(500);
 assert.deepEqual(lastWrite('/api/ops-work-queue'),{action:'resolve',taskId:'UI-TASK-1',note:'UI fixture reviewed'});taskStatus='open';
});
for(const theme of ['emerald','signature'])for(const mode of ['light','dark']){
 await check('Training theme '+theme+'/'+mode+' and readable operational text',async()=>{
  await open('/team/operations/training');await page.getByRole('button',{name:'Reschedule',exact:true}).waitFor();await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await delay(600);
  const styles=await page.getByRole('button',{name:'Refresh',exact:true}).evaluate(e=>{const s=getComputedStyle(e);return {font:parseFloat(s.fontSize),family:s.fontFamily,height:e.getBoundingClientRect().height};});
  assert.ok(styles.font>=14,JSON.stringify(styles));assert.ok(styles.height>=42);assert.match(styles.family,/PawSpaceStaffNunito/);await shot('training-'+theme+'-'+mode);
 });
}
const paths=JSON.parse(fs.readFileSync('tests/fixtures/staff-operations-contract.json','utf8')).pages.map(p=>p.replace(/^app/,''));
for(const width of [1440,1280,390])for(const path of paths){
 await check('Responsive '+width+' '+path+' (populated or unavailable fixture)',async()=>{
  await page.setViewportSize({width,height:950});await open(path);await noOverflow();assert.equal(await page.locator('[data-staff-workspace]').count(),1);
  if(path.endsWith('/training')){for(const label of ['Active programmes','Sessions today','Open recovery cases','Payment exceptions'])assert.ok(await page.getByText(label,{exact:true}).isVisible());}
  if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
  await shot(path.replaceAll('/','_')+'-'+width);
 });
}
await check('Customer V2 still has no staff frame',async()=>{await page.goto(ORIGIN+'/v2',{waitUntil:'domcontentloaded'});await delay(500);assert.equal(await page.locator('[data-staff-workspace]').count(),0);});
await check('No browser application exceptions',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible Chromium; synthetic loopback fixtures; no authenticated backend/provider certification',results,reads,writes,external,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
