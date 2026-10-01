import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['app/team/finance/page.tsx','app/team/finance/finance-ledger.tsx','app/team/finance/grooming-gst-panel.tsx','app/team/finance/finance-content.module.css','app/team/operations/page.tsx','app/team/people/page.tsx','app/team/presentation-next/staff-content.module.css','app/team/finance/boarding/boarding-finance-workspace.tsx','app/team/finance/boarding/boarding-content.module.css','app/team/finance/training/page.tsx','app/team/finance/training/training-content.module.css'];
const hashes=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
function contrastRatio(a:string,b:string){const lum=(v:string)=>{const c=v.match(/[\d.]+/g)!.slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
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
  if(url.pathname==='/api/training-finance')return route.fulfill({json:{data:{invoices:[{booking_id:'UI-TRAINING-PAID',commercial_total:1200,tax_amount:216,invoice_total:1416,payment_status:'FULLY_PAID',status:'draft_ready_for_number',invoice_number:null},{booking_id:'UI-TRAINING-PENDING',commercial_total:1200,tax_amount:216,invoice_total:1416,payment_status:'PARTIALLY_PAID',status:'draft_ready_for_number',invoice_number:null}],earnings:[],payouts:[{provider_id:'UI-TRAINER',period_code:'2026-10',earned_sessions:2,pending_sessions:0,held_sessions:0,earned_amount:500,status:'ready_for_finance_approval'}],taxPolicies:[],compensationRules:[],events:[],livePayout:false,executionMode:'sandbox',cancellation:{policies:[],cases:[],refunds:[],creditNotes:[],liveRefund:false,liveTaxFiling:false}}}});
  if(url.pathname==='/api/training-reconciliation')return route.fulfill({json:{data:{summary:{programmes:2,reconciled:2,exceptions:0},records:[],source:'synthetic UI fixture',liveMoney:false}}});
  if(url.pathname==='/api/people-foundation')return route.fulfill({json:{data:{employees:[{id:'EMP-UI',employee_code:'UI-001',display_name:'Synthetic reviewer',work_email:'fixture@test.invalid',employment_status:'active',title:'UI test role',team_code:'UI',sensitiveMasked:true}]}}});
  return route.fulfill({status:401,json:{error:'Isolated UI fixture; unavailable data stays unavailable'}});
 });
 for(const screen of ['finance','operations','people','finance/boarding','finance/training']){
  await page.goto(`/team/${screen}${screen==='finance/boarding'?'?bookingId=FINANCE-UI':''}`);await expect(page.locator('html')).toHaveAttribute('data-paw-theme',theme);await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
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
   const lookup=content.getByRole('textbox',{name:'Boarding booking ID'});await expect(lookup).toHaveValue('FINANCE-UI');
   await content.getByRole('button',{name:'Load booking',exact:true}).click();await expect(lookup).toHaveValue('FINANCE-UI');
   await expect.poll(()=>reads.filter(x=>x.includes('boarding-finance?bookingId=FINANCE-UI')).length).toBeGreaterThanOrEqual(2);
   for(const el of await content.locator('main button,main input,main header a').all()){if(await el.isVisible())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);}
   if(width<=600){const inputRect=(await lookup.boundingBox())!,buttonRect=(await content.getByRole('button',{name:'Load booking',exact:true}).boundingBox())!;expect(buttonRect.y).toBeGreaterThanOrEqual(inputRect.y+inputRect.height);}
  }else if(screen==='finance/training'){
   await expect(content.getByRole('heading',{name:'Training finance & payout readiness'})).toBeVisible();
   const colors=await content.locator('main header small').evaluate(e=>({foreground:getComputedStyle(e).color,background:getComputedStyle(e.closest('main')!).backgroundColor}));expect(contrastRatio(colors.foreground,colors.background)).toBeGreaterThanOrEqual(4.5);
   await expect(content.getByRole('row').filter({hasText:'UI-TRAINING-PAID'}).getByRole('button',{name:'Issue UAT invoice',exact:true})).toBeEnabled();
   await expect(content.getByRole('row').filter({hasText:'UI-TRAINING-PENDING'}).getByRole('button',{name:'Issue UAT invoice',exact:true})).toBeDisabled();
   await expect(content.getByRole('button',{name:'Approve sandbox instruction',exact:true})).toBeEnabled();
   const regions=content.getByRole('region',{name:/scroll horizontally/});await expect(regions).toHaveCount(3);
   for(const region of await regions.all()){await page.keyboard.press('Tab');await region.focus();expect(await region.evaluate(e=>e===document.activeElement)).toBe(true);expect(await region.evaluate(e=>getComputedStyle(e).outlineOffset)).toBe('-3px');await region.evaluate(e=>{e.scrollLeft=0;});if(await region.evaluate(e=>e.scrollWidth>e.clientWidth)){await page.keyboard.press('ArrowRight');await expect.poll(()=>region.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);}}
   for(const el of await content.locator('main button,main header a').all()){if(await el.isVisible())expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);}
  }else if(screen==='operations')await expect(content.getByRole('link').filter({hasText:'Open →'})).toHaveCount(5);
  else {const search=content.getByRole('textbox',{name:'Find someone'});await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();await search.fill('does-not-match');await expect(content.getByText('No one matches “does-not-match”',{exact:true})).toBeVisible();await search.fill('');await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();}
  await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  for(const el of await content.locator('button,input:not([type=radio]),select').all()){if(!await el.isVisible())continue;expect((await el.boundingBox())!.height,await el.evaluate(e=>`${e.tagName} ${e.getAttribute('aria-label')||e.textContent||e.getAttribute('type')}`)).toBeGreaterThanOrEqual(44);}
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();document.querySelectorAll('[role=region]').forEach(e=>{e.scrollLeft=0;});scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:info.outputPath(`${screen.replaceAll('/','-')}-${fingerprint}.png`),fullPage:true,animations:'disabled'});
 }
 expect(writes).toEqual([]);await info.attach('fixture-and-source',{body:JSON.stringify({width,style,theme,mode,fingerprint,hashes,writes,reads,authorizationAcceptance:false,physicalDevice:false}),contentType:'application/json'});
});
