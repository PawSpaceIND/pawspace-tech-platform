/** Read-only appearance audit on loopback. Blocks every API mutation and external request. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const origin='http://127.0.0.1:4318';
const out=process.env.AI_AUDIT_OUT||'.ui-audit/ai-surfaces-20260925/readonly';
fs.mkdirSync(out+'/screens',{recursive:true});
const browser=await chromium.launch({headless:false,slowMo:60,args:["--remote-debugging-port=9231","--remote-debugging-address=127.0.0.1"],executablePath:process.env.HOME+'/Library/Caches/ms-playwright/chromium-1193/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
const context=await browser.newContext({viewport:{width:1280,height:960},serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
const results=[],blockedWrites=[],external=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const voice={enabled:false,mode:'uat',deployment:'test',approved:false,allowlistSize:0,singleRecipient:false,telephonyConfigured:false,aiBindingConfigured:false,signingKeyConfigured:false,recording:false,maxCallSeconds:30,sampleRate:16000,reason:'Read-only UI fixture: voice providers disconnected'};
const employee={actor:{name:'UI Review',email:'review@example.test',roleCode:'associate'},capabilities:{chat:true,voice:true,customerScoped:true},customers:[{id:'UI-C1',name:'UI Customer',area:'HSR'}]};
await context.route('**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.origin!==origin){external.push(url.origin+url.pathname);return route.abort();}
 if(!['GET','HEAD'].includes(request.method())){blockedWrites.push(url.pathname);return json(route,{error:'Read-only audit: mutations are blocked'},409);}
 if(!url.pathname.startsWith('/api/'))return route.continue();
 if(url.pathname==='/api/mobile-employee-ai')return json(route,{data:employee});
 if(url.pathname==='/api/identity-session')return json(route,{error:'No authenticated account in this appearance audit'},401);
 if(url.pathname==='/api/team-overview')return json(route,{data:{actor:{name:'UI Reviewer',email:'review@example.test',roleCode:'founder',permissions:['*']}}});
 if(url.pathname==='/api/voice-outbound'&&url.searchParams.has('scope'))return json(route,{data:voice});
 if(url.pathname==='/api/service-availability')return json(route,{data:[]});
 return json(route,{error:'No API fixture: appearance/unavailable-state audit only'},503);
});
const paths=['/v2/chat','/chat','/mobile-app','/team/voice/ai-test','/team/voice','/team/ai','/team/ai/analytics','/team/ai/configuration','/team/ai/handoff','/team/ai/rollout','/team/bot-call-outcomes','/v2/food','/v2/relocation'];
const batch=process.env.AI_AUDIT_BATCH||'1280:emerald:light';
assert.match(batch,/^(1280|390):(emerald|signature):(light|dark)$/);
const [width,theme,mode]=batch.split(':');await page.setViewportSize({width:Number(width),height:960});
const save=completed=>fs.writeFileSync(out+'/results.json',JSON.stringify({completed,batch,scope:'Read-only visible local fixtures; no live authentication or provider execution',results,blockedWrites,external,errors},null,2));
const colour=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
function contrast(a,b){const luminance=s=>colour(s).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
async function appearance(){await page.evaluate(({theme,mode})=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);window.dispatchEvent(new Event('pawspace-appearance-change'));},{theme,mode});await page.waitForTimeout(150);}
async function metrics(locator){return locator.evaluate(e=>{const s=getComputedStyle(e);let p=e;while(p&&getComputedStyle(p).backgroundColor==='rgba(0, 0, 0, 0)')p=p.parentElement;return{font:s.fontFamily,size:parseFloat(s.fontSize),foreground:s.color,background:p?getComputedStyle(p).backgroundColor:'rgb(255,255,255)',primary:s.getPropertyValue('--brand-primary').trim(),staffPrimary:s.getPropertyValue('--staff-primary').trim()};});}
async function check(name,run){try{const stat=fs.statfsSync('.');assert.ok(stat.bavail*stat.bsize>250*1024*1024,'Insufficient free space for browser audit');await run();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(error){results.push({name,status:'FAIL',error:String(error)});console.log('FAIL '+name+' '+String(error));await page.screenshot({path:out+'/screens/fail-'+results.length+'.png'}).catch(()=>{});}save(false);}
try{
 for(const path of paths)await check('Read-only appearance '+batch+' '+path,async()=>{
  await page.goto(origin+path,{waitUntil:'domcontentloaded'});await appearance();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(450);
  let scope=page.locator('main').first(),heading=scope.locator('h1').first();
  if(path==='/mobile-app'){
   await page.getByRole('navigation',{name:'Customer navigation'}).getByRole('button',{name:'AI',exact:true}).click();
   scope=page.getByRole('region',{name:'Employee AI mobile workspace'});await scope.waitFor();heading=scope.getByRole('heading',{name:'AI Chat + Voice'});
   assert.equal(await scope.getByRole('button',{name:'Start voice',exact:true}).isDisabled(),true);
   assert.equal(await scope.getByRole('button',{name:'Send to AI',exact:true}).isDisabled(),true);
   const bg=mode==='dark'?(theme==='signature'?'rgb(25, 19, 34)':'rgb(12, 30, 24)'):(theme==='signature'?'rgb(247, 243, 255)':'rgb(255, 248, 238)');await page.waitForFunction(expected=>{const element=document.querySelector('main[data-pawspace-mobile] > section');return element&&getComputedStyle(element).backgroundColor===expected;},bg,{timeout:3000});const canvas=await metrics(page.locator('main[data-pawspace-mobile] > section').first());assert.equal(canvas.background,bg,'Employee AI outer shell');assert.match(canvas.font,/Nunito/);
  }
  await heading.waitFor();const computed=await metrics(heading);assert.match(computed.font,/Nunito/);assert.ok(computed.size>=24,JSON.stringify(computed));assert.ok(contrast(computed.foreground,computed.background)>=3,JSON.stringify(computed));
  const root=await metrics(scope),expected=mode==='dark'?(theme==='signature'?'#d3b8ff':'#c2e6d1'):(theme==='signature'?'#894aed':'#01261f');assert.equal(root.primary||root.staffPrimary,expected,JSON.stringify(root));
  const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
  if(path==='/team/voice/ai-test') {
   assert.equal(await page.getByRole('button',{name:'Test via Browser Mic',exact:true}).isDisabled(),true);
   assert.equal(await page.getByRole('button',{name:'Call my allow-listed number now',exact:true}).isDisabled(),true);
  }
  if(path==='/v2/chat'||path==='/chat') {
   await page.getByRole('button',{name:path==='/v2/chat'?'My PawSpace':'My account',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
  }
  await scope.scrollIntoViewIfNeeded();
  await page.screenshot({path:out+'/screens/'+path.replaceAll('/','_')+'.png'});
 });
 await check('Audit made no API mutation and raised no browser exception',async()=>{
  assert.deepEqual(blockedWrites,[]);assert.deepEqual(errors,[]);
 });
 save(true);
 console.log('TOTAL '+results.length+' PASS '+results.filter(x=>x.status==='PASS').length+' FAIL '+results.filter(x=>x.status==='FAIL').length);
 process.exitCode=results.some(x=>x.status==='FAIL')?1:0;
}finally{await context.close();await browser.close();}
