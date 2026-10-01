import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['app/team/finance/page.tsx','app/team/finance/finance-ledger.tsx','app/team/finance/grooming-gst-panel.tsx','app/team/finance/finance-content.module.css','app/team/operations/page.tsx','app/team/people/page.tsx','app/team/presentation-next/staff-content.module.css'];
const hashes=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
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
  if(url.pathname==='/api/people-foundation')return route.fulfill({json:{data:{employees:[{id:'EMP-UI',employee_code:'UI-001',display_name:'Synthetic reviewer',work_email:'fixture@test.invalid',employment_status:'active',title:'UI test role',team_code:'UI',sensitiveMasked:true}]}}});
  return route.fulfill({status:401,json:{error:'Isolated UI fixture; unavailable data stays unavailable'}});
 });
 for(const screen of ['finance','operations','people']){
  await page.goto(`/team/${screen}`);await expect(page.locator('html')).toHaveAttribute('data-paw-theme',theme);await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
  const content=page.locator('#staff-workspace-content');await expect(content).toBeVisible();
  if(screen==='finance'){
   await expect(content.getByRole('heading',{name:'Service finance & reconciliation'})).toBeVisible();await expect(content.locator('[data-booking-id=FINANCE-UI]')).toContainText('UI-INVOICE');
   const publish=content.getByRole('button',{name:'Publish GST setting',exact:true});await expect(publish).toBeDisabled();
   await content.getByRole('button',{name:'Boarding',exact:true}).click();await expect.poll(()=>reads.some(x=>x.includes('payment-reconciliation?view=bookings&service=boarding'))).toBe(true);
   for(const region of await content.getByRole('region',{name:/scroll horizontally/}).all()){await region.focus();expect(await region.evaluate(e=>getComputedStyle(e).outlineOffset)).toBe('-3px');}
  }else if(screen==='operations')await expect(content.getByRole('link').filter({hasText:'Open →'})).toHaveCount(5);
  else {const search=content.getByRole('textbox',{name:'Find someone'});await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();await search.fill('does-not-match');await expect(content.getByText('No one matches “does-not-match”',{exact:true})).toBeVisible();await search.fill('');await expect(content.getByText('Synthetic reviewer',{exact:true})).toBeVisible();}
  await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
  for(const el of await content.locator('button,input:not([type=radio]),select').all()){if(!await el.isVisible())continue;expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();scrollTo({top:0,behavior:'instant'});});await page.screenshot({path:info.outputPath(`${screen}-${fingerprint}.png`),fullPage:true});
 }
 expect(writes).toEqual([]);await info.attach('fixture-and-source',{body:JSON.stringify({width,style,theme,mode,fingerprint,hashes,writes,reads,authorizationAcceptance:false,physicalDevice:false}),contentType:'application/json'});
});
