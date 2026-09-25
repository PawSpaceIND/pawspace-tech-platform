/** Local-only synthetic Chromium UI regression. Every API is intercepted; no real sessions or transactions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('UI fixtures are allowed on loopback only.');
const browser=await chromium.launch({executablePath:process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:process.env.STAFF_UI_HEADED!=='1',slowMo:Number(process.env.STAFF_UI_SLOW_MS||0)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
const page=await context.newPage();
const results=[],requests=[],mutations=[],unexpected=[];let role='admin',denyOverview=false,denyBookings=false;
const permissions={admin:['*'],sales:['customers.view','bookings.view','communications.call','self_service.view'],finance:['finance.view','payroll.view','reports.view'],none:[]};
const actor=()=>({name:'UI Fixture '+role,email:role+'@example.test',roleCode:role,permissions:permissions[role]});
const overview=()=>({data:{actor:actor(),today:'2026-09-24',commandStrip:{revenueActions:8,firstResponseMinutes:4,managerAlertMinutes:15,openEscalations:2,openTickets:7,commandPackReports:0},workspaces:{bookingsToday:12,ticketsNeedAttention:2,dayCloseStatus:'open',activeEmployees:16,aiHandoffsWaiting:1,aiTurnsToday:25,aiRolloutStage:'staff_only'}}});
const customers=Array.from({length:30},(_,i)=>({customerId:'UI-CUS-'+String(i+1).padStart(3,'0'),name:i===0?'Asha Fixture':i===1?'Bala Fixture':'Customer Fixture '+(i+1),primaryPhone:'Masked phone',crmStage:'active',owner:'UI Sales',lifetimeValue:5400+i*100,openTicketCount:0,dataQuality:{score:95,issues:[]},consent:{marketing:false,service:true},pets:[{name:'Milo'}],bookings:[{id:'UI-BK-001'}]}));
let action={id:'UI-ACTION-1',customer_id:customers[0].customerId,reason:'Fixture renewal follow-up',score:82,expected_revenue:1350,status:'ready',suppression_json:'[]'};
const booking=(id,name,status,paid)=>({id,customer_name:name,primary_phone:'Masked phone',customer_email:'fixture@example.test',package_name:'Essential Bath',provider_name:'Fixture Groomer',provider_id:'UI-PROVIDER-1',service_code:'grooming',zone_id:'blr-south',status,scheduled_start:'2026-09-29T05:30:00.000Z',payment_status:paid?'captured':'pending',payment_amount:1350,amount_due_now:paid?0:1350,payment_mode:'online',payment_method:'sandbox',payment_id:'UI-PAY-1',gateway:'sandbox',provider_model:'full_time',work_order_id:'UI-WO-1',work_order_status:status,channel:'fixture',pets:[{id:'UI-PET-1',name:'Milo',species:'dog',breed:'Shih Tzu',vaccination_status:'verified'}],lifecycle:[{id:'UI-EVENT-1',event_type:'confirmed',occurred_at:1790659800000}],operations:[],notifications:[],rebooking:[],refunds:[],tickets:[],adminActions:[]});
const bookings=[booking('UI-BK-001','Asha Fixture','confirmed',false),booking('UI-BK-002','Bala Fixture','completed',true)];
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url()),method=request.method();
 if(url.origin!==ORIGIN){unexpected.push({url:request.url(),reason:'external blocked'});return route.abort();}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 requests.push({path:url.pathname,query:url.search,method});
 const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 if(!['GET','HEAD'].includes(method)){
  const body=request.postDataJSON();mutations.push({path:url.pathname,method,body});
  if(url.pathname==='/api/revenue-intelligence'){action={...action,status:body.action==='claim'?'claimed':'completed'};return json({data:{}});}
  if(url.pathname==='/api/booking-command-center')return json({deliveryStatus:'fixture_only_not_sent'});
  return json({error:'Unmocked mutation blocked by UI fixture harness'},409);
 }
 if(url.pathname==='/api/team-overview')return denyOverview?json({error:'UI fixture: sign-in required',signInUrl:'/staging-login'},401):json(overview());
 if(url.pathname==='/api/customer-360')return json({data:{records:customers}});
 if(url.pathname==='/api/revenue-intelligence')return json({data:{actions:[action]}});
 if(url.pathname==='/api/booking-command-center')return denyBookings?json({error:'UI fixture: booking data unavailable'},503):json({bookings});
 if(url.pathname==='/api/booking-command-center/stream')return route.fulfill({status:200,contentType:'text/event-stream',body:': fixture heartbeat\n\n'});
 if(url.pathname==='/api/service-media')return json({assets:[]});
 if(url.pathname==='/api/identity-session')return json({error:'No authenticated session; isolated UI fixture'},401);
 return json({data:{},records:[],error:'No fixture for this optional read'},404);
});
fs.mkdirSync('.ui-audit/screens',{recursive:true});
async function check(name,run){try{await run();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',error:String(error)});console.log('FAIL '+name+' '+error.message);await page.screenshot({path:'.ui-audit/screens/failure-'+results.length+'.png'}).catch(()=>{});}}
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('[data-staff-workspace]')&&getComputedStyle(document.querySelector('[data-staff-workspace]')).getPropertyValue('--staff-nav').trim()!=='',{timeout:30000});await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>document.querySelector('#staff-workspace-navigation')?.textContent.includes('UI Fixture')||document.querySelector('#staff-workspace-navigation')?.textContent.includes('Retry navigation'));await page.waitForTimeout(150);}
async function shot(name){await page.screenshot({path:'.ui-audit/screens/'+name+'.png',fullPage:false});}
await check('Home: existing overview data, shared navigation and local Nunito',async()=>{
 await open('/team');await page.getByRole('heading',{name:'Revenue & CRM',exact:true}).waitFor();
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] details').count(),7);
 assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 assert.match(await page.locator('h1').evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);
 await shot('home-emerald-fixture');
});
await check('Sidebar: workspace search and native groups expand',async()=>{
 await page.getByRole('searchbox',{name:'Find a workspace'}).fill('payroll');
 assert.equal(await page.getByRole('link',{name:'Payroll',exact:true}).count(),1);
 await page.getByRole('searchbox',{name:'Find a workspace'}).fill('');
 await page.locator('summary').filter({hasText:'Sales & customers'}).click();
 await page.getByRole('link',{name:'Customer 360',exact:true}).waitFor({state:'visible'});
});
await check('Sales role: finance and settings not offered',async()=>{
 role='sales';await open('/team');await page.getByRole('heading',{name:'Revenue & CRM',exact:true}).waitFor();
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] summary').filter({hasText:'Finance & compliance'}).count(),0);
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] summary').filter({hasText:'Settings & controls'}).count(),0);
});
await check('Finance role: no customer links; finance workspace retained',async()=>{
 role='finance';await open('/team');await page.getByRole('heading',{name:'Accounts & collections',exact:true}).waitFor();
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] summary').filter({hasText:'Sales & customers'}).count(),0);
});
await check('Sales: newer mainline paging and search preserved',async()=>{
 role='admin';await open('/team/sales');await page.getByRole('button',{name:'Show 5 more of 30',exact:true}).waitFor();
 await page.getByRole('button',{name:'Show 5 more of 30',exact:true}).click();
 await page.getByPlaceholder('Filter by name, phone, stage or owner').fill('Bala');
 assert.equal(await page.locator('main aside button').count(),1);
 await page.locator('main aside button').click();assert.match(await page.locator('main article h2').innerText(),/Bala Fixture/);
 await page.getByPlaceholder('Filter by name, phone, stage or owner').fill('Asha');await page.locator('main aside button').click();await shot('sales-emerald-fixture');
});
await check('Sales: Claim and Complete emit original payloads to stub only',async()=>{
 await page.getByRole('button',{name:'Claim',exact:true}).click();await page.getByRole('button',{name:'Complete',exact:true}).waitFor();
 assert.deepEqual(mutations.at(-1),{path:'/api/revenue-intelligence',method:'POST',body:{action:'claim',id:'UI-ACTION-1'}});
 await page.getByRole('button',{name:'Complete',exact:true}).click();await page.getByRole('button',{name:'Complete',exact:true}).waitFor({state:'detached'});
 assert.deepEqual(mutations.at(-1).body,{action:'complete',id:'UI-ACTION-1',outcome:'staff_completed'});
});
await check('Bookings: populated workspace and all original tabs',async()=>{
 await open('/team/operations/bookings');await page.getByRole('heading',{name:'2 bookings',exact:true}).waitFor();
 for(const name of ['Journey','Payments','Communication','Tickets & refunds','Overview'])await page.getByRole('button',{name,exact:true}).click();
 await page.getByRole('region',{name:'Service proof verification'}).waitFor();await shot('bookings-emerald-fixture');
});
await check('Bookings: filters, selected row and server search retained',async()=>{
 await page.getByRole('button',{name:'Completed',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:/UI-BK-002/}).count(),1);
 assert.equal(await page.getByRole('button',{name:/UI-BK-001/}).count(),0);
 await page.getByRole('button',{name:/UI-BK-002/}).click();
 await page.getByRole('button',{name:'All bookings',exact:true}).click();
 await page.getByPlaceholder('Search booking, customer, pet, phone or provider').fill('UI-BK-001');
 await page.waitForTimeout(700);assert.ok(requests.some(r=>r.path==='/api/booking-command-center'&&r.query.includes('q=UI-BK-001')));
});
await check('Booking alias: deep link survives full reload and selection',async()=>{
 await open('/v2/control-center?bookingId=UI-BK-001');
 await page.getByRole('button',{name:/UI-BK-001/}).waitFor();
 assert.equal(await page.getByPlaceholder('Search booking, customer, pet, phone or provider').inputValue(),'UI-BK-001');
 assert.ok(page.url().endsWith('/v2/control-center?bookingId=UI-BK-001'));
 await page.getByRole('button',{name:/Tracking/}).click();
 await page.waitForTimeout(200);assert.deepEqual(mutations.at(-1),{path:'/api/booking-command-center',method:'POST',body:{bookingId:'UI-BK-001',action:'open_tracking',reason:'Customer service and booking follow-up'}});
});
for(const theme of ['emerald','signature'])for(const mode of ['light','dark']){
 await check('Appearance: '+theme+' / '+mode,async()=>{
  await page.evaluate(({theme,mode})=>{document.documentElement.dataset.pawTheme=theme;document.documentElement.dataset.pawMode=mode;},{theme,mode});
  const color=await page.locator('[data-staff-workspace]').evaluate(e=>getComputedStyle(e).getPropertyValue('--staff-gold').trim());
  assert.equal(color,theme==='emerald'?'#e6b34e':'#ffaf00');
  const colours=await page.getByRole('region',{name:'Service proof verification'}).evaluate(e=>({bg:getComputedStyle(e).backgroundColor,fg:getComputedStyle(e.querySelector('h3')).color}));
  const luminance=colour=>colour.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4)).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
  const a=luminance(colours.bg),b=luminance(colours.fg);assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,JSON.stringify(colours));
  await shot('bookings-'+theme+'-'+mode+'-fixture');
 });
}
for(const width of [1440,1280,390])for(const path of ['/team','/team/sales','/team/operations/bookings']){
 await check('Responsive '+width+' '+path,async()=>{
  await page.setViewportSize({width,height:900});await open(path);
  await page.evaluate(()=>{document.documentElement.dataset.pawTheme='emerald';document.documentElement.dataset.pawMode='light';});
  await page.waitForTimeout(300);
  const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
  assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify(sizes));
  if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor({state:'visible'});await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
  await shot(path.replaceAll('/','_')+'-'+width+'-fixture');
 });
}
await check('Unavailable navigation: existing child error and retry still usable',async()=>{
 denyOverview=true;denyBookings=true;await page.setViewportSize({width:1440,height:1000});await open('/team/operations/bookings');
 await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();
 await page.getByRole('button',{name:'Try again',exact:true}).waitFor();
 assert.equal(await page.locator('[data-staff-workspace]').count(),1);
 await shot('bookings-unavailable-fixture');denyOverview=false;denyBookings=false;
});
await check('Customer V2: no staff frame or staff font injected',async()=>{
 await page.goto(ORIGIN+'/v2',{waitUntil:'domcontentloaded'});await page.waitForTimeout(1800);
 assert.equal(await page.locator('[data-staff-workspace]').count(),0);
 assert.doesNotMatch(await page.locator('body').evaluate(e=>getComputedStyle(e).fontFamily),/PawSpaceStaffNunito/);
});
fs.writeFileSync('.ui-audit/browser-fixture-results.json',JSON.stringify({scope:'Synthetic UI fixtures; every API intercepted on loopback; no authenticated backend certification',results,requests,mutations,unexpected},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
