import {test,expect,type Locator,type Page,type TestInfo} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const sourceHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const codes=['trainer-meet-greet','training-2-starter','training-4-puppy','training-8-basic','training-8-leash','training-12-leash','training-12-advanced','training-16-pro','future-plan'];
// Deliberately synthetic values: the actual UI must render these, not seed prices.
const plans=codes.map((package_code,index)=>({package_code,name:`Fixture programme ${index}`,sessions:index+1,validity_days:120,base_price:4321+index*19,currency:'INR',meet_and_greet:index===0?1:0,max_pets:4,direct_minutes_per_pet:45,coaching_minutes_per_pet:15,split_due_percent:50,extra_pet_percent:60,version:1}));
const account={customerId:'UI-SUCCESSOR-C',cityId:'blr',name:'UI Fixture',primaryPhone:'9000000001',secondaryPhone:null,email:null,memberSince:0,pets:[{id:'UI-SUCCESSOR-P',sourceId:null,name:'Fixture dog',species:'dog',breed:'Labrador',vaccinationStatus:'verified',ageYears:2,weightKg:20,profile:null}],addresses:[{id:'UI-SUCCESSOR-A',label:'Fixture',line1:'Test Street',line2:null,area:'BTM',city:'Bengaluru',postalCode:'560068',isDefault:true}],bookings:[],foodOrders:[]};
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
async function fixture(page:Page,{signedIn=true,accountGate,catalogueGate}:{signedIn?:boolean;accountGate?:ReturnType<typeof gate>;catalogueGate?:ReturnType<typeof gate>}={}){
 const unexpectedWrites:string[]=[];
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  const data=(value:unknown)=>route.fulfill({json:{data:value}});
  if(path==='/api/identity-session')return signedIn?data({subjectType:'customer',subjectId:account.customerId}):route.fulfill({status:401,json:{error:'Synthetic signed-out state'}});
  if(path==='/api/customer-account'){await accountGate?.promise;return signedIn?data(account):route.fulfill({status:401,json:{error:'Synthetic signed-out state'}});}
  if(path==='/api/customer-profile')return data({customerId:account.customerId,customerName:account.name,phone:account.primaryPhone});
  if(path==='/api/training-commercial'&&request.method()==='GET'){await catalogueGate?.promise;return data({packages:plans,source:'synthetic-ui',liveMoney:false});}
  if(path==='/api/training-commercial'&&request.method()==='POST'){const input=request.postDataJSON(),plan=plans.find(p=>p.package_code===input.packageCode)!;return data({quoteId:'UI-SUCCESSOR-Q',packageCode:plan.package_code,packageName:plan.name,packageVersion:1,sessions:plan.sessions,validityDays:plan.validity_days,petCount:input.petCount,minutesPerSession:60,basePrice:plan.base_price,totalAmount:plan.base_price,discount:0,amountDueNow:plan.base_price,paymentMode:input.paymentMode,meetAndGreet:Boolean(plan.meet_and_greet),expiresAt:Date.now()+600000,liveMoney:false});}
  if(path==='/api/uat-scheduling'&&request.method()==='POST'&&request.postDataJSON()?.action==='preview'){
   const input=request.postDataJSON();return data({...input,providers:[],availabilityChecked:true,reserved:false,occurrences:Array.from({length:input.occurrences},(_,index)=>({start:new Date(Date.parse(input.scheduledStart)+index*(input.cadenceDays??7)*86400000).toISOString(),end:new Date(Date.parse(input.scheduledEnd)+index*(input.cadenceDays??7)*86400000).toISOString()}))});
  }
  if(path==='/api/training-trainers')return data({providers:[],source:'synthetic-ui',liveAvailability:false});
  if(path==='/api/training-requirements')return data({requirements:[]});
  if(path==='/api/walking-commercial'){await catalogueGate?.promise;if(request.method()==='GET')return data({packages:[],liveMoney:false});const input=request.postDataJSON();return data({...input,quoteId:'UI-SUCCESSOR-WQ',packageName:'Fixture walk',packageVersion:1,durationMinutes:input.packageCode==='walking-60'?60:30,perWalkAmount:271,totalAmount:271*input.walkCount,amountDueNow:0,expiresAt:Date.now()+600000,liveMoney:false});}
  if(path==='/api/service-zone')return data({assignment:{pincode:'560068',cityId:'blr',city:'Bengaluru',zoneId:'blr-south',area:'BTM'},zone:{zoneId:'blr-south',zoneName:'South Bengaluru',serviceAvailable:true}});
  if(path==='/api/team-overview')return data({actor:{name:'UI Fixture',roleCode:'founder',permissions:['*']}});
  if(path==='/api/relocation-enquiry')return data([]);
  if(path==='/api/service-availability')return data([]);
  if(path==='/api/ai-web-chat'&&request.method()==='POST'&&request.postDataJSON()?.start===true)return data({bot:{text:'Synthetic UI fixture',choices:[]}});
  if(request.method()!=='GET')unexpectedWrites.push(path);
  return route.fulfill({status:404,json:{error:'Outside isolated UI fixture'}});
 });
 return unexpectedWrites;
}
async function appearance(page:Page,style:string,theme:string,mode:string){await page.addInitScript(({style,theme,mode})=>{if(localStorage.getItem('pawspace.visual-style')===null)localStorage.setItem('pawspace.visual-style',style);if(localStorage.getItem('pawspace.customer.theme')===null)localStorage.setItem('pawspace.customer.theme',theme);if(localStorage.getItem('pawspace.customer.appearance')===null)localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent','essential');},{style,theme,mode});}
async function rendered(page:Page){await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');const privacy=page.getByRole('button',{name:'Essential only',exact:true});if(await privacy.isVisible())await privacy.click();}
async function readableLabel(label:Locator){
 const ratio=await label.evaluate(element=>{
  const rgb=(value:string)=>{if(!/^rgba?\(/.test(value))throw new Error(`Unsupported computed colour: ${value}`);return value.match(/[\d.]+/g)!.map(Number);};
  const foreground=rgb(getComputedStyle(element).color);let ancestor:Element|null=element,background:number[]|null=null;
  while(ancestor){const colour=rgb(getComputedStyle(ancestor).backgroundColor);if((colour[3]??1)===1){background=colour;break;}if((colour[3]??1)!==0)throw new Error('Contrast review needs an opaque background');ancestor=ancestor.parentElement;}
  if(!background||(foreground[3]??1)!==1)throw new Error('Contrast review needs opaque foreground and background');
  const luminance=(colour:number[])=>colour.slice(0,3).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const a=luminance(foreground),b=luminance(background);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 });
 expect(ratio,'visible small heading contrast').toBeGreaterThanOrEqual(4.5);
}
async function evidence(page:Page,info:TestInfo,name:string){
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width+2);
 await page.screenshot({path:info.outputPath(`${name}-${sourceHead}.png`),fullPage:true,animations:'disabled'});
 await info.attach(`${name}-source`,{body:JSON.stringify({sourceHead,url:page.url(),viewport:page.viewportSize(),appearance:await page.locator('html').evaluate(e=>({style:(e as HTMLElement).dataset.pawStyle,theme:(e as HTMLElement).dataset.pawTheme,mode:(e as HTMLElement).dataset.pawMode}))}),contentType:'application/json'});
}
for(const width of [320,391,768,1440])for(const style of ['professional','cartoon'])for(const theme of ['emerald','signature','coral'])for(const mode of ['light','dark']){
 test(`actual Account/Training/staff ${width} ${style} ${theme} ${mode}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});await appearance(page,style,theme,mode);
  await fixture(page,{signedIn:false});await page.goto('/v2/account');await rendered(page);await expect(page.locator('html')).toHaveAttribute('data-paw-style','professional');await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
  await expect(page.getByText('Your pet family, all in one place.',{exact:true})).toBeVisible();
  await readableLabel(page.getByText('YOUR PAWSPACE ACCOUNT',{exact:true}));
  for(const name of ['Activity','Account']){
   const link=page.getByRole('navigation',{name:'PawSpace V2 navigation'}).getByRole('link',{name:new RegExp(name)});
   const lines=await link.evaluate(element=>{const text=Array.from(element.childNodes).find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent?.trim());if(!text)throw new Error('Navigation label missing');const range=document.createRange();range.selectNodeContents(text);return range.getClientRects().length;});
   expect(lines,'navigation label stays on one line').toBe(1);
  }
  const signIn=page.getByRole('link',{name:'Sign in from home',exact:true});await expect(signIn).toBeVisible();expect((await signIn.boundingBox())!.height).toBeGreaterThanOrEqual(44);await evidence(page,info,'account');
  await page.unroute('**/api/**');const writes=await fixture(page);await page.goto('/v2/training');await rendered(page);
  await expect(page.getByRole('status').filter({hasText:'Selected programme:'})).toHaveCount(0);
  for(const label of ['Puppy','Obedience','Behavioral','Leash','Other available programmes']){const summary=page.locator('summary').filter({has:page.locator('strong',{hasText:label})}).filter({visible:true});await expect(summary).toHaveCount(1);if(!await summary.evaluate(e=>(e.parentElement as HTMLDetailsElement).open))await summary.click();}
  const puppySummary=page.locator('summary').filter({has:page.locator('strong',{hasText:'Puppy'})});await puppySummary.focus();await puppySummary.press('Enter');await expect(puppySummary.locator('..')).not.toHaveAttribute('open','');await puppySummary.press('Enter');await expect(puppySummary.locator('..')).toHaveAttribute('open','');
  await expect(page.getByText('Assessment-led · starts with an assessment',{exact:true})).toBeVisible();
  for(const plan of plans){const choice=page.getByRole('button',{name:new RegExp(plan.name)});await expect(choice).toHaveCount(1);await expect(choice).toContainText(plan.base_price.toLocaleString('en-IN'));}
  const choice=page.getByRole('button',{name:/Fixture programme 1/});await choice.scrollIntoViewIfNeeded();await choice.click();await expect(choice).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('status').filter({hasText:'Selected programme:'})).toContainText('Fixture programme 1');await evidence(page,info,'training');
  await page.goto('/team/relocation-enquiries');await rendered(page);await expect(page.getByRole('heading',{name:'Submitted relocation enquiries',exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-paw-style','professional');await evidence(page,info,'staff');expect(writes).toEqual([]);
 });
}
for(const width of [320,391,768,1440])for(const service of ['training','walking']){
 test(`delayed ${service} hydration/readiness ${width}`,async({page},info)=>{
  const accountGate=gate(),catalogueGate=gate();await page.setViewportSize({width,height:900});const writes=await fixture(page,{accountGate,catalogueGate});
  try{
   await page.goto(`/v2/${service}`);await rendered(page);
   const date=service==='training'?page.getByLabel(/First session date/):page.getByLabel('Start from',{exact:true});await expect(date).toBeDisabled();
   accountGate.release();await expect(date).toBeDisabled();catalogueGate.release();await expect(date).toBeEnabled();
   await date.fill('2026-10-08');if(service==='training')await page.getByLabel(/First session start \(IST, on the hour\)/).selectOption('11:00');
   else{const slot=page.getByRole('button',{name:/6:00 AM/}).first();await expect(slot).toBeEnabled();await slot.click();}
   await expect(date).toHaveValue('2026-10-08');await page.evaluate(()=>{for(const theme of ['coral','signature','emerald']){localStorage.setItem('pawspace.customer.theme',theme);window.dispatchEvent(new CustomEvent('pawspace-appearance-change',{detail:{theme,mode:'dark',style:'cartoon'}}));}});
   await expect(date).toHaveValue('2026-10-08');await evidence(page,info,`${service}-ready`);expect(writes).toEqual([]);
  }finally{accountGate.release();catalogueGate.release();}
 });
}
test('mobile repeated preference events, route reload and denied storage agree with global appearance',async({page},info)=>{
 const writes=await fixture(page);await appearance(page,'professional','emerald','light');await page.goto('/mobile-app');await rendered(page);
 for(const theme of ['signature','coral','emerald']){await page.evaluate(theme=>{localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance','dark');window.dispatchEvent(new CustomEvent('pawspace-appearance-change',{detail:{theme,mode:'dark'}}));},theme);await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-theme','editorial');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-mode','dark');}
 await page.reload();await rendered(page);await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-mode','dark');
 await page.evaluate(()=>{Storage.prototype.getItem=()=>{throw new Error('Synthetic storage denial');};window.dispatchEvent(new CustomEvent('pawspace-appearance-change',{detail:{theme:'coral',mode:'light'}}));});
 await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-theme','editorial');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-mode','light');await evidence(page,info,'mobile-preferences');expect(writes).toEqual([]);
});

test('mobile cross-tab removal, platform default, System and route transitions share existing device preference',async({page,context},info)=>{
 const writes=await fixture(page,{signedIn:false});await page.goto('/mobile-app');await rendered(page);
 const other=await context.newPage();await fixture(other,{signedIn:false});await other.goto('/v2/account');await rendered(other);
 await other.evaluate(()=>{localStorage.setItem('pawspace.platform.default-theme','signature');localStorage.removeItem('pawspace.customer.theme');localStorage.setItem('pawspace.customer.appearance','system');localStorage.setItem('pawspace.visual-style','cartoon');});
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-theme','editorial');await expect(page.locator('html')).toHaveAttribute('data-paw-mode','dark');await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-mode','dark');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('main[data-pawspace-mobile]')).toHaveAttribute('data-mode','light');
 for(const route of ['/v2/account','/partner','/team/relocation-enquiries','/mobile-app']){await page.goto(route);await rendered(page);await expect(page.locator('html')).toHaveAttribute('data-paw-style','professional');await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');}
 await evidence(page,info,'mobile-cross-tab');expect(writes).toEqual([]);
});
