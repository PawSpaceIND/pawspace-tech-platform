import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
test.use({hasTouch:true});
const files=['app/v2/partner/layout.tsx','app/v2/partner/proof-appearance.module.css','app/trainer/page.tsx','app/trainer/trainer.module.css','app/host/proof/page.tsx','app/sitter/proof/page.tsx','app/team/operations/boarding/page.tsx','app/team/operations/sitting/page.tsx','lib/training-session-lifecycle.ts','lib/boarding-ops-governance.ts','lib/sitting-ops-governance.ts'];
const hashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const photo=(id:string,purpose:string)=>({id,ref:`media://asset/${id}`,mediaRef:`media://asset/${id}`,purpose,proofReady:true,scan_status:'clean',access_status:'ready',retention_status:'active',review_status:'approved',synthetic:0,updated_at:Date.now()});
const session=(id:string)=>({id,booking_id:`BOOK-${id}`,programme_id:`PROG-${id}`,provider_id:'PROVIDER',plan_name:`Synthetic session ${id}`,plan_code:'puppy',customer_name:'Synthetic pet parent',status:'in_session',programme_status:'active',scheduled_start:'2026-10-03T10:00:00Z',scheduled_end:'2026-10-03T11:00:00Z',sequence_no:1,total_sessions:2,completed_sessions:0,no_show_sessions:0,cancelled_sessions:0,petIds:['PET'],requirements:['Synthetic goal'],attendance:{},homework:{text:''},progress:{},evidenceRefs:[],ownerHandover:null,events:[]});
for(const [index,width] of [320,768,1101].entries())for(const style of ['professional','cartoon'])test(`Partner appearance ${width} ${style}`,async({page},info)=>{
 const theme=['emerald','signature','coral'][index%3],mode=style==='cartoon'?'dark':'light',reads:string[]=[],writes:Array<{path:string;payload:Record<string,unknown>}>=[],blocked:string[]=[],issues:Array<Record<string,unknown>>=[];
 let failProof=false,rejected=false,incidentOpen=true;
 await page.setViewportSize({width,height:900});await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent.v1','essential');},{style,theme,mode});
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(!url.hostname.match(/^(127\.0\.0\.1|localhost)$/)){blocked.push(url.origin);return route.abort();}
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()!=='GET'){
   const payload=request.postDataJSON() as Record<string,unknown>;writes.push({path:url.pathname,payload});
   if(['/api/boarding-proof','/api/sitting-proof'].includes(url.pathname)&&payload.action==='resolve_incident'){incidentOpen=false;return route.fulfill({json:{data:{status:'resolved'}}});}
   return route.fulfill({status:409,json:{error:'Every unmatched mutation is blocked by this local fixture'}});
  }
  reads.push(url.pathname+url.search);
  if(url.pathname==='/api/team-overview')return route.fulfill({json:{data:{actor:{name:'Synthetic staff',email:'fixture@test.invalid',roleCode:'founder',permissions:['*']},today:'2026-10-03',commandStrip:{},workspaces:{}}}});
  if(url.pathname==='/api/identity-session')return route.fulfill({json:{data:{subjectType:'provider',subjectId:'PROVIDER',roleCode:'provider',expiresAt:Date.now()+60000}}});
  if(url.pathname==='/api/provider-public-profile')return route.fulfill({json:{data:{displayName:'Synthetic trainer'}}});
  if(url.pathname==='/api/training-sessions')return route.fulfill({json:{data:[session('A'),session('B')]}});
  if(url.pathname==='/api/training-session-media'){const id=url.searchParams.get('sessionId')!;return route.fulfill({json:{data:{sessionId:id,assets:[photo(`${id}-before`,'before_service'),photo(`${id}-after`,'after_service')]}}});}
  if(['/api/boarding-proof','/api/sitting-proof'].includes(url.pathname)){
   if(failProof)return route.fulfill({status:503,json:{error:'Synthetic proof refresh failure'}});
   const boarding=url.pathname.includes('boarding'),id=url.searchParams.get(boarding?'stayId':'bookingId')!,media=[{...photo(id,boarding?'stay_update':'sitting_update'),scan_status:rejected?'rejected':'clean',access_status:rejected?'quarantined':'ready'}];
   return route.fulfill({json:{data:boarding?{stay:{id,bookingId:'BOOK-'+id,providerId:'PROVIDER',customerId:'CUSTOMER',status:'in_progress',carePlanStatus:'ready'},media,medication:[],incidents:[],storage:{mode:'fixture',adapterConnected:false},communications:{mode:'fixture',liveDelivery:false}}:{bookingId:id,status:'in_progress',media,medications:[],incidents:[],communications:{mode:'fixture',liveDelivery:false}}}});
  }
  if(['/api/boarding-ops','/api/sitting-ops'].includes(url.pathname)){
   const boarding=url.pathname.includes('boarding'),row={id:'SERVICE-A',booking_id:'BOOK-A',customer_name:'Synthetic parent',host_provider_id:'PROVIDER',provider_id:'PROVIDER',provider_name:'Synthetic provider',status:'in_progress',booking_status:'in_progress',payment_status:'captured',care_plan_status:'ready',priority:incidentOpen?'attention':'clear',exceptionFlags:incidentOpen?['care_incident']:[],incidents:[{id:'INC-1',severity:'attention',status:incidentOpen?'open':'resolved',summary:'Synthetic care incident',ops_status:incidentOpen?'open':'closed'}],refunds:[],notes:[],media:[],replacementCandidates:[]};
   return route.fulfill({json:{data:{[boarding?'stays':'bookings']:[row],metrics:{total:1,needsAttention:incidentOpen?1:0,clear:incidentOpen?0:1,recovery:0,openIncidents:incidentOpen?1:0,financeReview:0,mediaBlocked:0},readiness:{engineeringGate:'fixture',productionReady:false,externalDependencies:{}},source:'synthetic fixture'}}});
  }
  return route.fulfill({status:401,json:{error:'Unmatched read denied by local fixture'}});
 });
 for(const screen of ['trainer','host/proof','sitter/proof']){
  failProof=false;rejected=false;incidentOpen=true;const isOps=screen.startsWith('operations'),prefix=isOps?'/v2/team/':'/v2/partner/',query=screen==='host/proof'?'?stayId=A':screen==='sitter/proof'?'?bookingId=A':'';
  await page.goto(prefix+screen+query);await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);
  if(screen==='trainer'){
   await expect(page.getByRole('heading',{name:'Your canonical training sessions',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save report',exact:true})).toBeEnabled();
   await page.getByRole('button').filter({has:page.getByText('Synthetic session B',{exact:true})}).click();await expect(page.getByRole('heading',{name:'Synthetic session B',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save report',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Complete & consume one session',exact:true})).toBeDisabled();
  }else if(!isOps){
   const button=page.getByRole('button',{name:'Refresh photo approval',exact:true});await expect(button).toBeVisible();await expect(page.locator('input[type=file]')).toBeEnabled();
   await page.getByPlaceholder('Medication',{exact:true}).fill('Keep same-identity draft');rejected=true;await button.click();await expect(page.getByText(/Rejected at verification/)).toBeVisible();await expect(page.getByPlaceholder('Medication',{exact:true})).toHaveValue('Keep same-identity draft');
   failProof=true;await button.click();await expect(page.getByRole('alert').filter({hasText:'Synthetic proof refresh failure'})).toBeVisible();await expect(page.locator('input[type=file]')).toBeDisabled();
   failProof=false;rejected=false;await button.click();await expect(page.locator('input[type=file]')).toBeEnabled();
   await page.evaluate(q=>{history.pushState({},'',location.pathname+q);},screen==='host/proof'?'?stayId=B':'?bookingId=B');await expect(page.getByPlaceholder('Medication',{exact:true})).toHaveValue('');await expect(page.locator('input[type=file]')).toBeEnabled();
  }else{
   await expect(page.getByRole('heading',{name:/Operations exception queue/})).toBeVisible();const resolve=page.getByRole('button',{name:'Resolve incident',exact:true});await expect(resolve).toBeDisabled();await page.getByRole('textbox',{name:'Resolution note for incident INC-1',exact:true}).fill('Independent staff fixture resolution');await expect(resolve).toBeEnabled();const rect=(await resolve.boundingBox())!;if(rect.height<44)issues.push({screen,kind:'touch-target',text:'Resolve incident',height:rect.height});await resolve.scrollIntoViewIfNeeded();await expect(resolve).toBeInViewport();await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-open-${fingerprint}.png`),fullPage:true,animations:'disabled'});await resolve.click();await expect(resolve).toHaveCount(0);
   const write=writes.at(-1)!;expect(write.payload.incidentId).toBe('INC-1');expect(write.payload[screen.endsWith('boarding')?'stayId':'bookingId']).toBe('SERVICE-A');
  }
  const trigger=page.getByRole('button',{name:'Change PawSpace appearance',exact:true});
  await expect(trigger).toHaveCount(1);await trigger.scrollIntoViewIfNeeded();
  const baseline=await page.evaluate(()=>{const e=document.querySelector('.paw-appearance-trigger')!,r=e.getBoundingClientRect();const hits=[...document.querySelectorAll('main p,main h2,main h3')].flatMap(p=>{const range=document.createRange();range.selectNodeContents(p);return [...range.getClientRects()].filter(t=>r.left<t.right&&r.right>t.left&&r.top<t.bottom&&r.bottom>t.top).map(t=>({text:p.textContent,rect:{x:t.x,y:t.y,width:t.width,height:t.height}}));});return {position:getComputedStyle(e).position,rect:{x:r.x,y:r.y,width:r.width,height:r.height},textOverlaps:hits};});
  await info.attach(`${screen.replaceAll('/','-')}-utility-before-assertion`,{body:JSON.stringify(baseline),contentType:'application/json'});
  await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-utility.png`),fullPage:true,animations:'disabled'});
  if(baseline.position!=='static')issues.push({screen,kind:'floating-utility',baseline});expect(baseline.rect.width).toBeGreaterThanOrEqual(44);expect(baseline.rect.height).toBeGreaterThanOrEqual(44);expect(baseline.textOverlaps).toEqual([]);
  for(const fraction of [0,.25,.5,.75,1]){await page.evaluate(f=>scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*f),fraction);const overlaps=await page.evaluate(()=>{const e=document.querySelector('.paw-appearance-trigger')!,r=e.getBoundingClientRect();return [...document.querySelectorAll('main p,main h2,main h3')].flatMap(p=>{const range=document.createRange();range.selectNodeContents(p);return [...range.getClientRects()].filter(t=>r.left<t.right&&r.right>t.left&&r.top<t.bottom&&r.bottom>t.top).map(()=>p.textContent);});});await info.attach(`${screen.replaceAll('/','-')}-scroll-${fraction}`,{body:JSON.stringify({fraction,overlaps}),contentType:'application/json'});if(overlaps.length){issues.push({screen,kind:'utility-text-overlap',fraction,overlaps});await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-overlap-${fraction}.png`),fullPage:true,animations:'disabled'});}}
  await trigger.focus();await expect(trigger).toBeInViewport();await page.keyboard.press('Enter');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(trigger).toBeFocused();await trigger.tap();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Done',exact:true}).click();await expect(trigger).toBeFocused();
  await page.evaluate(()=>document.fonts.ready);const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('main button')].filter(e=>/Refresh photo approval|Resolve incident|Save report/.test(e.textContent||'')).map(e=>({text:e.textContent,height:e.getBoundingClientRect().height}))}));
  if(geometry.scrollWidth>width+1)issues.push({screen,kind:'overflow',geometry});for(const c of geometry.controls)if(c.height<44)issues.push({screen,kind:'touch-target',...c});
  await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-${fingerprint}.png`),fullPage:true,animations:'disabled'});
 }
 expect(writes.every(w=>w.payload.action==='resolve_incident')).toBe(true);await info.attach('exact-source-and-geometry',{body:JSON.stringify({width,style,theme,mode,hashes,fingerprint,reads,writes,blocked,issues,fixtureOnly:true,realAuthorization:false,physicalDevice:false}),contentType:'application/json'});expect(issues).toEqual([]);
});
