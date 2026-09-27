// Explicit, isolated, staging-only acceptance of merged PR #1142. Never part of `all`.
// No booking, payment, message, role edit or deployment. No traces, videos or credential output.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const origin='https://pawspace-staging.karthik-fce.workers.dev';
const expectedSha='074d603db4c03f53d2a27a55d19c1a82c4103ded';
const code=String(process.env.PAWSPACE_UAT_ACCESS_CODE||'');
const out=process.env.MASTER_OUT||'artifacts/master';fs.mkdirSync(out,{recursive:true});
const report={origin,expectedSha,startedAt:new Date().toISOString(),checks:[],unexpectedWrites:[],pageErrors:[]};
let browser,initialVersion,contactId;
const safeError=e=>String(e.message).split('\n')[0].replaceAll(code||'__no_secret__','[redacted]').slice(0,350);
async function check(name,fn){const at=Date.now();try{const detail=await fn();report.checks.push({name,ok:true,ms:Date.now()-at,detail});console.log('PASS',name,JSON.stringify(detail??{}));return true;}catch(e){const detail=safeError(e);report.checks.push({name,ok:false,ms:Date.now()-at,detail});console.log('FAIL',name,detail);return false;}}
function deployed(){
 const cli=['node_modules/wrangler/bin/wrangler.js'];
 const read=args=>JSON.parse(execFileSync(process.execPath,[...cli,...args,'--name','pawspace-staging','--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000}));
 const d=read(['deployments','status']);assert.equal(d.versions?.length,1,'Expected exactly one active version');assert.equal(d.versions[0].percentage,100);
 const id=d.versions[0].version_id;const v=read(['versions','view',id]);
 assert.equal(v.annotations?.['workers/message'],`staging ${expectedSha}`,'Staging changed: refusing to certify a different commit');
 const b=v.resources?.bindings||[],values=Object.fromEntries(b.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text]));
 assert.equal(values.PAWSPACE_PAYMENT_ENV,'sandbox');assert.equal(values.FORBID_PRODUCTION,'true');assert.equal(values.PAWSPACE_PAYMENT_LIVE_APPROVED,'false');
 const db=b.find(x=>x.name==='DB'&&x.type==='d1');assert.ok(db,'Missing D1 binding');assert.equal(db.id,process.env.STAGING_D1_ID,'Wrong staging database');
 return{version:id,sha:expectedSha,sandbox:true,dedicatedDatabaseVerified:true};
}
async function login(page,label,expectedRole){
 await page.goto('/staging-login',{waitUntil:'domcontentloaded'});
 await page.getByPlaceholder('shared UAT access code').fill(code);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/staging-login'&&r.request().method()==='POST');
 await page.getByRole('button',{name:label}).click();const r=await response;assert.equal(r.status(),200,`Sign-in HTTP ${r.status()}`);
 // The page performs a full navigation on success; Chromium may discard that POST's body.
 // Verify the new browser session from the server instead of reading a destroyed response body.
 await page.waitForURL(u=>u.pathname!=='/staging-login');
 const session=await page.context().request.get('/api/staging-login');assert.equal(session.status(),200);
 const signedIn=await session.json();assert.equal(signedIn.signedInAs?.role,expectedRole);
 return{status:200,role:expectedRole,destination:new URL(page.url()).pathname};
}
const staffPaths=['/api/team-overview','/api/crm','/api/customer-360'];
async function assertFounder(context){
 const statuses=[];
 for(const p of staffPaths){const r=await context.request.get(p);const b=await r.json();assert.equal(r.status(),200,`${p}: HTTP ${r.status()}`);if(p==='/api/team-overview'){assert.equal(b.data?.actor?.roleCode,'founder');assert.ok(b.data.actor.permissions.includes('*'));}statuses.push({path:p,status:200});}
 return{role:'founder',statuses};
}
try{
 assert.equal(process.env.STAGING_URL,origin);assert.equal(process.env.PAWSPACE_PAYMENT_ENV,'sandbox');assert.equal(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED,'false');assert.ok(code.length>=32,'Configured UAT code is missing');
 if(!await check('Live deployment exact SHA, sandbox and dedicated D1',async()=>{initialVersion=deployed();return initialVersion;}))throw Error('Deployment identity not established; no browser sign-in attempted');
 browser=await chromium.launch({headless:true});report.browserVersion=browser.version();
 const context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(45000);
 page.on('pageerror',e=>report.pageErrors.push(safeError(e)));
 await page.route('**/api/**',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(u.origin===origin&&!['GET','HEAD','OPTIONS'].includes(r.method())&&!['/api/staging-login','/api/uat-customer-switch'].includes(u.pathname)){
   report.unexpectedWrites.push({path:u.pathname,method:r.method()});return route.abort('blockedbyclient');
  }return route.continue();
 });
 await check('Anonymous callers cannot read any staff CRM surface',async()=>{const results=[];for(const p of staffPaths){const r=await context.request.get(p);assert.equal(r.status(),401);results.push({path:p,status:r.status()});}return results;});
 if(!await check('Founder UI sign-in succeeds',()=>login(page,/Founder \(full access\)/,'founder')))throw Error('Founder UI authentication failed');
 await check('All three staff APIs resolve the real Founder',()=>assertFounder(context));
 await check('CRM loads nonempty records',async()=>{const r=await context.request.get('/api/crm');assert.equal(r.status(),200);const b=await r.json();assert.ok(b.contacts?.length>0);contactId=String(b.contacts[0].id);return{count:b.contacts.length};});
 for(const p of ['/crm','/v2/crm'])await check(`Rendered CRM and staff navigation ${p}`,async()=>{
  const responses=[page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm'),page.waitForResponse(r=>new URL(r.url()).pathname==='/api/team-overview')];
  await page.goto(p,{waitUntil:'domcontentloaded'});for(const r of await Promise.all(responses))assert.equal(r.status(),200);
  await page.getByRole('heading',{name:'Customers & pets',exact:true}).waitFor();await page.locator('#staff-workspace-navigation').getByText('founder',{exact:true}).waitFor();
  assert.equal(await page.getByText('Permission denied',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Retry navigation',exact:true}).count(),0);
  return{crmStatus:200,menu:'founder',permissionError:false};
 });
 await check('CRM search and customer detail work with live server results',async()=>{
  assert.ok(contactId);const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm'&&new URL(r.url()).searchParams.get('search')===contactId);
  await page.getByPlaceholder('Search customer, phone or pet').fill(contactId);const r=await response,b=await r.json();assert.equal(r.status(),200);assert.ok(b.contacts.some(c=>c.id===contactId));
  await page.getByText('1 shown',{exact:true}).waitFor();
  const row=page.locator('button').filter({has:page.locator('strong').filter({hasText:b.contacts[0].name})}).first();await row.click();
  await page.getByRole('link',{name:'Open canonical 360 →',exact:true}).waitFor();return{matched:true,detailVisible:true};
 });
 await check('Canonical Sales / Customer 360 renders',async()=>{
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/customer-360');
  await page.goto('/team/sales',{waitUntil:'domcontentloaded'});assert.equal((await response).status(),200);
  await page.getByRole('heading',{name:'Sales & customers',exact:true}).waitFor();await page.getByRole('heading',{name:'Bookings',exact:true}).waitFor();
  assert.equal(await page.getByText('Permission denied',{exact:true}).count(),0);return{customer360Status:200,customerDetailVisible:true};
 });
 for(const width of [1440,390])await check(`Founder reload and menu access at ${width}px`,async()=>{
  await page.setViewportSize({width,height:width===390?844:1000});
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm');await page.goto('/v2/crm',{waitUntil:'domcontentloaded'});assert.equal((await response).status(),200);
  const reload=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/crm');await page.reload({waitUntil:'domcontentloaded'});assert.equal((await reload).status(),200);
  if(width===390)await page.getByRole('button',{name:'Open navigation',exact:true}).click();
  await page.locator('#staff-workspace-navigation').getByText('founder',{exact:true}).waitFor();
  if(width===390)await page.getByRole('button',{name:'Close navigation',exact:true}).click();
  return{width,status:200,menuRole:'founder'};
 });
 await page.setViewportSize({width:1440,height:1000});
 const customer=await check('Switch only to a listed synthetic customer (no OTP or messages)',async()=>{
  const options=await context.request.get('/api/uat-customer-switch');assert.equal(options.status(),200,'Fixed synthetic access must already be enabled');const o=await options.json();assert.equal(o.enabled,true);assert.ok(o.personas?.length);
  const result=await page.evaluate(async({code,persona})=>{const r=await fetch('/api/uat-customer-switch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,persona})});const b=await r.json();return{status:r.status,synthetic:b.data?.synthetic,error:b.error};},{code,persona:o.personas[0].key});
  assert.equal(result.status,200,result.error);assert.equal(result.synthetic,true);return{status:200,synthetic:true};
 });
 if(customer){
  await check('Customer stays denied on all staff APIs with actionable staff sign-in',async()=>{const statuses=[];for(const p of staffPaths){const r=await context.request.get(p),b=await r.json();assert.equal(r.status(),403);assert.equal(b.code,'staff_sign_in_required');assert.equal(b.signInUrl,'/staging-login');statuses.push({path:p,status:403});}return statuses;});
  await check('Customer CRM screen shows staff sign-in recovery',async()=>{await page.goto('/crm',{waitUntil:'domcontentloaded'});await page.getByRole('link',{name:'Sign in as staff',exact:true}).first().waitFor();assert.equal(await page.getByText('Permission denied',{exact:true}).count(),0);return{recoveryVisible:true};});
  await check('Returning to Founder overrides the retained customer cookie',async()=>{await login(page,/Founder \(full access\)/,'founder');const names=(await context.cookies()).map(c=>c.name);assert.ok(names.includes('pawspace_uat'));assert.ok(names.includes('pawspace_identity_session'));return{mixedCookiesPresent:true,...await assertFounder(context)};});
 }
 const partner=await check('Seeded partner-role staff UI sign-in succeeds',()=>login(page,/Employee — groomer \(self-service\)/,'service_provider'));
 if(partner){
  await check('Partner-role identity cannot read staff CRM surfaces',async()=>{const statuses=[];for(const p of staffPaths){const r=await context.request.get(p),b=await r.json();assert.equal(r.status(),403);assert.equal(b.code,'staff_sign_in_required');statuses.push({path:p,status:403});}return statuses;});
  await check('Partner-role CRM screen offers staff sign-in recovery',async()=>{await page.goto('/crm',{waitUntil:'domcontentloaded'});await page.getByRole('link',{name:'Sign in as staff',exact:true}).first().waitFor();return{recoveryVisible:true};});
  await check('Founder re-login restores access after partner testing',async()=>{await login(page,/Founder \(full access\)/,'founder');return assertFounder(context);});
 }
 await check('No browser JavaScript errors or unintended business writes',async()=>{assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.unexpectedWrites,[]);return{pageErrors:0,businessWrites:0};});
 await context.close();
 await check('Deployment remains unchanged after browser verification',async()=>{const after=deployed();assert.equal(after.version,initialVersion.version);return after;});
}catch(e){report.fatal=safeError(e);console.log('STOP',report.fatal);}
finally{if(browser)await browser.close();report.finishedAt=new Date().toISOString();report.passed=report.checks.filter(x=>x.ok).length;report.failed=report.checks.filter(x=>!x.ok).length;report.ok=report.failed===0&&!report.fatal;fs.writeFileSync(path.join(out,'founder-access-1142.json'),JSON.stringify(report,null,2));console.log('SUMMARY',JSON.stringify({passed:report.passed,failed:report.failed,ok:report.ok,fatal:report.fatal}));process.exitCode=report.ok?0:1;}
