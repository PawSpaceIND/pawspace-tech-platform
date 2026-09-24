/** UI regression only. Loopback, synthetic records, all API requests intercepted, no real money/staff changes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';
const ORIGIN=process.env.STAFF_UI_BASE_URL||'http://127.0.0.1:4318';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(ORIGIN).hostname))throw new Error('Fixture harness is loopback-only.');
const OUT=process.env.STAFF_UI_OUTPUT_DIR||'.ui-audit/phase3';fs.mkdirSync(OUT+'/screens',{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.STAFF_UI_CHROMIUM_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(12000);
const results=[],reads=[],writes=[],blockedExternal=[],pageErrors=[];
page.on('pageerror',e=>pageErrors.push(String(e)));
let role='admin',denyOverview=false,denyFinance=false,denyPayroll=false,refuseApproval=false,runStatus='calculated',numbered=false,assignedInvoice=false;
const roles={admin:['*'],finance:['finance.view','payroll.view','reports.view'],people:['people.view','payroll.view','self_service.view']};
const actor=()=>({name:'UI Fixture '+role,email:role+'@example.test',roleCode:role,permissions:roles[role]});
const overview=()=>({data:{actor:actor(),today:'2026-09-24',commandStrip:{revenueActions:0,firstResponseMinutes:null,managerAlertMinutes:null,openEscalations:0,openTickets:0,commandPackReports:0},workspaces:{bookingsToday:0,ticketsNeedAttention:0,dayCloseStatus:'open',activeEmployees:1,aiHandoffsWaiting:0,aiTurnsToday:0,aiRolloutStage:'off'}}});
const ledger=()=>({source:'synthetic-ui-fixture',summary:{bookings:1,completed:1,invoiced:1350,collected:1350,refunded:100,receivable:0,reconciled:1,unreconciled:0,exceptions:0},items:[{booking_id:'UI-BOOKING-1',package_name:'Fixture care',booking_status:'completed',payment_status:'captured',gateway_status:'captured',reconciliation_status:'reconciled',captured_amount:1350,refunded_amount:100,variance_amount:0,invoice_number:'UI-INV-1'}]});
const payroll=()=>({data:{structures:[{id:'UI-STRUCTURE-1',structure_code:'UI-SALARY',version:1,status:'active_uat',effective_from:Date.now()}],runs:[{id:'UI-PAYROLL-1',period_start:Date.UTC(2026,8,1),period_end:Date.UTC(2026,8,30),status:runStatus,created_by:'maker@example.test',reviewed_by:'checker@example.test',approved_by:null}],truth:{statutoryPolicyConfigured:false,incentivePolicyConfigured:false,bankTransmissionEnabled:false,approvedRunImmutable:true,productionReady:false}}});
const training=()=>({data:{invoices:[{booking_id:'UI-TRAINING-1',commercial_total:1000,tax_amount:180,invoice_total:1180,payment_status:'captured',status:'draft_ready_for_number',invoice_number:numbered?'UI-TRAIN-INV-1':null},{booking_id:'UI-TRAINING-2',commercial_total:2000,tax_amount:null,invoice_total:null,payment_status:'pending',status:'configuration_required'}],earnings:[{status:'earned',gross_earning:500},{status:'pending_rate_configuration',gross_earning:0}],payouts:[{provider_id:'UI-TRAINER-1',period_code:'2026-09',earned_sessions:1,pending_sessions:0,held_sessions:0,earned_amount:500,status:'ready_for_finance_approval'}],taxPolicies:[],compensationRules:[],events:[],livePayout:false,executionMode:'sandbox',cancellation:{policies:[],cases:[],refunds:[],creditNotes:[],liveRefund:false,liveTaxFiling:false}}});
const reconciliation={data:{summary:{programmes:2,reconciled:1,exceptions:1},records:[{programmeId:'UI-PROG-2',bookingId:'UI-TRAINING-2',status:'exception',issues:['Fixture payment pending'],paymentStatus:'pending',invoiceStatus:'blocked'}],source:'synthetic-ui-fixture',liveMoney:false}};
const cash={data:{fromPeriod:'2026-09',toPeriod:'2026-09',openingCash:10000,closingCash:12500,netChangeInCash:2500,operating:{total:2500,lines:[{category:'fixture_receipts',inflow:2500,outflow:0,net:2500}]},investing:{total:0,lines:[]},financing:{total:0,lines:[]},reconciled:true}};
const recognition={data:{recognized:{recognizedRevenue:1000,events:1},deferred:{deferredSubscription:2000,advanceBookings:3000,total:5000}}};
const statutory=()=>({data:{serviceInvoices:[{id:'UI-INVOICE-1',invoice_number:'UI-INV-1',booking_id:'UI-BOOKING-1',gross_amount:1180,entity_id:assignedInvoice?'UI-ENTITY-1':null}],entities:[{id:'UI-ENTITY-1',legal_name:'UI Fixture Entity',status:'active'}],registrations:[{id:'UI-REG-1',entity_id:'UI-ENTITY-1',registration_reference:'UI TEST REGISTRATION',status:'active'}],policies:[],invoices:[],adjustments:[],vendorReviews:[],packages:[],mappings:[],exports:[],closeEvidence:[],productionReady:false,liveFilingEnabled:false,liveAccountingPostEnabled:false}});
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==ORIGIN){blockedExternal.push(url.origin+url.pathname);return route.abort();}
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()!=='GET'){
    const body=request.postDataJSON();writes.push({path:url.pathname,method:request.method(),body});
    if(url.pathname==='/api/payroll'){
      if(body.action==='approve'&&refuseApproval)return json(route,{error:'Fixture maker/checker approval refused'},403);
      if(body.action==='review')runStatus='reviewed';if(body.action==='approve')runStatus='approved';return json(route,{data:{sandboxOnly:true}});
    }
    if(url.pathname==='/api/training-finance'){if(body.action==='issue_invoice')numbered=true;return json(route,{data:{sandboxOnly:true}});}
    if(url.pathname==='/api/training-cancellation')return json(route,{data:{sandboxOnly:true}});
    if(url.pathname==='/api/gst-accounting'){assignedInvoice=true;return json(route,{data:{sandboxOnly:true}});}
    if(url.pathname==='/api/people-foundation')return json(route,{data:{employeeId:'UI-EMPLOYEE-1',status:'active',roleCode:body.roleCode,readiness:{ready:true,checks:[{code:'fixture_only',passed:true}]}}});
    return json(route,{error:'No synthetic mutation configured for this endpoint'},409);
  }
  reads.push(url.pathname+url.search);
  if(url.pathname==='/api/team-overview')return denyOverview?json(route,{error:'Fixture navigation unavailable'},503):json(route,overview());
  if(url.pathname==='/api/grooming-finance')return denyFinance?json(route,{error:'Fixture finance data unavailable'},503):json(route,ledger());
  if(url.pathname==='/api/payroll')return denyPayroll?json(route,{error:'Fixture payroll access denied'},403):json(route,payroll());
  if(url.pathname==='/api/training-finance')return json(route,training());
  if(url.pathname==='/api/training-reconciliation')return json(route,reconciliation);
  if(url.pathname==='/api/cash-flow-statement')return json(route,cash);
  if(url.pathname==='/api/revenue-recognition')return json(route,recognition);
  if(url.pathname==='/api/gst-accounting')return json(route,statutory());
  return json(route,{error:'Fixture: unconfigured API, not certified'},503);
});
const delay=ms=>page.waitForTimeout(ms);
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-module]').waitFor();await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-staff-workspace]')).getPropertyValue('--staff-surface').trim());await page.evaluate(()=>document.fonts.ready);await delay(450);}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',error:String(error)});console.log('FAIL '+name+' '+String(error));await shot('failure-'+results.length).catch(()=>{});}}
async function noOverflow(){const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=size.width+1,JSON.stringify(size));}
function lastWrite(path){return writes.filter(w=>w.path===path).at(-1)?.body;}
await check('Finance: canonical fixture amounts and original refresh endpoint',async()=>{
 await open('/team/finance');await page.getByText('UI-BOOKING-1',{exact:true}).waitFor();
 assert.match(await page.locator('tbody').innerText(),/1,350/);assert.match(await page.locator('tbody').innerText(),/100/);
 const count=reads.filter(r=>r==='/api/grooming-finance').length;await page.getByRole('button',{name:'Refresh',exact:true}).click();
 await page.waitForFunction(()=>!!document.querySelector('tbody')?.textContent?.includes('UI-BOOKING-1'));assert.ok(reads.filter(r=>r==='/api/grooming-finance').length>count);await shot('finance-populated');
});
await check('Finance: unavailable read hides previously displayed ledger, not a false zero report',async()=>{
 denyFinance=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Fixture finance data unavailable',{exact:true}).waitFor();assert.equal(await page.getByText('UI-BOOKING-1',{exact:true}).count(),0);denyFinance=false;
});
await check('Cash flow: cash, earned and deferred amounts remain distinct; month query preserved',async()=>{
 await open('/team/finance/cash-flow');await page.getByText('Cash received / closing cash',{exact:true}).waitFor();
 assert.match(await page.locator('main').innerText(),/12,500/);assert.match(await page.locator('main').innerText(),/5,000/);
 await page.locator('input[type="month"]').fill('2026-08');await delay(350);
 assert.ok(reads.includes('/api/cash-flow-statement?period=2026-08'));assert.ok(reads.includes('/api/revenue-recognition?period=2026-08'));await shot('cashflow-populated');
});
await check('Training: invoice eligibility and existing issue payload remain intact',async()=>{
 await open('/team/finance/training');const buttons=page.getByRole('button',{name:'Issue UAT invoice',exact:true});await buttons.first().waitFor();
 assert.equal(await buttons.first().isDisabled(),false);assert.equal(await buttons.nth(1).isDisabled(),true);
 page.once('dialog',d=>d.accept('UI invoice evidence'));await buttons.first().click();await page.getByText('UI-TRAIN-INV-1',{exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/training-finance'),{action:'issue_invoice',bookingId:'UI-TRAINING-1',reason:'UI invoice evidence'});await shot('training-populated');
});
await check('Training: sandbox payout approval retains provider, period and idempotency key',async()=>{
 page.once('dialog',d=>d.accept('UI payout review'));await page.getByRole('button',{name:'Approve sandbox instruction',exact:true}).click();await delay(350);
 assert.deepEqual(lastWrite('/api/training-finance'),{action:'approve_payout',providerId:'UI-TRAINER-1',periodCode:'2026-09',idempotencyKey:'training-payout:UI-TRAINER-1:2026-09',reason:'UI payout review'});
});
await check('Payroll: review, rejected approval, approval and sandbox preparation retain request shapes',async()=>{
 runStatus='calculated';await open('/team/people/payroll');await page.getByRole('button',{name:'Review payroll',exact:true}).click();await page.getByRole('button',{name:'Approve payroll',exact:true}).waitFor();
 assert.deepEqual(lastWrite('/api/payroll'),{action:'review',runId:'UI-PAYROLL-1'});
 refuseApproval=true;await page.getByRole('button',{name:'Approve payroll',exact:true}).click();await page.getByRole('alert').filter({hasText:'Fixture maker/checker approval refused'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Prepare sandbox payment',exact:true}).count(),0);
 refuseApproval=false;await page.getByRole('button',{name:'Approve payroll',exact:true}).click();await page.getByRole('button',{name:'Prepare sandbox payment',exact:true}).waitFor();assert.deepEqual(lastWrite('/api/payroll'),{action:'approve',runId:'UI-PAYROLL-1'});
 await page.getByRole('button',{name:'Prepare sandbox payment',exact:true}).click();await page.getByRole('status').filter({hasText:'no bank instruction transmitted'}).waitFor();assert.deepEqual(lastWrite('/api/payroll'),{action:'prepare_payment',runId:'UI-PAYROLL-1'});await shot('payroll-populated');
});
await check('Payroll: access refusal is visible and offers no payroll mutation buttons',async()=>{
 denyPayroll=true;await open('/team/people/payroll');await page.getByRole('alert').filter({hasText:'Fixture payroll access denied'}).waitFor();assert.equal(await page.getByRole('button',{name:'Prepare sandbox payment',exact:true}).count(),0);denyPayroll=false;
});
await check('GST ownership: required evidence, entity selection and existing assignment payload',async()=>{
 assignedInvoice=false;await open('/team/finance/statutory');await page.getByRole('combobox',{name:'Unassigned invoice',exact:true}).selectOption('UI-INVOICE-1');await page.getByRole('combobox',{name:'Legal entity',exact:true}).selectOption('UI-ENTITY-1');await page.getByRole('combobox',{name:'GST registration',exact:true}).selectOption('UI-REG-1');
 const evidence=page.getByLabel('Ownership evidence',{exact:true});assert.equal(await evidence.getAttribute('minlength'),'8');await evidence.fill('UI legal ownership evidence');await page.getByRole('button',{name:'Assign invoice ownership',exact:true}).click();
 await page.getByText('No unassigned service invoices in the current list.',{exact:true}).waitFor();assert.deepEqual(lastWrite('/api/gst-accounting'),{action:'assign_service_invoice_owner',invoiceId:'UI-INVOICE-1',entityId:'UI-ENTITY-1',registrationId:'UI-REG-1',reason:'UI legal ownership evidence'});await shot('statutory-populated');
});
await check('Employee onboarding: required fields, existing employment type and date payload',async()=>{
 await open('/team/people/onboarding');const button=page.getByRole('button',{name:'Activate employee',exact:true});assert.equal(await button.isDisabled(),true);
 for(const [label,value] of [['Employee code','UI-EMP-001'],['Display name','UI Fixture Employee'],['Work email','ui.employee@example.test'],['Joined date','2026-09-01']])await page.getByLabel(label,{exact:true}).fill(value);
 await button.click();await page.getByRole('heading',{name:'Activation complete',exact:true}).waitFor();const body=lastWrite('/api/people-foundation');
 assert.equal(body.action,'onboard_employee');assert.equal(body.employmentType,'direct_employee');assert.equal(body.roleCode,'associate');assert.equal(body.structureId,'UI-STRUCTURE-1');assert.equal(body.joinedAt,Date.parse('2026-09-01T00:00:00+05:30'));await shot('employee-onboarding');
});
function contrast(fg,bg){const channel=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};const luminance=s=>{const rgb=s.match(/[\d.]+/g).slice(0,3).map(Number).map(channel);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
for(const path of ['/team/finance','/team/finance/training','/team/people/payroll'])for(const theme of ['emerald','signature'])for(const mode of ['light','dark']) {
 await check(`Theme ${theme}/${mode} ${path}`,async()=>{
  await open(path);await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await delay(500);
  const sample=await page.locator('main').evaluate(e=>({font:getComputedStyle(e).fontFamily,theme:document.documentElement.dataset.pawTheme,mode:document.documentElement.dataset.pawMode}));assert.match(sample.font,/PawSpaceStaffNunito/);assert.equal(sample.theme,theme);assert.equal(sample.mode,mode);
  const button=page.locator('main button:not(:disabled)').first();await button.waitFor();const style=await button.evaluate(e=>{const s=getComputedStyle(e);return {fg:s.color,bg:s.backgroundColor,height:e.getBoundingClientRect().height};});
  assert.ok(contrast(style.fg,style.bg)>=4.5,JSON.stringify(style));assert.ok(style.height>=40);await shot(path.replaceAll('/','_')+'-'+theme+'-'+mode);
 });
}
const contract=JSON.parse(fs.readFileSync('tests/fixtures/staff-finance-people-contract.json','utf8'));
const paths=contract.pages.map(path=>path.replace(/^app/,""));
for(const width of [1440,1280,390])for(const path of paths){
 await check('Shell/responsive '+width+' '+path+' (fixture/unavailable boundary)',async()=>{
  await page.setViewportSize({width,height:1000});await open(path);await noOverflow();assert.equal(await page.locator('[data-staff-workspace]').count(),1);assert.equal(await page.locator('h1').count(),1);
  if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('searchbox',{name:'Find a workspace'}).waitFor();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
  if(width!==1280)await shot(path.replaceAll('/','_')+'-'+width);
 });
}
await check('Finance navigation: no customer or system-admin menu granted',async()=>{
 role='finance';await page.setViewportSize({width:1440,height:1000});await open('/team/finance');const nav=page.locator('nav[aria-label="Staff workspaces"]');assert.equal(await nav.getByText('Sales & customers',{exact:true}).count(),0);assert.equal(await nav.getByText('Settings & controls',{exact:true}).count(),0);assert.equal(await nav.getByText('Finance & compliance',{exact:true}).count(),1);role='admin';
});
await check('Navigation outage: finance refresh and existing page remain accessible',async()=>{
 denyOverview=true;await open('/team/finance');await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Refresh',exact:true}).isEnabled(),true);await page.getByText('UI-BOOKING-1',{exact:true}).waitFor();denyOverview=false;
});
await check('Customer and Partner apps: no standalone staff wrapper',async()=>{
 for(const path of ['/v2','/partner-app']){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await delay(500);assert.equal(await page.locator('[data-staff-workspace]').count(),0);assert.equal(await page.locator('[data-staff-module]').count(),0);}
});
await check('No unhandled browser errors during the isolated UI run',async()=>assert.deepEqual(pageErrors,[]));
fs.writeFileSync(OUT+'/browser-results.json',JSON.stringify({boundary:'Loopback synthetic UI; every API intercepted; no authenticated backend or live integration certification',results,reads,writes,blockedExternal,pageErrors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
