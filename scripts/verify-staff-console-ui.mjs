/** Isolated Chromium UI regression: loopback only; every API intercepted, no real deliveries or accounts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('Fixture tests are loopback-only.');
const OUT='.ui-audit/phase2';fs.mkdirSync(OUT+'/screens',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(12000);
const results=[],reads=[],writes=[],external=[],pageErrors=[];
page.on('pageerror',e=>pageErrors.push(String(e)));
let role='admin',denyOverview=false,denyCx=false,oldInbound=false,threadStatus='open',notes=[];
const roles={admin:['*'],sales:['customers.view','communications.manage','bookings.view'],finance:['finance.view','payroll.view','reports.view'],none:[]};
const actor=()=>({name:'UI Fixture '+role,email:role+'@example.test',roleCode:role,permissions:roles[role]});
const overview=()=>({data:{actor:actor(),today:'2026-09-24',commandStrip:{revenueActions:8,firstResponseMinutes:4,managerAlertMinutes:15,openEscalations:2,openTickets:7,commandPackReports:0},workspaces:{bookingsToday:12,ticketsNeedAttention:2,dayCloseStatus:'open',activeEmployees:16,aiHandoffsWaiting:1,aiTurnsToday:25,aiRolloutStage:'staff_only'}}});
const mkCase=(id,severity,status)=>({id,case_type:'service_support',severity,status,title:'Fixture case '+id,description:'Synthetic case; no customer involved.',owner_team:'operations',owner_email:null,created_at:Date.now()-3600000,first_response_due_at:Date.now()+3600000,sopRequirements:[],timeline:[],links:{bookingId:'UI-BK-1'}});
let cases=[mkCase('UI-CASE-1','critical','open'),mkCase('UI-CASE-2','normal','closed')];
const message=()=>({id:'UI-MSG-1',direction:'inbound',channel:'whatsapp',created_at:Date.now()-(oldInbound?25*3600000:60000),status:'received',payload:{text:'Please confirm the training appointment.'}});
const thread=()=>({id:'UI-THREAD-1',customer_name:'Asha Fixture',customer_id:'UI-CUS-1',primary_phone:'Masked phone',lead_id:'UI-LEAD-1',status:threadStatus,assigned_to:'ui.staff@example.test',lastMessage:{...message(),text:'Please confirm the training appointment.'}});
const conversation=()=>({data:{thread:thread(),participants:[],messages:[message()],assignments:[],notes}});
const control=()=>({data:{threadId:'UI-THREAD-1',customerId:'UI-CUS-1',provider:'local_fixture',routing:{mode:'human_only'},handoff:{aiPaused:true,current:{status:'staff_active'},events:[]},canHumanReply:true,productionDelivery:false,environment:'uat'}});
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url()),method=req.method();
 if(url.origin!==ORIGIN){external.push(req.url());return route.abort();}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 if(['GET','HEAD'].includes(method))reads.push({path:url.pathname,query:url.search});
 else {
  const body=req.postDataJSON();writes.push({path:url.pathname,method,body});
  if(url.pathname==='/api/unified-cases'){
   if(body.action==='respond')cases=cases.map(c=>c.id===body.caseId?{...c,first_responded_at:Date.now()}:c);
   if(body.action==='resolve')cases=cases.map(c=>c.id===body.caseId?{...c,status:'resolved'}:c);
   return json(route,{ok:true});
  }
  if(url.pathname==='/api/conversations'){
   if(body.action==='add_internal_note')notes=[{id:'UI-NOTE-1',actorEmail:'staff@example.test',body:body.note,createdAt:Date.now()}];
   if(body.action==='status')threadStatus=body.status;
   return json(route,{ok:true});
  }
  if(url.pathname==='/api/whatsapp/conversation-control')return json(route,{ok:true});
  return json(route,{error:'Fixture blocked unimplemented write'},409);
 }
 if(url.pathname==='/api/team-overview')return denyOverview?json(route,{error:'Fixture sign-in required',signInUrl:'/staging-login'},401):json(route,overview());
 if(url.pathname==='/api/unified-cases')return json(route,{directory:{summary:{open:1,critical:1,unowned:2,firstResponseOverdue:0,resolutionOverdue:0},cases,truth:{productionReady:false,automaticExternalNotification:false}}});
 if(url.pathname==='/api/conversations')return denyCx?json(route,{error:'Fixture session expired'},401):json(route,url.searchParams.has('threadId')?conversation():{data:{threads:[thread()],nextCursor:null}});
 if(url.pathname==='/api/whatsapp/conversation-control')return denyCx?json(route,{error:'Fixture session expired'},401):json(route,control());
 if(url.pathname==='/api/identity-session')return json(route,{error:'No backend login; isolated visual fixture'},401);
 return json(route,{error:'Fixture: data temporarily unavailable'},503);
});
const delay=ms=>page.waitForTimeout(ms);
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png',fullPage:false});}
async function check(name,run){const before=pageErrors.length;try{await run();assert.deepEqual(pageErrors.slice(before),[],'Unexpected browser exception');results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+e.message);await shot('failure-'+results.length).catch(()=>{});}}
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[data-staff-workspace]')&&getComputedStyle(document.querySelector('[data-staff-workspace]')).getPropertyValue('--staff-nav').trim());await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>document.querySelector('#staff-workspace-navigation')?.textContent.includes('UI Fixture')||document.querySelector('#staff-workspace-navigation')?.textContent.includes('Retry navigation'));await delay(150);}
async function noOverflow(){const box=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(box.scroll<=box.w+1,JSON.stringify(box));}
function luminance(c){return c.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
await check('Operations: one staff frame and preserved contextual destinations',async()=>{
 await open('/team/operations');assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 await page.getByText('Related workspace links',{exact:true}).click();
 assert.equal(await page.locator('nav[aria-label="Operations"] a').count(),13);
 assert.equal(await page.locator('nav[aria-label="Operations"] [aria-current="page"]').getAttribute('href'),'/team/operations');
 await page.getByText('Related workspace links',{exact:true}).click();await shot('operations-emerald');
});
await check('Cases: filters, row actions and original response payload',async()=>{
 await open('/team/cases');await page.getByRole('heading',{name:'Fixture case UI-CASE-1',exact:true}).waitFor();
 await page.getByRole('button',{name:'All',exact:true}).click();await page.getByRole('heading',{name:'Fixture case UI-CASE-2',exact:true}).waitFor();
 await page.getByRole('button',{name:'Critical',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Fixture case UI-CASE-2',exact:true}).count(),0);
 await page.getByRole('button',{name:'Mark responded',exact:true}).click();await page.getByRole('button',{name:'Mark responded',exact:true}).waitFor({state:'detached'});
 assert.deepEqual(writes.at(-1),{path:'/api/unified-cases',method:'POST',body:{action:'respond',caseId:'UI-CASE-1'}});await shot('cases-populated');
});
await check('Cases: resolution keeps explicit prompt and existing mutation shape',async()=>{
 page.once('dialog',d=>d.accept('Synthetic resolution evidence'));
 await page.getByRole('button',{name:'Resolve',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).waitFor();
 assert.deepEqual(writes.at(-1).body,{action:'resolve',caseId:'UI-CASE-1',resolutionCode:'resolved_by_staff',note:'Synthetic resolution evidence'});
});
await check('CX: populated inbox, routing controls and canonical message',async()=>{
 await open('/team/customer-experience');await page.getByPlaceholder('Reply as PawSpace CX...').waitFor();
 await page.getByText('Please confirm the training appointment.',{exact:true}).last().waitFor();
 assert.ok(await page.getByRole('button',{name:'Chatbot only',exact:true}).isDisabled());await shot('cx-populated');
});
await check('CX: internal note keeps idempotency key and selected thread',async()=>{
 await page.getByRole('textbox',{name:'Internal note',exact:true}).fill('Synthetic note for UI regression');
 await page.getByRole('button',{name:'Save internal note',exact:true}).click();await page.getByText('Internal note saved.',{exact:true}).waitFor();
 const w=writes.at(-1);assert.equal(w.path,'/api/conversations');assert.equal(w.body.action,'add_internal_note');assert.equal(w.body.threadId,'UI-THREAD-1');assert.equal(w.body.note,'Synthetic note for UI regression');assert.ok(w.body.idempotencyKey);
});
await check('CX: reply emits governed payload only to the intercepted endpoint',async()=>{
 await page.getByPlaceholder('Reply as PawSpace CX...').fill('Synthetic reply; never delivered');
 await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByText('Reply queued through the governed WhatsApp outbox.',{exact:true}).waitFor();
 const w=writes.at(-1);assert.equal(w.path,'/api/whatsapp/conversation-control');assert.equal(w.body.action,'human_reply');assert.equal(w.body.threadId,'UI-THREAD-1');assert.equal(w.body.message,'Synthetic reply; never delivered');assert.ok(w.body.clientRequestId);
});
await check('CX: server-side search and ownership filter parameters retained',async()=>{
 await page.getByPlaceholder('Search leads or conversations...').fill('Asha');await delay(250);
 await page.getByRole('button',{name:'Human owned',exact:true}).click();await delay(250);
 assert.ok(reads.some(r=>r.path==='/api/conversations'&&r.query.includes('q=Asha')&&r.query.includes('ownership=human')));
 await page.getByRole('combobox',{name:'Conversation status',exact:true}).selectOption('resolved');await delay(250);
 assert.ok(reads.some(r=>r.path==='/api/conversations'&&r.query.includes('status=resolved')));
});
await check('CX: expired service window still disables free-form reply',async()=>{
 oldInbound=true;await open('/team/customer-experience');const input=page.getByPlaceholder('24-hour window closed — use an approved template');await input.waitFor();assert.ok(await input.isDisabled());assert.ok(await page.getByRole('button',{name:'Send',exact:true}).isDisabled());oldInbound=false;
});
await check('CX: lost access clears selected-thread data instead of disclosing it',async()=>{
 denyCx=true;await open('/team/customer-experience');await page.getByText('Fixture session expired',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Asha Fixture',exact:true}).count(),0);denyCx=false;
});
for(const path of ['/team/cases','/team/customer-experience','/team/voice'])for(const theme of ['emerald','signature'])for(const mode of ['light','dark']){
 await check('Theme '+theme+'/'+mode+' '+path,async()=>{
  if(path==='/team/cases')cases=[mkCase('UI-CASE-1','critical','open'),mkCase('UI-CASE-2','normal','closed')];
  await open(path);await page.evaluate(({theme,mode})=>{document.documentElement.dataset.pawTheme=theme;document.documentElement.dataset.pawMode=mode;},{theme,mode});await delay(400);
  const h=await page.locator('h1').first().evaluate(e=>({font:getComputedStyle(e).fontFamily,size:parseFloat(getComputedStyle(e).fontSize),fg:getComputedStyle(e).color,bg:getComputedStyle(document.querySelector('[data-staff-workspace]')).getPropertyValue('--staff-bg').trim()}));
  assert.match(h.font,/PawSpaceStaffNunito/);assert.ok(h.size>=28);
  const rgb=await page.locator('[data-staff-workspace]').evaluate(e=>getComputedStyle(e).backgroundColor);assert.ok(contrast(h.fg,rgb)>=4.5,JSON.stringify(h));
  if(path==='/team/cases') {const c=await page.locator('article').first().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e.querySelector('h2')).color}));assert.ok(contrast(c.fg,c.bg)>=4.5,JSON.stringify(c));}
  if(path==='/team/customer-experience') {const c=await page.getByRole('button',{name:'WhatsApp',exact:true}).evaluate(e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e).color}));assert.ok(contrast(c.fg,c.bg)>=4.5,JSON.stringify(c));}
  if(path==='/team/customer-experience') {
   await page.getByPlaceholder('Reply as PawSpace CX...').fill('Synthetic contrast check; not submitted');await delay(400);
   const send=await page.getByRole('button',{name:'Send',exact:true}).evaluate(e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e).color,opacity:getComputedStyle(e).opacity,disabled:e.disabled}));
   assert.equal(send.disabled,false);assert.equal(send.opacity,'1');assert.ok(contrast(send.fg,send.bg)>=4.5,JSON.stringify(send));
  }
  await shot(path.replaceAll('/','_')+'-'+theme+'-'+mode);
 });
}
const contract=JSON.parse(fs.readFileSync('tests/fixtures/staff-console-page-contract.json','utf8'));
const paths=Object.keys(contract.pages).map(p=>p.replace(/^app/,'').replace(/\/page\.tsx$/,''));
for(const width of [1440,1280,390])for(const path of paths){
 await check('Shell/responsive '+width+' '+path+' (unconfigured APIs shown unavailable)',async()=>{
  await page.setViewportSize({width,height:1000});await open(path);await noOverflow();
  assert.equal(await page.locator('[data-staff-workspace]').count(),1);assert.ok(await page.locator('h1').count());
  if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
  await shot(path.replaceAll('/','_')+'-'+width);
 });
}
await check('Navigation: Finance role does not gain sales or settings links',async()=>{
 role='finance';await page.setViewportSize({width:1440,height:1000});await open('/team/finance-compliance');
 const nav=page.locator('nav[aria-label="Staff workspaces"]');assert.equal(await nav.getByText('Sales & customers',{exact:true}).count(),0);assert.equal(await nav.getByText('Settings & controls',{exact:true}).count(),0);
 assert.equal(await nav.getByText('Finance & compliance',{exact:true}).count(),1);role='admin';
});
await check('Unavailable navigation does not hide existing operations content',async()=>{
 denyOverview=true;await open('/team/operations');await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();await page.getByRole('heading',{name:'Operations control',exact:true}).waitFor();assert.ok(await page.getByRole('heading',{name:'Boarding exception queue',exact:true}).isVisible());denyOverview=false;
});
await check('Customer routes stay outside the staff frame',async()=>{
 for(const path of ['/v2','/mobile-app']){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await delay(500);assert.equal(await page.locator('[data-staff-workspace]').count(),0);assert.doesNotMatch(await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);}
});
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Synthetic loopback UI; every API intercepted; not authenticated backend certification',results,reads,writes,external,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
