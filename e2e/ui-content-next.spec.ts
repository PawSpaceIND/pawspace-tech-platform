import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const at='2026-10-05T09:00:00.000Z',end='2026-10-05T10:00:00.000Z';
const services=['grooming','boarding','dog_training','pet_taxi'];
const bookings=services.map((serviceCode,i)=>({id:`UI-${i}`,serviceCode,packageName:`Synthetic ${serviceCode} care`,scheduledStart:at,scheduledEnd:end,status:'confirmed',totalAmount:1899+i,currency:'INR'}));
const jobs=bookings.map((b,i)=>({bookingId:b.id,serviceCode:b.serviceCode,packageName:b.packageName,scheduledStart:at,scheduledEnd:end,petCount:1,status:i===1?'completed':i===3?'cancelled':'confirmed',customerFirstName:'UI fixture',group:i===1?'completed':i===3?'past':'upcoming',needsActionReason:null,stayId:null,carePlanStatus:null,nextSlotStart:null,addOns:[],safetyRequirements:[],offer:null}));
for(const width of [320,412,820,1440])for(const style of ['professional','cartoon'])test(`remaining UI populated screens ${width} ${style}`,async({page},info)=>{
 const theme=width===320?'emerald':width===412?'coral':'signature',mode=style==='cartoon'?'dark':'light';
 const writes:string[]=[],existingAutomaticActions:unknown[]=[];
 await page.setViewportSize({width,height:900});
 await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent.v1','essential');},{style,theme,mode});
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  const reply=(data:unknown)=>route.fulfill({json:{data}});
  // The unchanged signed-in Account mounts an automatic referral ensure. Mock and assert its exact intent.
  if(path==='/api/referral-governance'&&r.method()==='POST'&&r.postDataJSON()?.action==='ensure_code'){
   existingAutomaticActions.push(r.postDataJSON());return reply({code:'SYNTHETIC-ONLY',codeId:'UI-REF',duplicatePrevented:true});
  }
  if(path==='/api/customer-checkout'&&r.method()==='POST'&&r.postDataJSON()?.action==='status'){const training=r.postDataJSON().bookingId==='UI-TRAIN',id=training?'UI-TRAIN':'UI-1';return reply({bookingId:id,environment:'sandbox',confirmation:{ready:true,bookingId:id,serviceCode:training?'dog_training':'boarding',packageName:training?'Synthetic Training care':'Synthetic Boarding care',bookingStatus:'confirmed',paymentId:'UI-PAY',paymentMode:'prepaid',paymentStatus:'captured',transactionId:null,amountDueNow:0,totalAmount:1900,currency:'INR',providerId:'UI-PRV',providerName:'Synthetic host',providerModel:'commission',workOrderStatus:'assigned',scheduledStart:at,scheduledEnd:end,updatedAt:1,pets:[{id:'UI-PET',name:'Synthetic pet',species:'dog',breed:null}]}});}
  if(r.method()!=='GET'){writes.push(path);return route.fulfill({status:409,json:{error:'Writes forbidden in presentation fixture'}});}
  if(path==='/api/identity-session')return reply({subjectType:'customer',subjectId:'UI-CUSTOMER'});
  if(path==='/api/customer-account')return reply({customerId:'UI-CUSTOMER',name:'Synthetic family',primaryPhone:'9000000901',cityId:'blr',pets:[],addresses:[],bookings,foodOrders:[]});
  if(path==='/api/training-programmes')return reply({programme:{id:'UI-PROGRAMME',booking_id:'UI-TRAIN',provider_id:'UI-PRV',plan_code:'UI-PLAN',plan_name:'Synthetic Training care',status:'scheduled',total_sessions:1,completed_sessions:0,no_show_sessions:0,cancelled_sessions:0,meet_booking_id:null,pricing_snapshot_json:'{}'},sessions:[{id:'UI-SESSION',programme_id:'UI-PROGRAMME',booking_id:'UI-TRAIN',sequence_no:1,provider_id:'UI-PRV',scheduled_start:at,scheduled_end:end,status:'scheduled',attendance_json:'{}',homework_json:'{}',progress_json:'{}',evidence_json:'{}',started_at:null,completed_at:null}],events:[]});
  if(path==='/api/service-review')return reply({pending:[]});
  if(path==='/api/customer-support-case')return reply({cases:[]});
  if(path==='/api/referral-governance')return reply({programmes:[],rewards:[]});
  if(path==='/api/partner-job-feed')return reply({providerId:'UI-PRV',needsAction:[],today:[],upcoming:jobs.filter(j=>j.group==='upcoming'),completed:jobs.filter(j=>j.group==='completed'),needsOperations:[],past:jobs.filter(j=>j.group==='past'),counts:{needsAction:0,today:0,upcoming:2,completed:1,total:4}});
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
  // Chromium resolves relative auto insets to zero used offsets; require no displacement.
  const appearance=page.getByRole('button',{name:'Change PawSpace appearance'});
  expect(await appearance.evaluate(e=>{const s=getComputedStyle(e);return[s.position,s.top,s.right,s.bottom,s.left];})).toEqual(['relative','0px','0px','0px','0px']);
  expect((await appearance.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await appearance.click();await expect(page.locator('.paw-appearance-dialog')).toBeVisible();await page.getByRole('button',{name:'Close appearance settings'}).click();
  const updates=page.locator('.ps-order-fab');await expect(updates).toBeVisible();
  expect(await updates.evaluate(e=>{const s=getComputedStyle(e);return[s.position,s.top,s.right,s.bottom,s.left];})).toEqual(['relative','0px','0px','0px','0px']);
  await updates.getByRole('button',{name:'Order notifications',exact:true}).click();await expect(page.getByRole('dialog',{name:'PawSpace order notifications'})).toBeVisible();await page.getByRole('button',{name:'Close notifications'}).click();
  await info.attach(`focus-before-default-${name}`,{body:JSON.stringify(await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.slice(0,80)}))),contentType:'application/json'});
  await page.evaluate(()=>{(document.activeElement as HTMLElement)?.blur();window.scrollTo({top:0,left:0,behavior:'instant'});});
  await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBe(0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.screenshot({path:info.outputPath(`${name}-${head}.png`),fullPage:true});
 };
 await page.goto('/v2/activity');await expect(page.getByRole('heading',{name:'Upcoming & active'})).toBeVisible();
 const bookingLinks=page.getByRole('link',{name:'View booking & payment',exact:true});await expect(bookingLinks).toHaveCount(4);
 expect((await bookingLinks.first().boundingBox())!.height).toBeGreaterThanOrEqual(48);await bookingLinks.first().focus();expect(await bookingLinks.first().evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');await capture('activity');
 await page.goto('/v2/booking?bookingId=UI-1');await expect(page.getByRole('heading',{name:'Synthetic Boarding care'})).toBeVisible();expect((await page.getByRole('button',{name:'Refresh status'}).boundingBox())!.height).toBeGreaterThanOrEqual(48);await expect(page.getByText('Payment: paid',{exact:false})).toBeVisible();await capture('booking');
 await page.goto('/partner/jobs');await expect(page.getByTestId('partner-job-UI-0')).toBeVisible();await expect(page.getByRole('heading',{name:'Upcoming (2)'})).toBeVisible();
 expect(await page.getByRole('heading',{name:'Upcoming (2)'}).evaluate(e=>getComputedStyle(e).fontSize)).toBe('16px');
 for(const chip of await page.locator('[data-testid^="partner-job-"] [data-status]').all()){const contrast=await chip.evaluate(e=>{const s=getComputedStyle(e),rgb=(x:string)=>x.match(/[\d.]+/g)!.slice(0,3).map(Number),lum=(a:number[])=>a.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0),a=lum(rgb(s.color)),b=lum(rgb(s.backgroundColor));return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);});expect(contrast).toBeGreaterThanOrEqual(4.5);}
 for(const link of await page.locator('[data-testid^="partner-workspace-"]').all())expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(48);await capture('jobs');
 await page.goto('/partner/rates');await expect(page.getByRole('spinbutton')).toHaveCount(2);
 const rate=page.getByRole('spinbutton').first();expect((await rate.boundingBox())!.height).toBeGreaterThanOrEqual(48);await expect(rate).toHaveAttribute('min','699');await rate.fill('698');await expect(page.getByRole('button',{name:'Save rate'}).first()).toBeDisabled();await rate.fill('720');await expect(page.getByRole('button',{name:'Save rate'}).first()).toBeEnabled();await page.getByRole('button',{name:'Save rate'}).first().click({trial:true});await rate.focus();expect(await rate.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');await capture('rates');
 await page.goto('/v2/account');await expect(page.getByRole('heading',{name:'Profile',exact:true})).toBeVisible();await capture('account-regression');
 await page.goto('/v2/support');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toBeVisible();await capture('support-regression');
 await page.goto('/v2/booking?bookingId=UI-TRAIN');await expect(page.getByRole('region',{name:'Manage your programme'})).toBeVisible();await page.getByRole('button',{name:'Request programme cancellation / refund review'}).click();await expect(page.getByRole('form',{name:'Request programme cancellation'})).toBeVisible();await expect(page.getByRole('button',{name:'Send cancellation request'})).toBeDisabled();await capture('training-manage-regression');
 expect(writes).toEqual([]);expect(existingAutomaticActions).toEqual([{action:'ensure_code',customerId:'UI-CUSTOMER',programmeId:'uat-referral-programme'}]);await info.attach('source-and-synthetic-scope',{body:JSON.stringify({head,width,style,theme,mode,writes,existingAutomaticActions,physicalDevice:false,externalRequests:false}),contentType:'application/json'});
});
