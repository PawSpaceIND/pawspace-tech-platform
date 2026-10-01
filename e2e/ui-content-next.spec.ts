import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const at='2026-10-05T09:00:00.000Z',end='2026-10-05T10:00:00.000Z';
const services=['grooming','boarding','dog_training','pet_taxi'];
const bookings=services.map((serviceCode,i)=>({id:`UI-${i}`,serviceCode,packageName:`Synthetic ${serviceCode} care`,scheduledStart:at,scheduledEnd:end,status:'confirmed',totalAmount:1899+i,currency:'INR'}));
const jobs=bookings.map(b=>({bookingId:b.id,serviceCode:b.serviceCode,packageName:b.packageName,scheduledStart:at,scheduledEnd:end,petCount:1,status:'confirmed',customerFirstName:'UI fixture',group:'upcoming',needsActionReason:null,stayId:null,carePlanStatus:null,nextSlotStart:null,addOns:[],safetyRequirements:[],offer:null}));
for(const width of [320,412,820,1440])for(const style of ['professional','cartoon'])test(`remaining UI populated screens ${width} ${style}`,async({page},info)=>{
 const theme=width===320?'emerald':width===412?'coral':'signature',mode=style==='cartoon'?'dark':'light';
 const writes:string[]=[];
 await page.setViewportSize({width,height:900});
 await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent.v1','essential');},{style,theme,mode});
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  const reply=(data:unknown)=>route.fulfill({json:{data}});
  if(path==='/api/customer-checkout'&&r.method()==='POST'&&r.postDataJSON()?.action==='status')return reply({bookingId:'UI-1',environment:'sandbox',confirmation:{ready:true,bookingId:'UI-1',serviceCode:'boarding',packageName:'Synthetic Boarding care',bookingStatus:'confirmed',paymentId:'UI-PAY',paymentMode:'prepaid',paymentStatus:'captured',transactionId:null,amountDueNow:0,totalAmount:1900,currency:'INR',providerId:'UI-PRV',providerName:'Synthetic host',providerModel:'commission',workOrderStatus:'assigned',scheduledStart:at,scheduledEnd:end,updatedAt:1,pets:[{id:'UI-PET',name:'Synthetic pet',species:'dog',breed:null}]}});
  if(r.method()!=='GET'){writes.push(path);return route.fulfill({status:409,json:{error:'Writes forbidden in presentation fixture'}});}
  if(path==='/api/identity-session')return reply({subjectType:'customer',subjectId:'UI-CUSTOMER'});
  if(path==='/api/customer-account')return reply({customerId:'UI-CUSTOMER',name:'Synthetic family',primaryPhone:'9000000901',cityId:'blr',pets:[],addresses:[],bookings,foodOrders:[]});
  if(path==='/api/service-review')return reply({pending:[]});
  if(path==='/api/customer-support-case')return reply({cases:[]});
  if(path==='/api/partner-job-feed')return reply({providerId:'UI-PRV',needsAction:[],today:[],upcoming:jobs,completed:[],needsOperations:[],past:[],counts:{needsAction:0,today:0,upcoming:4,completed:0,total:4}});
  if(path==='/api/provider-service-rates')return reply({rates:[],options:[{serviceCode:'boarding',packageCode:'UI-PACK',name:'Synthetic Boarding overnight',floorPrice:699,cityId:'blr',zoneId:'blr-east'},{serviceCode:'pet_sitting',packageCode:'UI-SIT',name:'Synthetic Sitting visit',floorPrice:499,cityId:'blr',zoneId:'blr-east'}]});
  if(path.includes('relocation'))return reply({cases:[],inquiries:[]});
  return route.fulfill({status:401,json:{error:'Isolated presentation fixture'}});
 });
 const capture=async(name:string)=>{
  await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);
  await expect(page.locator('html')).toHaveAttribute('data-paw-theme',theme);
  await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+2);
  expect(await page.getByRole('button',{name:'Change PawSpace appearance'}).evaluate(e=>getComputedStyle(e).position)).toBe('relative');
  await page.screenshot({path:info.outputPath(`${name}-${head}.png`),fullPage:true});
 };
 await page.goto('/v2/activity');await expect(page.getByRole('heading',{name:'Upcoming & active'})).toBeVisible();
 const bookingLinks=page.getByRole('link',{name:'View booking & payment',exact:true});await expect(bookingLinks).toHaveCount(4);
 expect((await bookingLinks.first().boundingBox())!.height).toBeGreaterThanOrEqual(48);await bookingLinks.first().focus();expect(await bookingLinks.first().evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');await capture('activity');
 await page.goto('/v2/booking?bookingId=UI-1');await expect(page.getByRole('heading',{name:'Synthetic Boarding care'})).toBeVisible();expect((await page.getByRole('button',{name:'Refresh status'}).boundingBox())!.height).toBeGreaterThanOrEqual(48);await expect(page.getByText('Payment: paid',{exact:false})).toBeVisible();await capture('booking');
 await page.goto('/partner/jobs');await expect(page.getByTestId('partner-job-UI-0')).toBeVisible();await expect(page.getByRole('heading',{name:'Upcoming (4)'})).toBeVisible();
 expect(await page.getByRole('heading',{name:'Upcoming (4)'}).evaluate(e=>getComputedStyle(e).fontSize)).toBe('16px');
 const contrast=await page.getByTestId('partner-job-UI-0').locator('[data-status]').evaluate(e=>{const s=getComputedStyle(e),rgb=(x:string)=>x.match(/[\d.]+/g)!.slice(0,3).map(Number),lum=(a:number[])=>a.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0),a=lum(rgb(s.color)),b=lum(rgb(s.backgroundColor));return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);});expect(contrast).toBeGreaterThanOrEqual(4.5);
 for(const link of await page.locator('[data-testid^="partner-workspace-"]').all())expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(48);await capture('jobs');
 await page.goto('/partner/rates');await expect(page.getByRole('spinbutton')).toHaveCount(2);
 const rate=page.getByRole('spinbutton').first();expect((await rate.boundingBox())!.height).toBeGreaterThanOrEqual(48);await expect(rate).toHaveAttribute('min','699');await rate.fill('698');await expect(page.getByRole('button',{name:'Save rate'}).first()).toBeDisabled();await rate.fill('720');await expect(page.getByRole('button',{name:'Save rate'}).first()).toBeEnabled();await page.getByRole('button',{name:'Save rate'}).first().click({trial:true});await rate.focus();expect(await rate.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');await capture('rates');
 expect(writes).toEqual([]);await info.attach('source-and-synthetic-scope',{body:JSON.stringify({head,width,style,theme,mode,writes,physicalDevice:false,externalRequests:false}),contentType:'application/json'});
});
