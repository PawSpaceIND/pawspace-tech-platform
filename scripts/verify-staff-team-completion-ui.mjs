/** Visible, loopback-only Team UI regression. Every API call is intercepted; no provider is contacted. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('UI fixtures require a loopback host.');
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/phase6';fs.mkdirSync(OUT+'/screens',{recursive:true});
const executablePath=process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium':undefined);
const browser=await chromium.launch({executablePath,headless:process.env.STAFF_UI_HEADLESS==='1',slowMo:Number(process.env.STAFF_UI_SLOW_MS||100)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
const results=[],reads=[],writes=[],external=[],pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
let growthConsent=false,growthComplaint=false;
let role='founder',stage='off',denyRollout=false,denyOverview=false,denyApproval=false,alertStatus='open',opportunityStatus='ready',targetAmount=200000,dialActive=true;
const permissions={founder:['*'],finance:['finance.view','reports.view','payroll.view'],sales:['customers.view','communications.manage','bookings.view']};
const overview=()=>({data:{actor:{name:'Observed UI Fixture',email:role+'@example.test',roleCode:role,permissions:permissions[role]}}});
const rollout=()=>({data:{stage,stages:['off','staff_only','customers'],staffEnabled:stage!=='off',customersEnabled:false,updatedBy:'fixture',customerRolloutUatOnly:true,customerRolloutApprovedHere:false}});
const campaign=()=>({data:{campaigns:[{id:'UI-CAMPAIGN',name:'Fixture campaign',objective:'Synthetic verification only',status:'draft',approval_status:'pending',budget_amount:1000,holdout_percent:10}],snapshots:[{id:'UI-SNAPSHOT',campaign_id:'UI-CAMPAIGN',eligible_count:9,holdout_count:1,suppressed_count:3}]}});
const alertDirectory=()=>({directory:{summary:{total:1,open:alertStatus==='open'?1:0,acknowledged:alertStatus==='acknowledged'?1:0,critical:1,overdue:0},alerts:[{id:'UI-ALERT',alert_type:'lead_response',severity:'critical',status:alertStatus,title:'Fixture response alert',body:'Synthetic staff alert only',due_at:Date.now()+60000,created_at:Date.now(),team_code:'sales',booking_id:'UI-BK'}],truth:{productionReady:false,externalDelivery:false,backgroundSchedulerConfigured:false}}});
const revenue=()=>({stats:{dailyTarget:targetAmount,expectedRevenue:1350,targetProgressPercent:0.675},opportunities:[{id:'UI-OPP',customer_id:'UI-CUSTOMER',customer_name:'Fixture renewal',opportunity_type:'renewal',reason:'Synthetic fixture',score:85,expected_revenue:1350,status:opportunityStatus,owner:'unassigned',signals_json:'{"valueBasis":"actual_subscription_price"}'}]});
const languages={data:{baseKeyCount:10,locales:[{locale:'en',name:'English',published:10,draft:0,coveragePct:100},{locale:'ta',name:'Tamil',published:4,draft:2,coveragePct:40}]}};
const verification={data:{types:[{code:'identity',label:'Identity',automatable:true}],categories:[{category:'groomer',required:['identity']} ]}};
const hud={queue:{id:'UI-DIAL-1',status:'dialing',lifecycleCode:'renewal',priorityScore:85,highIntent:true,targetOffer:'Fixture renewal',nextBestService:null,expectedRevenue:1350,ltv:5400,callbackAt:null,attemptCount:1,reasons:[]},customer:{id:'UI-CUS',name:'Fixture Dialler',phone:'Masked fixture',email:null,cityId:'blr'},pets:[{id:'UI-PET',name:'Milo Fixture',species:'dog',breed:null}],serviceHistory:[],leadScore:{total:85,grade:'A'},aiSummary:null,recentConversation:[]};
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async route=>{
 const request=route.request(),u=new URL(request.url());if(u.origin!==ORIGIN){external.push(u.origin+u.pathname);return route.abort();}
 if(!u.pathname.startsWith('/api/'))return route.continue();
 if(request.method()!=='GET'){
  const body=request.postDataJSON();writes.push({path:u.pathname,method:request.method(),body});
  if(u.pathname==='/api/ai-rollout'){if(denyRollout)return json(route,{error:'Fixture rollout permission refused'},403);stage=body.stage;return json(route,{data:{fixture:true}});}
  if(u.pathname==='/api/marketing-control'){if(body.action==='approve_campaign'&&denyApproval)return json(route,{error:'Fixture maker/checker refusal'},403);return json(route,{data:{fixture:true}});}
  if(u.pathname==='/api/staff-alerts'){if(body.action==='acknowledge')alertStatus='acknowledged';if(body.action==='resolve')alertStatus='resolved';return json(route,{ok:true});}
  if(u.pathname==='/api/revenue-crm'){if(body.action==='claim_opportunity')opportunityStatus='claimed';if(body.action==='set_daily_target')targetAmount=body.targetAmount;return json(route,{ok:true});}
  if(u.pathname==='/api/i18n')return json(route,{data:{connected:false,drafted:0,note:'Fixture provider unavailable; no translations drafted.'}});
  if(u.pathname==='/api/outbound-orchestrator'){if(body.action==='disposition')dialActive=false;return json(route,{data:{status:'refused',reason:'Fixture transport disabled',autoAdvanceAfterMs:3000}});}
  return json(route,{error:'Fixture mutation not configured; no request sent'},409);
 }
 reads.push(u.pathname+u.search);
 if(u.pathname==='/api/team-overview')return denyOverview?json(route,{error:'Fixture navigation unavailable'},503):json(route,overview());
 if(u.pathname==='/api/ai-rollout')return json(route,rollout());
 if(u.pathname==='/api/marketing-control')return json(route,campaign());
 if(u.pathname==='/api/staff-alerts')return json(route,alertDirectory());
 if(u.pathname==='/api/revenue-crm')return json(route,revenue());
 if(u.pathname==='/api/i18n')return json(route,languages);
 if(u.pathname==='/api/provider-verification')return json(route,u.searchParams.has('applicationId')?{data:{required:['identity'],checks:[{verificationType:'identity',status:'pending',automatable:true}],canTakeAssignments:false}}:verification);
 if(u.pathname==='/api/outbound-orchestrator')return json(route,{data:{current:dialActive?{hud}:null,stats:{humanWaiting:2,aiWaiting:1}}});
 if(u.pathname==='/api/customer-360')return json(route,{data:{records:[{customerId:'UI-GROWTH',name:'Growth Fixture',crmStage:'active',owner:'UI Sales',consent:{marketing:growthConsent},pets:[{id:'UI-PET',name:'Milo Fixture',species:'dog',breed:null}],bookings:[{id:'UI-BOARD-HISTORY',serviceCode:'boarding',status:'completed',scheduledEnd:'2026-09-01T10:00:00Z',totalAmount:5000}],tickets:growthComplaint?[{category:'complaint',status:'open',subject:'Fixture care complaint'}]:[],lifetimeValue:5000,lastServiceAt:'2026-09-01T10:00:00Z',dataQuality:{score:100,issues:[]}}]}});
 if(u.pathname==='/api/revenue-intelligence')return json(route,{data:{actions:[{id:'UI-CROSS-SELL',customer_id:'UI-GROWTH',opportunity_type:'cross_sell',reason:'Fixture boarding history',score:80,expected_revenue:1350,expected_margin:null,confidence:.74,owner:'UI Sales',status:'ready',signals_json:JSON.stringify({serviceGaps:['grooming']}),updated_at:Date.now()}]}});
 return json(route,{error:'Fixture: unconfigured endpoint, not certified'},503);
});
const pause=ms=>page.waitForTimeout(ms),lastWrite=p=>writes.filter(w=>w.path===p).at(-1)?.body;
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-module]').waitFor();await page.evaluate(()=>document.fonts.ready);await pause(450);await page.evaluate(()=>document.title='PawSpace V2 - VISIBLE SYNTHETIC UI TEST - NO LIVE ACTIONS');}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await shot('failure-'+results.length).catch(()=>{});}}
async function noOverflow(){const m=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(m.sw<=m.w+1,JSON.stringify(m));}
await check('AI rollout: refusal and original stage request remain visible; stricter customer boundary remains',async()=>{
 await open('/team/ai/rollout');assert.equal(await page.getByRole('button',{name:'off',exact:true}).isDisabled(),true);denyRollout=true;
 await page.getByRole('button',{name:'staff only',exact:true}).click();await page.getByText('Fixture rollout permission refused',{exact:true}).waitFor();assert.equal(stage,'off');denyRollout=false;
 await page.getByRole('button',{name:'staff only',exact:true}).click();await page.getByText('Staff only · internal preview',{exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/ai-rollout'),{stage:'staff_only',reason:'Set to staff_only via admin'});assert.match(await page.getByRole('note').innerText(),/UAT deployments only/);await shot('ai-rollout');
});
await check('Marketing: maker/checker refusal and audience snapshot payload preserve campaign ID',async()=>{
 await open('/team/marketing');denyApproval=true;await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByText('Fixture maker/checker refusal',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Activate UAT',exact:true}).count(),0);denyApproval=false;
 await page.getByRole('button',{name:'Snapshot audience',exact:true}).click();await pause(300);assert.deepEqual(lastWrite('/api/marketing-control'),{action:'snapshot_audience',id:'UI-CAMPAIGN'});assert.match(await page.locator('main').innerText(),/eligible 9.*holdout 1.*suppressed 3/);await shot('marketing');
});
await check('Alerts: acknowledgement, filtering and resolution retain alert identity',async()=>{
 alertStatus='open';await open('/team/alerts');await page.getByRole('button',{name:'Acknowledge',exact:true}).click();await pause(300);
 assert.deepEqual(lastWrite('/api/staff-alerts'),{action:'acknowledge',alertId:'UI-ALERT'});await page.getByRole('button',{name:'acknowledged',exact:true}).click();await page.getByRole('heading',{name:'Fixture response alert',exact:true}).waitFor();
 await page.getByRole('button',{name:'Resolve alert',exact:true}).click();await pause(300);assert.deepEqual(lastWrite('/api/staff-alerts'),{action:'resolve',alertId:'UI-ALERT'});await shot('alerts');
});
await check('Daily revenue: actual-price label, claim and target payloads are retained',async()=>{
 opportunityStatus='ready';await open('/team/daily-revenue');assert.match(await page.locator('main').innerText(),/actual price/);await page.getByRole('button',{name:'Claim',exact:true}).click();await page.getByText('Opportunity claimed',{exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/revenue-crm'),{action:'claim_opportunity',id:'UI-OPP'});await page.locator('input[type="number"]').fill('150000');await page.getByRole('button',{name:'Save target',exact:true}).click();await pause(350);
 assert.deepEqual(lastWrite('/api/revenue-crm'),{action:'set_daily_target',targetAmount:150000});await shot('daily-revenue');
});
await check('Languages: English fallback, locale request and disconnected-provider result remain honest',async()=>{
 await open('/team/i18n');await page.getByRole('button',{name:'AI draft',exact:true}).click();await page.getByText('Fixture provider unavailable; no translations drafted.',{exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/i18n'),{action:'ai_translate',locale:'ta'});assert.match(await page.locator('main').innerText(),/4 pub.*2 draft.*40%/);await shot('languages');
});
await check('Provider verification: original query is retained and pending verification never becomes eligible',async()=>{
 await open('/team/provider-verification');await page.locator('input[name="app"]').fill('UI-APPLICATION');await page.locator('input[name="cat"]').fill('groomer');await page.getByRole('button',{name:'Check',exact:true}).click();await pause(350);
 assert.ok(reads.includes('/api/provider-verification?applicationId=UI-APPLICATION&category=groomer'));assert.match(await page.locator('main').innerText(),/Not yet eligible/);await shot('provider-verification');
});
await check('Power dialler: callback validation and disposition preserve queue; no automatic provider call',async()=>{
 dialActive=true;await open('/team/sales/power-dialler');await page.getByRole('heading',{name:'Fixture Dialler',exact:true}).waitFor();const before=writes.length;
 await page.getByRole('button',{name:'Callback',exact:true}).click();await page.getByText('Choose a callback date and time first.',{exact:true}).waitFor();assert.equal(writes.length,before);
 await page.locator('input[type="datetime-local"]').fill('2026-09-29T10:00');await page.getByRole('button',{name:'Callback',exact:true}).click();await page.getByText('No active customer call.',{exact:true}).waitFor();
 const b=lastWrite('/api/outbound-orchestrator');assert.equal(b.action,'disposition');assert.equal(b.queueId,'UI-DIAL-1');assert.equal(b.disposition,'callback');assert.ok(Number.isFinite(b.callbackAt));await shot('dialler');
});
await check('Cross-sell alias: contact opt-out stays suppressed in the governed work queue',async()=>{
 const before=writes.length;await open('/team/sales/cross-sell');await page.getByRole('heading',{name:'Cross-Sell Command Center',exact:true}).waitFor();
 const queue=page.locator('[aria-labelledby="unified-work-queue-title"]');await queue.getByText('Growth Fixture',{exact:true}).waitFor();assert.match(await queue.innerText(),/Suppressed/);assert.equal(writes.length,before);const cards=page.locator('[aria-labelledby="next-best-service-title"] article');assert.equal(await cards.count(),2);assert.equal(await cards.locator('[role="status"]').filter({hasText:'Marketing opt-out'}).count(),2);assert.equal(await page.getByRole('link',{name:'Open governed outreach',exact:true}).count(),0);await shot('cross-sell-suppressed');
});
await check('Cross-sell: consent permits existing outreach links and unknown economics stay unconfigured',async()=>{
 growthConsent=true;growthComplaint=false;const before=writes.length;await open('/team/sales/cross-sell');
 const cards=page.locator('[aria-labelledby="next-best-service-title"] article');await cards.first().waitFor();assert.equal(await cards.count(),2);
 const grooming=cards.filter({has:page.getByRole('heading',{name:'Grooming',exact:true})}),taxi=cards.filter({has:page.getByRole('heading',{name:'Taxi',exact:true})});
 assert.match(await grooming.innerText(),/1,350/);assert.match(await taxi.innerText(),/Not configured/);
 const links=page.getByRole('link',{name:'Open governed outreach',exact:true});assert.equal(await links.count(),2);for(const link of await links.all())assert.equal(await link.getAttribute('href'),'/team/sales');assert.equal(writes.length,before);await shot('cross-sell-allowed');
});
await check('Cross-sell: an open complaint suppresses outreach even with marketing consent',async()=>{
 growthComplaint=true;const before=writes.length;await open('/team/sales/cross-sell');const cards=page.locator('[aria-labelledby="next-best-service-title"] article');await cards.first().waitFor();
 assert.equal(await cards.locator('[role="status"]').filter({hasText:'Open complaint or safety case'}).count(),2);assert.equal(await page.getByRole('link',{name:'Open governed outreach',exact:true}).count(),0);assert.equal(writes.length,before);growthComplaint=false;growthConsent=false;await shot('cross-sell-complaint-blocked');
});
function contrast(fg,bg){const l=s=>{const a=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*a[0]+.7152*a[1]+.0722*a[2];};const a=l(fg),b=l(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
for(const path of ['/team/ai/rollout','/team/marketing','/team/i18n','/team/provider-verification','/team/sales/power-dialler','/team/sales/cross-sell'])for(const theme of ['emerald','signature'])for(const mode of ['light','dark'])await check('Theme '+theme+'/'+mode+' '+path,async()=>{
 await open(path);await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await pause(500);
 assert.match(await page.locator('[data-staff-module]').evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);
 const h=page.locator('h1').first();const m=await h.evaluate(e=>{let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;const s=getComputedStyle(e);return {fg:s.color,bg:getComputedStyle(p).backgroundColor,size:parseFloat(s.fontSize)};});assert.ok(m.size>=24);assert.ok(contrast(m.fg,m.bg)>=4.5,JSON.stringify(m));
 if(path.includes('provider-verification')){const m=await page.getByRole('button',{name:'Check',exact:true}).evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor}));assert.ok(contrast(m.fg,m.bg)>=4.5,JSON.stringify(m));}
 await noOverflow();await shot(path.replaceAll('/','_')+'-'+theme+'-'+mode);
});
const contract=JSON.parse(fs.readFileSync('tests/fixtures/staff-team-completion-contract.json','utf8')),paths=contract.pages.map(p=>p.replace(/^app/,''));
for(const width of [1440,1280,390])for(const path of paths)await check('Responsive '+width+' '+path+' (fixture/unavailable boundary)',async()=>{
 await page.setViewportSize({width,height:1000});await open(path);await noOverflow();assert.equal(await page.locator('[data-staff-workspace]').count(),1);assert.equal(await page.locator('h1').count(),1);
 if(path==='/team/sales/cross-sell'&&width>760){const cells=page.locator('[aria-labelledby="unified-work-queue-title"] article').first().locator(':scope > div');const household=await cells.nth(1).boundingBox(),opportunity=await cells.nth(3).boundingBox();assert.ok(opportunity.width>=180,JSON.stringify(opportunity));assert.ok(Math.abs(household.x-opportunity.x)<2,'Opportunity belongs below the household, not under the priority number');}
 if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
 if(width!==1280)await shot(path.replaceAll('/','_')+'-'+width);
});
await check('Finance role: new Team screens do not grant marketing or system navigation',async()=>{
 role='finance';await page.setViewportSize({width:1440,height:1000});await open('/team/ai/rollout');const nav=page.locator('nav[aria-label="Staff workspaces"]');assert.equal(await nav.getByText('Settings & controls',{exact:true}).count(),0);assert.equal(await nav.getByText('Growth & communications',{exact:true}).count(),0);role='founder';
});
await check('Navigation error leaves existing page content and recovery visible',async()=>{
 denyOverview=true;await open('/team/marketing');await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();await page.getByRole('button',{name:'Create draft',exact:true}).waitFor();denyOverview=false;
});
await check('Customer and partner UI remain outside staff module styling',async()=>{
 for(const p of ['/v2','/v2/partner']){await page.goto(ORIGIN+p,{waitUntil:'domcontentloaded'});await pause(400);assert.equal(await page.locator('[data-staff-module]').count(),0);}
});
await check('No unhandled application errors during visible fixture checks',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible loopback UI with intercepted APIs, no authenticated backend or external provider certification',results,reads,writes,external,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
