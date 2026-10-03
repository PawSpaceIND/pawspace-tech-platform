import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['app/team/finance/page.tsx','app/team/finance/finance-ledger.tsx','app/team/finance/grooming-gst-panel.tsx','app/team/finance/finance-content.module.css','app/team/operations/page.tsx','app/team/people/page.tsx','app/team/presentation-next/staff-content.module.css','app/team/finance/boarding/boarding-finance-workspace.tsx','app/team/finance/boarding/boarding-content.module.css','app/team/finance/sitting/sitting-finance-workspace.tsx','app/team/finance/sitting/sitting-content.module.css','app/team/finance/training/page.tsx','app/team/finance/training/training-content.module.css','app/team/people/provider-training/page.tsx','app/team/people/provider-training/provider-training-content.module.css'];
const hashes=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
// Composite transparent paint through the actual ancestor backgrounds before measuring text.
function contrastRatio(foreground:string,backgrounds:string[]){
 const parse=(color:string)=>{
  const match=/^(rgb|rgba)\(([^()]*)\)$/.exec(color.trim());
  if(!match)throw new Error(`Unsupported contrast paint: ${color}`);
  const parts=match[2].split(',').map(value=>value.trim());
  if(parts.length!==(match[1]==='rgb'?3:4)||parts.some(value=>!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)))throw new Error(`Invalid contrast paint: ${color}`);
  const values=parts.map(Number),rgb=values.slice(0,3),alpha=values[3]??1;
  if(rgb.some(channel=>!Number.isFinite(channel)||channel<0||channel>255)||!Number.isFinite(alpha)||alpha<0||alpha>1)throw new Error(`Out-of-range contrast paint: ${color}`);
  return {rgb,alpha};
 };
 const paint=(color:string,under:number[])=>{const {rgb,alpha}=parse(color);return rgb.map((channel,i)=>channel*alpha+under[i]*(1-alpha));};
 if(!backgrounds.some(color=>parse(color).alpha===1))throw new Error('An opaque contrast backdrop is required');
 const background=backgrounds.reduce((under,color)=>paint(color,under),[255,255,255]);
 const lum=(rgb:number[])=>rgb.map(channel=>{const c=channel/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
 const a=lum(paint(foreground,background)),b=lum(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}
function textPaint(element:Element){
 const backgrounds:string[]=[];
 for(let node:Element|null=element;node;node=node.parentElement){
  const style=getComputedStyle(node);
  if(style.backgroundImage!=='none'||style.opacity!=='1'||style.filter!=='none'||style.backdropFilter!=='none'||style.mixBlendMode!=='normal'||style.textShadow!=='none')throw new Error('Unsupported contrast paint effect');
  backgrounds.push(style.backgroundColor);
 }
 return {foreground:getComputedStyle(element).color,backgrounds:backgrounds.reverse()};
}
test('contrast calculation composites transparent paint and still rejects faint text',()=>{
 expect(contrastRatio('rgb(72,47,43)',['rgb(255,248,244)','rgba(0,0,0,0)'])).toBeGreaterThanOrEqual(4.5);
 expect(contrastRatio('rgb(164,56,48)',['rgb(255,248,244)'])).toBeCloseTo(6.271,3);
 expect(contrastRatio('rgba(0,0,0,0.1)',['rgb(255,255,255)'])).toBeLessThan(4.5);
 expect(contrastRatio('rgb(200,200,200)',['rgb(255,255,255)'])).toBeLessThan(4.5);
});
test('contrast rejects unsupported syntax and invalid channel ranges',()=>{
 for(const color of ['color(display-p3 0.8 0.8 0.8)','rgb(256,0,0)','rgb(-1,0,0)','rgba(0,0,0,1.1)','rgb(20%,20%,20%)','rgb(NaN,0,0)'])expect(()=>contrastRatio(color,['rgb(255,255,255)'])).toThrow();
 expect(()=>contrastRatio('rgb(0,0,0)',['rgba(0,0,0,0)'])).toThrow(/opaque/);
});
test('actual element and header paint cannot hide low contrast or unsupported effects',async({page})=>{
 await page.setContent('<main style="background:rgb(255,255,255)"><header style="background:rgb(80,50,45)"><small style="color:rgb(72,47,43)">Measured label</small></header></main>');
 const label=page.locator('small'),paint=await label.evaluate(textPaint);
 expect(contrastRatio(paint.foreground,['rgb(255,255,255)'])).toBeGreaterThanOrEqual(4.5);
 expect(contrastRatio(paint.foreground,paint.backgrounds)).toBeLessThan(4.5);
 await page.locator('header').evaluate(element=>{(element as HTMLElement).style.opacity='0.5';});
 await expect(label.evaluate(textPaint)).rejects.toThrow(/Unsupported contrast paint effect/);
 await page.locator('header').evaluate(element=>{(element as HTMLElement).style.opacity='1';});
 await label.evaluate(element=>{(element as HTMLElement).style.color='color(display-p3 0.8 0.8 0.8)';});
 const unsupported=await label.evaluate(textPaint);expect(()=>contrastRatio(unsupported.foreground,unsupported.backgrounds)).toThrow(/Unsupported contrast paint/);
});
const item={bookingId:'FINANCE-UI',serviceCode:'boarding',packageName:'Synthetic two pet stay',bookingStatus:'confirmed',scheduledStart:null,bookingTotal:1398,paymentId:'PAY-UI',paymentStatus:'captured',paymentMode:'prepaid',amountDueNow:1398,scheduleStatus:'paid',balanceAmount:0,capturedAmount:1398,refundedAmount:279.60,netCollected:1118.40,gatewayStatus:'captured',reconciliationStatus:'matched',varianceAmount:0,openExceptions:0,invoiceNumber:'UI-INVOICE'};
const data={services:[{code:'boarding',label:'Boarding',workspace:'/team/finance/boarding',bookings:1,paidBookings:1,captured:1398,refunded:279.60,attention:0}],items:[item],openExceptions:0,limit:100};
for(const [i,width] of [320,412,820,1440].entries())for(const style of ['professional','cartoon'])test(`staff finish routes ${width} ${style}`,async({page},info)=>{
 const theme=['emerald','signature','coral'][i%3],mode=style==='cartoon'?'dark':'light',writes:string[]=[],reads:string[]=[];
 await page.setViewportSize({width,height:900});
 await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent.v1','essential');},{style,theme,mode});
 await page.route('**/api/**',async route=>{const r=route.request(),url=new URL(r.url());
  if(r.method()!=='GET'){writes.push(url.pathname);return route.fulfill({status:409,json:{error:'UI fixture blocks every mutation'}});}
  reads.push(url.pathname+url.search);
  if(url.pathname==='/api/team-overview')return route.fulfill({json:{data:{actor:{name:'Synthetic UI reviewer',email:'fixture@test.invalid',roleCode:'founder',permissions:['*']},today:'2026-10-01',commandStrip:{},workspaces:{}}}});
  if(url.pathname==='/api/payment-reconciliation')return route.fulfill({json:{data}});
  if(url.pathname==='/api/grooming-finance')return route.fulfill({json:{data:{platform:{settingId:null,cityId:'*',scope:'built_in_default',ratePercent:18,method:'percent_of_base',effectiveFrom:null,version:0},cities:[],history:[]}}});
  if(url.pathname==='/api/boarding-finance')return route.fulfill({json:{data:url.searchParams.get('view')==='queue'?{items:[{booking_id:'FINANCE-UI',package_name:'Synthetic two pet stay',stay_status:'active',payment_status:'captured',pending_refunds:1,pending_refund_amount:279.6}],limit:100}:{bookingId:'FINANCE-UI',stay:{booking_status:'confirmed',stay_status:'active',total_amount:1398,payment_status:'captured',package_name:'Synthetic two pet stay',check_in_at:'2026-10-01',check_out_at:'2026-10-03',host_provider_id:'UI-HOST',city_id:'blr'},cancellations:[{id:'C-UI',status:'policy_review_required',reason:'Synthetic fixture only'}],refunds:[{id:'R-UI',status:'sandbox_pending',amount:279.6}],changes:[],settlement:null,reconciliation:null}}});
  if(url.pathname==='/api/sitting-finance')return route.fulfill({json:{data:{booking:{id:'SITTING-UI',status:'completed',total_amount:548.6,captured_amount:548.6,payment_status:'captured'},cancellations:[{id:'C-SITTING-UI',status:'policy_review_required',reason:'Synthetic fixture only'}],refunds:[{id:'R-SITTING-UI',amount:279.6,status:'sandbox_pending'}],dateChanges:[],settlement:null,reconciliation:null,sandboxOnly:true}}});
  if(url.pathname==='/api/training-finance')return route.fulfill({json:{data:{invoices:[{booking_id:'UI-TRAINING-PAID',commercial_total:1200,tax_amount:216,invoice_total:1416,payment_status:'FULLY_PAID',status:'draft_ready_for_number',invoice_number:null},{booking_id:'UI-TRAINING-PENDING',commercial_total:1200,tax_amount:216,invoice_total:1416,payment_status:'PARTIALLY_PAID',status:'draft_ready_for_number',invoice_number:null}],earnings:[],payouts:[{provider_id:'UI-TRAINER',period_code:'2026-10',earned_sessions:2,pending_sessions:0,held_sessions:0,earned_amount:500,status:'ready_for_finance_approval'}],taxPolicies:[],compensationRules:[],events:[],livePayout:false,executionMode:'sandbox',cancellation:{policies:[],cases:[],refunds:[],creditNotes:[],liveRefund:false,liveTaxFiling:false}}}});
  if(url.pathname==='/api/training-reconciliation')return route.fulfill({json:{data:{summary:{programmes:2,reconciled:2,exceptions:0},records:[],source:'synthetic UI fixture',liveMoney:false}}});
  if(url.pathname==='/api/provider-lms')return route.fulfill({json:{data:{modules:[],providers:[],metrics:{published:0,draft:0,providersNotReady:0}}}});
  if(url.pathname==='/api/people-foundation')return route.fulfill({json:{data:{employees:[{id:'EMP-UI',employee_code:'UI-001',display_name:'Synthetic reviewer',work_email:'fixture@test.invalid',employment_status:'active',title:'UI test role',team_code:'UI',sensitiveMasked:true}]}}});
  return route.fulfill({status:401,json:{error:'Isolated UI fixture; unavailable data stays unavailable'}});
 });
 for(const screen of ['finance','operations','people','finance/boarding','finance/training','finance/sitting','people/provider-training']){
  await page.goto(`/team/${screen}${screen==='finance/boarding'?'?bookingId=FINANCE-UI':screen==='finance/sitting'?'?bookingId=SITTING-UI':''}`);await expect(page.locator('html')).toHaveAttribute('data-paw-theme',theme);await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
  const content=page.locator('#staff-workspace-content');await expect(content).toBeVisible();
  if(screen==='finance'){
   await expect(content.getByRole('heading',{name:'Service finance & reconciliation'})).toBeVisible();await expect(content.locator('[data-booking-id=FINANCE-UI]')).toContainText('UI-INVOICE');
   const publish=content.getByRole('button',{name:'Publish GST setting',exact:true});await expect(publish).toBeDisabled();
   await content.getByRole('button',{name:'Boarding',exact:true}).click();await expect.poll(()=>reads.some(x=>x.includes('payment-reconciliation?view=bookings&service=boarding'))).toBe(true);
   for(const region of await content.getByRole('region',{name:/scroll horizontally/}).all()){await page.keyboard.press('Tab');await region.focus();expect(await region.evaluate(e=>getComputedStyle(e).outlineOffset)).toBe('-3px');}
  }else if(screen==='finance/boarding'){
   await expect(content.getByRole('heading',{name:'Boarding finance & reconciliation'})).toBeVisible();
   await expect(content.getByRole('button',{name:'Prepare canonical settlement',exact:true})).toBeDisabled();
   await expect(content.getByRole('button',{name:'Record sandbox refund',exact:true})).toBeVisible();
   await expect(content.getByText('₹279.60',{exact:true})).toBeVisible();
   const lookup=content.getByRole('textbox',{name:'Boarding booking ID'});await expect(lookup).toHaveValue('FINANCE-UI');
   await content.getByRole('button',{name:'Load booking',exact:true}).click();await expect(lookup).toHaveValue('FINANCE-UI');
   await expect.poll(()=>reads.filter(x=>x.includes('boarding-finance?bookingId=FINANCE-UI')).length).toBeGreaterThanOrEqual(2);
   for(const el of await content.locator('main button,main input,main header a').all()){if(await el.isVisible())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);}
   if(width<=600){const inputRect=(await lookup.boundingBox())!,buttonRect=(await content.getByRole('button',{name:'Load booking',exact:true}).boundingBox())!;expect(buttonRect.y).toBeGreaterThanOrEqual(inputRect.y+inputRect.height);}
  }else if(screen==='finance/training'){
   await expect(content.getByRole('heading',{name:'Training finance & payout readiness'})).toBeVisible();
   await expect(content.getByRole('row').filter({hasText:'UI-TRAINING-PAID'}).getByRole('button',{name:'Issue UAT invoice',exact:true})).toBeEnabled();
   // Reports must hydrate before measuring the loaded page; a heading also exists in unstyled SSR.
   await page.evaluate(()=>document.fonts.ready);
   const colors=await content.locator('main header small').evaluate(textPaint);
   expect(contrastRatio(colors.foreground,colors.backgrounds)).toBeGreaterThanOrEqual(4.5);
   await expect(content.getByRole('row').filter({hasText:'UI-TRAINING-PENDING'}).getByRole('button',{name:'Issue UAT invoice',exact:true})).toBeDisabled();
   await expect(content.getByRole('button',{name:'Approve sandbox instruction',exact:true})).toBeEnabled();
   const regions=content.getByRole('region',{name:/scroll horizontally/});await expect(regions).toHaveCount(3);
   for(const region of await regions.all()){await page.keyboard.press('Tab');await region.focus();expect(await region.evaluate(e=>e===document.activeElement)).toBe(true);expect(await region.evaluate(e=>getComputedStyle(e).outlineOffset)).toBe('-3px');await region.evaluate(e=>{e.scrollLeft=0;});if(await region.evaluate(e=>e.scrollWidth>e.clientWidth)){await page.keyboard.press('ArrowRight');await expect.poll(()=>region.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);}}
   for(const el of await content.locator('main button,main header a').all()){if(await el.isVisible())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);}
  }else if(screen==='finance/sitting'){
   await expect(content.getByRole('heading',{name:'Sitting finance & reconciliation',exact:true})).toBeVisible();
   await expect(content.getByText('₹279.60',{exact:true})).toBeVisible();
   const lookup=content.getByPlaceholder('Canonical Sitting booking ID');await expect(lookup).toHaveValue('SITTING-UI');await lookup.focus();expect(await lookup.evaluate(e=>e===document.activeElement)).toBe(true);
   for(const el of await content.locator('main button,main input,main header a').all()){if(await el.isVisible())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);}
   await lookup.fill('OTHER-SITTING-ID');await expect(content.getByRole('button',{name:'Record sandbox refund',exact:true})).toHaveCount(0);
   await lookup.fill('SITTING-UI');await content.getByRole('button',{name:'Load booking',exact:true}).click();await expect(content.getByText('₹279.60',{exact:true})).toBeVisible();
  }else if(screen==='people/provider-training'){
   await expect(content.getByRole('heading',{name:'Provider training & SOP library',exact:true})).toBeVisible();
   for(const name of ['Title','Summary','Content sections (one per line)','Quiz question','Quiz options (separate with |; first index is 0)']){const field=content.getByLabel(name,{exact:true});await expect(field).toBeVisible();await field.focus();expect(await field.evaluate(e=>e===document.activeElement)).toBe(true);}
   const service=content.getByRole('combobox',{name:'Service',exact:true});await expect(service).toBeVisible();await expect(service).toHaveValue('all');await service.focus();expect(await service.evaluate(e=>e===document.activeElement)).toBe(true);
   await expect(content.getByLabel('Pass %',{exact:true})).toHaveValue('80');
   for(const el of await content.locator('main button,main input,main select,main header a').all())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);
   await expect(content.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
  }else if(screen==='operations')await expect(content.getByRole('link').filter({hasText:'Open →'})).toHaveCount(5);
  else {const search=content.getByRole('textbox',{name:'Find someone'});await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();await search.fill('does-not-match');await expect(content.getByText('No one matches “does-not-match”',{exact:true})).toBeVisible();await search.fill('');await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();}
  await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  for(const el of await content.locator('button,input:not([type=radio]),select').all()){if(!await el.isVisible())continue;expect((await el.boundingBox())!.height,await el.evaluate(e=>`${e.tagName} ${e.getAttribute('aria-label')||e.textContent||e.getAttribute('type')}`)).toBeGreaterThanOrEqual(44);}
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();document.querySelectorAll('[role=region]').forEach(e=>{e.scrollLeft=0;});scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-${fingerprint}.png`),fullPage:true,animations:'disabled'});
 }
 expect(writes).toEqual([]);await info.attach('fixture-and-source',{body:JSON.stringify({width,style,theme,mode,fingerprint,hashes,writes,reads,authorizationAcceptance:false,physicalDevice:false}),contentType:'application/json'});
});
