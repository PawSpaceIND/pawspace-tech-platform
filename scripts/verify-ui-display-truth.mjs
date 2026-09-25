/** Visible local UI checks. All business requests intercepted; no hosted authorization certificate. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
import {defaultRoles} from '../lib/platform-security.ts';
const ORIGIN='http://127.0.0.1:4318',OUT=process.env.UI_TRUTH_OUT||'.ui-audit/ui-truth-20260925/browser';fs.mkdirSync(OUT+'/screens',{recursive:true});
const browser=await chromium.launch({headless:false,slowMo:70,args:['--remote-debugging-port=9232','--remote-debugging-address=127.0.0.1'],executablePath:process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
let role='founder',overviewStatus=200,towerStatus=200,bookingsStatus=200,bookings=[],holdBooking=false,holdTower=false,releaseBooking,releaseTower,invalidOverview=false,overviewDelay=0;
const reads=[],writes=[],errors=[],results=[];page.on('pageerror',e=>errors.push(String(e)));
const permissions=()=>[...defaultRoles.find(r=>r.code===role).permissions];
const actor=()=>({name:'UI '+role,email:role+'@example.test',roleCode:role,permissions:permissions()});
const overview=()=>({data:{actor:actor(),today:'2026-09-25',commandStrip:{revenueActions:0,firstResponseMinutes:null,managerAlertMinutes:null,openEscalations:0,openTickets:0,commandPackReports:0},workspaces:{bookingsToday:0,ticketsNeedAttention:0,dayCloseStatus:null,activeEmployees:0,aiHandoffsWaiting:0,aiTurnsToday:0,aiRolloutStage:'off'}}});
const signals=['attention','critical','clear','unknown'].map((severity,i)=>({code:'UI-SIGNAL-'+i,severity,label:'Fixture '+severity,detail:'Synthetic signal state',count:i,view:'approvals'}));
const tower=()=>({data:{date:'2026-09-25',timezone:'Asia/Kolkata',headline:{signalsTracked:4,signalsClear:1,needsAttention:2,openItems:3},signals,posture:[],recentChanges:[],sourceStatus:{}}});
const sample={id:'UI-BOOKING-1',customer_name:'UI customer',service_code:'grooming',provider_name:'UI provider',provider_id:'UI-PROVIDER',status:'confirmed',payment_status:'pending',payment_amount:1350,amount_due_now:1350,scheduled_start:'2026-10-01T10:00:00+05:30',package_name:'UI bath',pets:[],lifecycle:[],operations:[],notifications:[],rebooking:[],refunds:[],tickets:[],adminActions:[]};
const json=(r,body,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
await context.route('**/*',async r=>{const req=r.request(),u=new URL(req.url());if(u.origin!==ORIGIN)return r.abort();if(!u.pathname.startsWith('/api/'))return r.continue();
 if(req.method()!=='GET'){writes.push({path:u.pathname,body:req.postDataJSON()});return json(r,{error:'Fixture action refused'},403);}reads.push(u.pathname+u.search);
 if(u.pathname==='/api/team-overview'){if(overviewDelay)await new Promise(r=>setTimeout(r,overviewDelay));return json(r,overviewStatus===200?(invalidOverview?{data:{actor:{permissions:'*'}}}:overview()):{error:'Fixture menu unavailable',signInUrl:'/staging-login'},overviewStatus);}
 if(u.pathname==='/api/control-tower'){if(holdTower)await new Promise(r=>{releaseTower=r;});return json(r,towerStatus===200?tower():{error:'Fixture control unavailable'},towerStatus);}
 if(u.pathname==='/api/booking-command-center'){if(holdBooking)await new Promise(r=>{releaseBooking=r;});return json(r,bookingsStatus===200?{bookings}:{error:'Fixture bookings unavailable'},bookingsStatus);}
 if(u.pathname==='/api/booking-command-center/stream')return r.fulfill({status:200,contentType:'text/event-stream',body:': synthetic UI review\n\n'});
 if(u.pathname==='/api/me')return json(r,{data:{linked:true,engagement:'contract',employee:{id:'UI-EMP',code:'UI-EMP',name:'UI employee',workEmail:'employee@example.test',joinedAt:Date.now()},incentives:{list:[],approvedTotal:0},dailyIncentive:{list:[],total:0},advances:{list:[],outstanding:0},leave:{balances:[],requests:[]},attendance:[]}});
 if(u.pathname==='/api/crm')return json(r,{contacts:[]});
 return json(r,{error:'No fixture for this endpoint'},503);
});
async function open(path){await page.goto(ORIGIN+path,{waitUntil:'domcontentloaded'});await page.locator('[data-staff-workspace]').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(180);await page.evaluate(()=>document.title='PawSpace V2 - VISIBLE UI STATUS CHECK - SYNTHETIC DATA');}
async function shot(name){await page.screenshot({path:OUT+'/screens/'+name+'.png'});}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.log('FAIL '+name+' '+String(e));await shot('failure-'+results.length).catch(()=>{});}fs.writeFileSync(OUT+'/progress.json',JSON.stringify(results,null,2));}
function rgb(s){if(s.startsWith('#')){let h=s.slice(1);if(h.length===3)h=h.split('').map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}return s.match(/[0-9.]+/g).slice(0,3).map(Number);}
function contrast(a,b){const lum=s=>rgb(s).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
const values=async(label,tag)=>page.getByRole('region',{name:label}).locator(tag).allTextContents();
await check('Booking metrics: loading is unknown; a successfully loaded empty snapshot is genuinely zero',async()=>{
 holdBooking=true;await open('/v2/control-center');assert.deepEqual(await values('Booking snapshot metrics','b'),['\u2014','\u2014','\u2014','\u2014']);
 holdBooking=false;assert.equal(typeof releaseBooking,'function');releaseBooking();await page.getByText('No canonical bookings yet',{exact:true}).waitFor();
 const zero=await values('Booking snapshot metrics','b');assert.deepEqual(zero.slice(0,3),['0','0','0']);assert.match(zero[3],/0/);await shot('bookings-empty-verified');
});
await check('Booking errors never show false zero or stale revenue; retry uses the original endpoint',async()=>{
 bookings=[sample];await page.getByRole('button',{name:'Refresh snapshot',exact:false}).click();await page.getByRole('button',{name:/UI-BOOKING-1/}).waitFor();
 assert.deepEqual((await values('Booking snapshot metrics','b')).slice(0,3),['1','0','1']);bookingsStatus=503;
 await page.getByRole('button',{name:'Refresh snapshot',exact:false}).click();await page.getByText('Fixture bookings unavailable',{exact:false}).waitFor();
 assert.deepEqual(await values('Booking snapshot metrics','b'),['\u2014','\u2014','\u2014','\u2014']);await shot('bookings-unavailable');
 bookingsStatus=200;await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByRole('button',{name:/UI-BOOKING-1/}).waitFor();
 assert.match((await values('Booking snapshot metrics','b'))[3],/1,350/);
});
await check('Booking deep links, selection and action payloads are unchanged',async()=>{
 await open('/v2/control-center?bookingId=UI-BOOKING-1');await page.locator('main').getByRole('button',{name:/Call$/}).click();await page.getByText('Fixture action refused',{exact:true}).waitFor();
 assert.deepEqual(writes.at(-1),{path:'/api/booking-command-center',body:{bookingId:'UI-BOOKING-1',action:'call_customer',reason:'Customer service and booking follow-up'}});
 assert.ok(reads.includes('/api/booking-command-center?q=UI-BOOKING-1'));
});
await check('Control: loading numbers and failed sources remain unavailable, not healthy or zero',async()=>{
 holdTower=true;await open('/control');assert.deepEqual(await values('Control snapshot metrics','strong'),['\u2014','\u2014','\u2014','\u2014']);holdTower=false;releaseTower();
 await page.getByText('Fixture attention',{exact:true}).waitFor();towerStatus=503;await open('/control');await page.getByText('Fixture control unavailable',{exact:true}).waitFor();
 assert.deepEqual(await values('Control snapshot metrics','strong'),['\u2014','\u2014','\u2014','\u2014']);assert.equal(await page.getByText('No governed changes recorded yet.',{exact:true}).count(),0);await shot('control-unavailable');towerStatus=200;
});
await check('Control: attention, critical, clear and unknown labels match their source severity',async()=>{
 await open('/control');await page.getByText('Fixture attention',{exact:true}).waitFor();assert.deepEqual(await values('Control snapshot metrics','strong'),['4','2','1','3']);
 for(const [severity,label]of Object.entries({attention:'Needs attention',critical:'Action required',clear:'Clear',unknown:'Status unavailable'}))assert.equal(await page.locator('[data-signal-severity="'+severity+'"]').innerText(),label);
 await shot('control-accurate-signals');
});
const linkDefinitions=[...fs.readFileSync('app/components/staff-workspace/navigation.ts','utf8').matchAll(/\{ label: "([^"]+)", href: "([^"]+)", permission: "([^"]+)"/g)].map(m=>({href:m[2],permission:m[3]}));
assert.equal(linkDefinitions.length,32);
for(const staffRole of defaultRoles.filter(r=>r.permissions.includes('*')||r.permissions.includes('dashboard.view')))await check('Menu renders only existing allowed destinations for '+staffRole.code,async()=>{
 role=staffRole.code;overviewStatus=200;invalidOverview=false;await open('/team');await page.locator('aside[aria-label="Team workspace navigation"]').getByText('UI '+role,{exact:true}).waitFor();
 const shown=await page.locator('nav[aria-label="Staff workspaces"] a').evaluateAll(a=>a.map(x=>x.getAttribute('href')).filter(x=>x!=='/team').sort());
 const expected=linkDefinitions.filter(l=>permissions().includes('*')||permissions().includes(l.permission)).map(l=>l.href).sort();assert.deepEqual(shown,expected);
});
await check('Menu search never reveals forbidden customer, payroll or settings routes',async()=>{
 role='finance';await open('/team');await page.getByRole('searchbox',{name:'Find a workspace',exact:true}).fill('customer');
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] a[href="/crm"]').count(),0);await page.getByText('No permitted workspace matches your search.',{exact:true}).waitFor();
});
await check('Changed route does not retain the previous role while a fresh navigation read is pending',async()=>{
 role='founder';await open('/control');await page.locator('aside[aria-label="Team workspace navigation"]').getByText('UI founder',{exact:true}).waitFor();
 await page.getByRole('searchbox',{name:'Find a workspace',exact:true}).fill('Leads');role='finance';overviewDelay=1000;
 await page.getByRole('link',{name:'Leads & CRM',exact:true}).click();await page.waitForURL('**/crm');
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] a[href="/control"]').count(),0);
 await page.locator('aside[aria-label="Team workspace navigation"]').getByText('UI finance',{exact:true}).waitFor();overviewDelay=0;
});
await check('Malformed permissions cannot retain an old role; retry reloads the existing source',async()=>{
 invalidOverview=true;await open('/crm');await page.getByRole('button',{name:'Retry navigation',exact:true}).waitFor();assert.equal(await page.locator('nav[aria-label="Staff workspaces"] a').count(),1);
 invalidOverview=false;role='associate';await page.getByRole('button',{name:'Retry navigation',exact:true}).click();await page.locator('aside[aria-label="Team workspace navigation"]').getByText('UI associate',{exact:true}).waitFor();
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] a[href="/team/people/payroll"]').count(),0);
});
await check('A self-service-only menu refusal keeps employee content available without granting Team access',async()=>{
 overviewStatus=403;await open('/me');await page.getByText('Current page: My workspace',{exact:true}).waitFor();await page.getByRole('button',{name:'Check in',exact:true}).waitFor();
 assert.equal(await page.locator('nav[aria-label="Staff workspaces"] a').count(),1);assert.equal(await page.getByRole('heading',{name:'My salary',exact:true}).count(),0);await shot('self-service-menu-refusal');overviewStatus=200;
});
for(const width of [1280,390])for(const theme of ['emerald','signature'])for(const mode of ['light','dark'])await check('Status readability '+width+' '+theme+'/'+mode,async()=>{
 role='founder';overviewStatus=200;bookingsStatus=503;await page.setViewportSize({width,height:1000});await open('/v2/control-center');
 await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});
 await page.getByText('Snapshot unavailable',{exact:true}).waitFor();assert.deepEqual(await values('Booking snapshot metrics','b'),['\u2014','\u2014','\u2014','\u2014']);
 await open('/control');await page.getByText('Fixture attention',{exact:true}).waitFor();const size=await page.evaluate(()=>({w:innerWidth,s:document.documentElement.scrollWidth}));assert.ok(size.s<=size.w+1,JSON.stringify(size));
 const labels=await page.locator('[data-signal-severity]').evaluateAll(nodes=>nodes.map(e=>{const s=getComputedStyle(e),severity=e.getAttribute('data-signal-severity'),tone=severity==='critical'?'danger':severity==='attention'?'warning':severity==='clear'?'success':'muted';return {font:parseFloat(s.fontSize),height:e.clientHeight,scrollHeight:e.scrollHeight,width:e.clientWidth,scrollWidth:e.scrollWidth,color:s.color,background:s.backgroundColor,expected:s.getPropertyValue('--staff-'+tone).trim()};}));assert.equal(labels.length,4);
 for(const label of labels){assert.ok(label.font>=12,JSON.stringify(label));assert.ok(label.scrollWidth<=label.width+1,JSON.stringify(label));assert.deepEqual(rgb(label.color),rgb(label.expected));assert.ok(contrast(label.color,label.background)>=4.5,JSON.stringify(label));}
 if(width===390){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Close navigation',exact:true}).click();}
 await shot('status-'+width+'-'+theme+'-'+mode);
});
await check('No unhandled browser exception and only the intended refused test write',async()=>{assert.deepEqual(errors,[]);assert.equal(writes.length,1);});
fs.writeFileSync(OUT+'/results.json',JSON.stringify({completed:true,boundary:'Visible Chromium, synthetic API fixtures, no real writes',results,reads,writes,errors},null,2));
console.log('TOTAL '+results.length+' PASS '+results.filter(r=>r.status==='PASS').length+' FAIL '+results.filter(r=>r.status==='FAIL').length);
await context.close();await browser.close();process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
