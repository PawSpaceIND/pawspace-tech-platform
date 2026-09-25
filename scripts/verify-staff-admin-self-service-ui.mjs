/** Visible Chromium, loopback-only synthetic UI. All APIs intercepted; no actual employee or booking writes. */
import assert from 'node:assert/strict';import fs from 'node:fs';import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('Synthetic UI requires a loopback origin.');
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/phase7';fs.mkdirSync(OUT+'/screens',{recursive:true});
const executablePath=process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium':undefined);
const browser=await chromium.launch({executablePath,headless:process.env.STAFF_UI_HEADLESS==='1',slowMo:Number(process.env.STAFF_UI_SLOW_MS||150)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
const results=[],reads=[],writes=[],external=[],pageErrors=[];page.on('pageerror',e=>pageErrors.push(String(e)));
let role='founder',denyOps=false,denyMe=false,denyMenu=false,denyClock=false,linked=true,engagement='employee',clockStatus='absent',leaves=[];
const overview=zone=>{
 const activity=[{bookingId:'UI-ADMIN-B1',customer:'First Fixture',service:'grooming',packageName:'Fixture Bath',status:'confirmed',provider:'UI Provider One',scheduledStart:'2026-09-24T04:30:00Z',scheduledTimeIst:'10:00 am',activityAt:Date.UTC(2026,8,24),slot:'10:00',amount:1350},{bookingId:'UI-ADMIN-B2',customer:'Second Fixture',service:'dog_training',packageName:'Fixture Training',status:'completed',provider:'UI Provider Two',scheduledStart:'2026-09-24T06:30:00Z',scheduledTimeIst:'12:00 pm',activityAt:Date.UTC(2026,8,24),slot:'12:00',amount:2700}].filter((_,i)=>!zone||i===1);
 return {data:{date:'2026-09-24',dayWindow:{timezone:'Asia/Kolkata',startUtc:'2026-09-23T18:30:00Z',endUtc:'2026-09-24T18:30:00Z'},zoneId:zone||null,zones:['blr-south','blr-east'],metrics:{bookingsToday:activity.length,confirmed:1,completed:1,inProgress:0,cancelled:0,unassigned:0,recognizedRevenue:4050,providersActive:2,providersTotal:3,openTickets:1,ticketsNeedingAttention:1},capacity:[{providerId:'UI-PROVIDER-1',name:'UI Provider One',zone:zone||'blr-south',slots:[{slot:'10:00',state:'booked',bookingId:'UI-ADMIN-B1',label:'Fixture Bath'},{slot:'12:00',state:'available',bookingId:null,label:'Available capacity'}]}],capacityShown:1,capacityTotal:1,slots:['10:00','12:00'],activity,activityShown:activity.length,activityTotal:activity.length,sourceStatus:{bookings:'available'}}};
};
const slip={resultId:'UI-PAYSLIP-1',runId:'UI-RUN',periodStart:Date.UTC(2026,8,1),periodEnd:Date.UTC(2026,8,30),status:'approved',gross:30000,deductions:1000,reimbursements:0,net:29000};
const me=()=>({data:linked?{linked:true,engagement,email:'employee@example.test',employee:{id:'UI-EMP',code:'UI-EMP-001',name:'Employee Fixture',workEmail:'employee@example.test',joinedAt:Date.UTC(2026,0,1)},compensation:{structureCode:'FIXTURE',version:1,currency:'INR',components:[{code:'BASE',label:'Base salary',kind:'earning',amount:30000}],grossMonthly:30000,fixedDeductions:1000,netMonthly:29000},payslips:{list:[slip],latest:slip,latestLines:[{code:'BASE',label:'Base salary',kind:'earning',amount:30000},{code:'DED',label:'Fixture deduction',kind:'deduction',amount:1000}]},incentives:{list:[],approvedTotal:500},dailyIncentive:{list:[],total:0},salesIncentiveTruth:null,advances:{list:[],outstanding:0},leave:{balances:[{leaveCode:'CL',balance:5}],requests:leaves},attendance:[{workDate:'2026-09-24',status:clockStatus,workedMinutes:clockStatus==='checked_out'?480:0,exception:null}],performance:{appears:false,teamCode:'sales',ofEmployees:1}}:{linked:false,email:'employee@example.test'}});
const actor=()=>({data:{actor:{name:'Observed UI Fixture',email:role+'@example.test',roleCode:role,permissions:role==='founder'?['*']:['self_service.view']}}});
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
await context.route('**/*',async route=>{
 const request=route.request(),u=new URL(request.url());if(u.origin!==ORIGIN){external.push(u.origin+u.pathname);return route.abort();}
 if(!u.pathname.startsWith('/api/'))return route.continue();
 if(request.method()!=='GET'){
  const body=request.postDataJSON();writes.push({path:u.pathname,method:request.method(),body});
  if(u.pathname==='/api/me'){
   if(denyClock)return json(route,{error:'Fixture self-service write refused'},403);
   if(body.action==='check_in')clockStatus='checked_in';if(body.action==='check_out')clockStatus='checked_out';
   if(body.action==='apply_leave')leaves.push({id:'UI-LEAVE',...body,status:'pending',createdAt:Date.now()});
   return json(route,{data:{fixture:true}});
  }return json(route,{error:'Fixture write not configured; no request sent'},409);
 }
 reads.push(u.pathname+u.search);
 if(u.pathname==='/api/team-overview')return denyMenu?json(route,{error:'Fixture menu unavailable'},503):json(route,actor());
 if(u.pathname==='/api/operations-overview'){if(u.searchParams.has('zoneId'))await new Promise(r=>setTimeout(r,700));return denyOps?json(route,{error:'Fixture operations access denied'},403):json(route,overview(u.searchParams.get('zoneId')));}
 if(u.pathname==='/api/me')return denyMe?json(route,{error:'Fixture employee access denied'},403):json(route,me());
 if(u.pathname==='/api/training-ops')return json(route,{data:{programmes:[],trainers:[],metrics:{activeProgrammes:0,sessionsToday:0,openRecovery:0,paymentExceptions:0},source:'synthetic-ui',liveMoney:false}});
 return json(route,{error:'Fixture unconfigured endpoint; not certified'},503);
});
const pause=ms=>page.waitForTimeout(ms),lastWrite=p=>writes.filter(w=>w.path===p).at(-1)?.body;
async function open(p){await page.goto(ORIGIN+p,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-module]').waitFor();await page.evaluate(()=>document.fonts.ready);await pause(450);await page.evaluate(()=>document.title='PawSpace V2 - VISIBLE ADMIN/EMPLOYEE FIXTURE - NO LIVE ACTIONS');}
async function shot(n){await page.screenshot({path:OUT+'/screens/'+n+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await shot('failure-'+results.length).catch(()=>{});}}
async function noOverflow(){const m=await page.evaluate(()=>({w:innerWidth,sw:document.documentElement.scrollWidth}));assert.ok(m.sw<=m.w+1,JSON.stringify(m));}
async function localNav(){const d=page.locator('details[data-staff-context]');if(!await d.evaluate(e=>e.open)){await d.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await d.evaluate(e=>e.open),true);}return d;}
await check('Admin: canonical overview, provider capacity and local switches are retained',async()=>{
 await open('/admin');await page.getByRole('heading',{level:1,name:'Overview',exact:true}).waitFor();assert.match(await page.locator('main').innerText(),/4,050/);
 assert.equal(await page.getByRole('table').count(),1);const d=await localNav();assert.equal(await d.locator('nav button').count(),4);
 assert.deepEqual(await d.locator('nav button').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label'))),['Overview','Live calendar','Bookings','Training operations']);
 await d.getByRole('button',{name:'Live calendar',exact:true}).click();await page.getByRole('heading',{level:1,name:'Live calendar',exact:true}).waitFor();await d.getByRole('button',{name:'Overview',exact:true}).click();await d.locator('summary').click();await shot('admin-overview');
});
await check('Admin: selected booking identifier survives the Command Center deep link',async()=>{
 const d=await localNav();await d.getByRole('button',{name:'Bookings',exact:true}).click();await d.locator('summary').click();
 await page.locator('main button').filter({hasText:'Second Fixture'}).click();const l=page.getByRole('link',{name:'Open in Command Center',exact:true});assert.equal(await l.getAttribute('href'),'/team/operations/bookings?bookingId=UI-ADMIN-B2');await shot('admin-selected-booking');
});
await check('Admin: zone filter uses existing endpoint and never displays stale-zone activity',async()=>{
 await page.getByRole('combobox',{name:'Filter by zone'}).selectOption('blr-east');assert.equal(await page.locator('main button').filter({hasText:'First Fixture'}).count(),0);
 await page.locator('main button').filter({hasText:'Second Fixture'}).waitFor();assert.ok(reads.includes('/api/operations-overview?zoneId=blr-east'));await page.getByRole('combobox',{name:'Filter by zone'}).selectOption('');await page.locator('main button').filter({hasText:'First Fixture'}).waitFor();
});
await check('Admin: Training panel remains the existing component; toolbar notifications do not create a plan',async()=>{
 const d=await localNav();await d.getByRole('button',{name:'Training operations',exact:true}).click();await d.locator('summary').click();await page.getByRole('heading',{name:'Training recovery console',exact:true}).waitFor();
 const before=writes.length;await page.getByRole('button',{name:'Create plan'}).click();await page.getByText('New training plan opened',{exact:false}).waitFor();assert.equal(writes.length,before);await shot('admin-training');
});
await check('Admin: access denial exposes the existing reload recovery without leaking overview records',async()=>{
 denyOps=true;await open('/admin');await page.getByRole('alert').filter({hasText:'Fixture operations access denied'}).waitFor();assert.equal(await page.getByText('Second Fixture',{exact:true}).count(),0);
 denyOps=false;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('heading',{level:1,name:'Overview',exact:true}).waitFor();
});
await check('Employee: governed salary, payslip and attendance display correctly',async()=>{
 role='employee';await open('/me');await page.getByRole('heading',{name:'Hello, Employee',exact:true}).waitFor();assert.match(await page.locator('main').innerText(),/29,000/);assert.match(await page.locator('main').innerText(),/Fixture deduction/);assert.match(await page.locator('main').innerText(),/UI-EMP-001/);await shot('employee-record');
});
await check('Employee: rejected clock request and check-in/check-out use the existing self-service payload',async()=>{
 denyClock=true;await page.getByRole('button',{name:'Check in',exact:true}).click();await page.getByText('Fixture self-service write refused',{exact:true}).waitFor();assert.equal(clockStatus,'absent');denyClock=false;
 await page.getByRole('button',{name:'Check in',exact:true}).click();await page.getByText('Checked in.',{exact:true}).waitFor();assert.deepEqual(lastWrite('/api/me'),{action:'check_in'});
 await page.getByRole('button',{name:'Check out',exact:true}).click();await page.getByText('Checked out.',{exact:true}).waitFor();assert.deepEqual(lastWrite('/api/me'),{action:'check_out'});await page.getByText('8h 0m',{exact:true}).waitFor();
});
await check('Employee: leave validation and approval-request payload preserve employee scope',async()=>{
 const before=writes.length;await page.getByRole('button',{name:'Submit for approval',exact:true}).click();await page.getByText('Fill leave type, dates and a reason (4+ chars).',{exact:true}).waitFor();assert.equal(writes.length,before);
 await page.getByLabel('Leave type (code)',{exact:true}).fill('CL');await page.getByLabel('From',{exact:true}).fill('2026-10-01');await page.getByLabel('To',{exact:true}).fill('2026-10-01');await page.getByLabel('Days',{exact:true}).fill('1');await page.getByLabel('Reason',{exact:true}).fill('UI fixture leave request');
 await page.getByRole('button',{name:'Submit for approval',exact:true}).click();await page.getByText('Leave request submitted for manager approval.',{exact:true}).waitFor();assert.deepEqual(lastWrite('/api/me'),{action:'apply_leave',leaveCode:'CL',startDate:'2026-10-01',endDate:'2026-10-01',units:1,reason:'UI fixture leave request'});assert.equal(await page.getByLabel('Reason',{exact:true}).inputValue(),'');await shot('employee-leave');
});
await check('Employee: contract engagement still withholds employee salary, payslips and advances',async()=>{
 engagement='contract';await open('/me');await page.getByRole('heading',{name:'My incentives',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'My salary',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'My payslips',exact:true}).count(),0);assert.equal(await page.getByText('Salary advances',{exact:true}).count(),0);assert.equal(await page.getByText('Net take-home (latest)',{exact:true}).count(),0);engagement='employee';
});
await check('Employee: unlinked identity and rejected reads expose no employee actions or salary',async()=>{
 linked=false;await open('/me');await page.getByRole('heading',{name:'No employee record linked yet',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Check in',exact:true}).count(),0);linked=true;
 denyMe=true;await open('/me');await page.getByText('Fixture employee access denied',{exact:true}).waitFor();assert.equal(await page.getByText('UI-EMP-001',{exact:false}).count(),0);assert.equal(await page.getByRole('button',{name:'Submit for approval',exact:true}).count(),0);denyMe=false;
});
function contrast(fg,bg){const l=s=>{const a=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return .2126*a[0]+.7152*a[1]+.0722*a[2];};const a=l(fg),b=l(bg);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
for(const path of ['/admin','/me'])for(const theme of ['emerald','signature'])for(const mode of ['light','dark'])await check('Theme '+theme+'/'+mode+' '+path,async()=>{
 role='founder';await open(path);await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await pause(500);
 assert.match(await page.locator('main').evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);
 for(const locator of [page.locator('h1').first(),...(path==='/me'?[page.getByRole('button',{name:'Check in',exact:true}),page.getByRole('button',{name:'Check out',exact:true})]:[page.getByRole('table').getByText('Available',{exact:true})])]){
  const s=await locator.evaluate(e=>{let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;const x=getComputedStyle(e);return{fg:x.color,bg:getComputedStyle(p).backgroundColor,font:parseFloat(x.fontSize)};});assert.ok(contrast(s.fg,s.bg)>=4.5,JSON.stringify(s));assert.ok(s.font>=14,JSON.stringify(s));
 }await noOverflow();await shot(path.slice(1)+'-'+theme+'-'+mode);
});
for(const width of [1440,1280,390])for(const path of ['/admin','/me'])await check('Responsive '+width+' '+path,async()=>{
 await page.setViewportSize({width,height:1000});await open(path);await noOverflow();assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 if(path==='/admin'){
  const nav=await localNav();await noOverflow();assert.ok(await nav.getByRole('button',{name:'Bookings',exact:true}).isVisible());assert.ok(await nav.getByRole('link',{name:'Booking Command Center',exact:false}).isVisible());await nav.locator('summary').click();
  assert.ok(await page.getByRole('combobox',{name:'Filter by zone'}).isVisible());for(const s of ['Today’s bookings','Recognised revenue','Providers active','Open tickets'])assert.ok(await page.getByText(s,{exact:true}).isVisible(),s);
 }
 if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
 await shot(path.slice(1)+'-'+width);
});
await check('Employee menu grants neither finance nor administrative navigation',async()=>{
 role='employee';await page.setViewportSize({width:1440,height:1000});await open('/me');const nav=page.locator('nav[aria-label="Staff workspaces"]');assert.equal(await nav.getByText('Finance & compliance',{exact:true}).count(),0);assert.equal(await nav.getByText('Settings & controls',{exact:true}).count(),0);assert.equal(await nav.getByRole('link',{name:'My employee workspace',exact:true}).count(),1);
});
await check('Unavailable navigation does not hide employee content or original self-service controls',async()=>{
 denyMenu=true;await open('/me');await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();assert.ok(await page.getByRole('button',{name:'Check in',exact:true}).isVisible());denyMenu=false;
});
await check('Customer and provider entry points have no Admin/employee frame injected',async()=>{
 for(const p of ['/v2','/v2/partner']){await page.goto(ORIGIN+p,{waitUntil:'domcontentloaded'});await pause(400);assert.equal(await page.locator('[data-staff-module]').count(),0);}
});
await check('No unhandled browser exceptions',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Visible synthetic UI, all API calls intercepted, not authenticated backend certification',results,reads,writes,external,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
