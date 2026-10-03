import { test, expect } from '@playwright/test';
const account={customerId:'fixture-owner',name:'Fixture Customer',primaryPhone:'9000000001',email:'',cityId:'blr',addresses:[],pets:[]};
for(const [path,service] of [['walking','Dog Walking'],['training','Dog Training'],['food','Pet Food'],['relocation','Pet Relocation'],['funeral-memorial','Funeral and Memorial']] as const){
 for(const enabled of [true,false])test(`${path}: ${enabled?'enabled TEST quote':'disabled policy'} before reservation`,async({page})=>{
  const errors:string[]=[];const writes:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{
   const url=new URL(route.request().url()),method=route.request().method();let data:unknown=[];
   if(url.pathname==='/api/v2/test-coins'){
    expect(method).toBe('GET');if(!enabled)return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'TEST coins disabled'})});
    data={customerId:account.customerId,policy:{enabled:true,earnPercent:10,expirySeconds:null,previewRupeesPerCoin:1},spendableCoins:80,grantBalanceAdjustment:0,grants:[{source_kind:'booking',source_id:'prior',remaining:80,expires_at:Date.now()+3600000}]};
   }else if(url.pathname==='/api/customer-account')data=account;
   else if(url.pathname==='/api/identity-session')data={subjectType:'customer',subjectId:account.customerId};
   else if(url.pathname==='/api/walking-commercial')data=method==='POST'?{quoteId:'fixture-quote',totalAmount:1000,amountDueNow:0}:{packages:[]};
   else if(url.pathname==='/api/training-commercial')data={packages:[]};
   else if(url.pathname==='/api/food-commercial')data={items:[]};
   if(method==='POST'&&!['/api/walking-commercial'].includes(url.pathname))writes.push(url.pathname);
   return route.fulfill({contentType:'application/json',body:JSON.stringify({data,readiness:{},templates:{}})});
  });
  await page.goto(`/v2/${path}`);
  const panel=page.getByRole('region',{name:`${service} TEST rewards`});await expect(panel).toBeVisible();
  if(enabled){
   await expect(panel.getByText('New earnings are unavailable until an expiry duration is configured.',{exact:false})).toBeVisible();
   if(path==='walking'){await expect(panel.getByText('Estimated earnings: 100 whole TEST coins',{exact:false})).toBeVisible();await expect(panel.getByRole('spinbutton')).toBeDisabled();}
   else await expect(panel.getByText('Estimated earnings will appear when the eligible INR quote is confirmed.')).toBeVisible();
  }else{
   await expect(panel.getByText('TEST rewards are unavailable here.',{exact:false})).toBeVisible();await expect(panel.getByText('Estimated earnings',{exact:false})).toHaveCount(0);
  }
  await expect(page.getByRole('link',{name:'View TEST wallet, history and expiry'})).toBeVisible();expect(errors).toEqual([]);expect(writes).toEqual([]);
 });
}
test('Taxi governed pre-booking quote previews reuse without changing reservation payable',async({page},info)=>{
 const writes:string[]=[];const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const customer={...account,pets:[{id:'pet-fixture',name:'Fixture Dog',species:'dog',vaccinationStatus:'up_to_date'}]};
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url()),method=route.request().method();let data:unknown=[];
  if(url.pathname==='/api/customer-account')data=customer;
  else if(url.pathname==='/api/v2/test-coins')data={customerId:account.customerId,policy:{enabled:true,earnPercent:10,expirySeconds:null,previewRupeesPerCoin:1},spendableCoins:80,grantBalanceAdjustment:0,grants:[{source_kind:'booking',source_id:'prior',remaining:80,expires_at:Date.now()+3600000}]};
  else if(url.pathname==='/api/taxi-commercial'&&method==='POST'){
   const input=route.request().postDataJSON();const option={eligible:true,quotedTotal:1000,bookingFee:500,finalBalanceBeforeAdjustments:500,distanceFare:1000,waitingCharge:0,handlerCharge:0,features:[]};
   data={...input,quoteId:'taxi-fixture',recommendedVehicleClass:'citroen_ec3',distanceKm:10,estimatedDurationMinutes:30,routeSource:'uat_route_class',fareOptions:{citroen_ec3:{...option,vehicleLabel:'Fixture Citroen'},xuv:{...option,vehicleLabel:'Fixture XUV'}}};
  }
  if(method==='POST'&&url.pathname!=='/api/taxi-commercial')writes.push(url.pathname);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 await page.goto('/v2/taxi');await page.getByRole('button',{name:'Continue to trip details'}).click();
 await page.getByLabel('Pickup address',{exact:true}).fill('Fixture pickup Bengaluru');await page.getByLabel('Drop address / Point 1',{exact:true}).fill('Fixture drop Bengaluru');
 await page.getByRole('button',{name:'Review ride requirements'}).click();await page.getByRole('button',{name:'Calculate Citroën & XUV fares'}).click();
 const panel=page.getByRole('region',{name:'Pet Taxi TEST rewards'});
 await expect(panel.getByText('Estimated earnings: 100 whole TEST coins',{exact:false})).toBeVisible();
 await panel.getByRole('spinbutton').fill('80');
 await expect(panel.locator('dd').nth(0)).toHaveText('₹500.00');await expect(panel.locator('dd').nth(1)).toHaveText('₹80.00');await expect(panel.locator('dd').nth(2)).toHaveText('₹420.00');
 await expect(page.getByRole('button',{name:'Reserve · pay ₹500 next'})).toBeVisible();expect(writes).toEqual([]);expect(errors).toEqual([]);
 await page.screenshot({path:`../receipts/coin-prebooking-taxi-${info.project.name}.png`,fullPage:true});
});
test('TEST preview ages hidden reversal debt and explicitly reconciles refunds',async({page})=>{
 const base=Date.now();await page.clock.install({time:base});let reconciliations=0;
 await page.route('**/api/**',route=>{
  const url=new URL(route.request().url()),method=route.request().method();let data:unknown=[];
  if(url.pathname==='/api/customer-account')data=account;
  else if(url.pathname==='/api/v2/test-coins'){
   if(method==='POST'){expect(route.request().postDataJSON()).toEqual({action:'sync'});reconciliations++;}
   data={customerId:account.customerId,policy:{enabled:true,earnPercent:10,expirySeconds:null,previewRupeesPerCoin:1},spendableCoins:reconciliations?0:15,grantBalanceAdjustment:reconciliations?-10:-5,grants:[{source_kind:'booking',source_id:'first',remaining:10,expires_at:base+1000},{source_kind:'booking',source_id:'second',remaining:10,expires_at:base+60000}]};
  }else if(url.pathname==='/api/walking-commercial')data=method==='POST'?{quoteId:'fixture',totalAmount:1000,amountDueNow:0}:{packages:[]};
  return route.fulfill({contentType:'application/json',body:JSON.stringify({data})});
 });
 await page.goto('/v2/walking');const panel=page.getByRole('region',{name:'Dog Walking TEST rewards'});
 await expect(panel.getByText('15 unexpired TEST coins available',{exact:false})).toBeVisible();
 await page.clock.fastForward(1001);await expect(panel.getByText('5 unexpired TEST coins available',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Refresh TEST balance'}).click();await expect(panel.getByText('0 unexpired TEST coins available',{exact:false})).toBeVisible();expect(reconciliations).toBe(1);
});
