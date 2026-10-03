// Service-fix lane headless UI evidence for the Grooming (app/v2/grooming/page.tsx) and Pet Taxi (app/mobile-app/taxi-flow.tsx)
// customer flows. SYNTHETIC ONLY: every /api/** call is answered in-page by Playwright from fictional fixtures; every
// non-GET request that is not an explicit quote/preview mock is aborted and counted; no payment, reservation or booking
// is created. Catalogue prices in the fixtures are deliberately NOT the workbook's example figures, so a displayed price
// proves the UI shows the catalogue it was given. Run: PAWSPACE_TEST_BROWSER_EXECUTABLE=<chromium> node tests/service-fix-ui.browser.cjs
const fs=require('fs'),http=require('http'),path=require('path'),os=require('os'),assert=require('assert/strict');
const dir=path.resolve(__dirname,'..'),dep=dir+'/node_modules/',esbuild=require(dep+'esbuild'),{chromium}=require(dep+'playwright');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'service-fix-ui-'));
(async()=>{
 fs.writeFileSync(scratch+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';
import Grooming from '${dir}/app/v2/grooming/page';import TaxiFlow from '${dir}/app/mobile-app/taxi-flow';
const q=new URLSearchParams(location.search);const which=q.get('page');
createRoot(document.getElementById('app')!).render(which==='taxi'?<TaxiFlow routeScope="v2" customer={{customerId:'cust-fixture-1',customerName:'Priya Fixture',phone:'+919999900001'}}/>:<Grooming/>);`);
 await esbuild.build({entryPoints:[scratch+'/entry.tsx'],bundle:true,outfile:scratch+'/bundle.js',nodePaths:[dep],jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'context',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$|^react-dom(?:\/.*)?$/},a=>({path:require.resolve(a.path,{paths:[dep]})}));
  b.onResolve({filter:/^(next\/link|next\/navigation|next\/image|.*\.module\.css|.*\.css)$/},a=>({path:a.path,namespace:'stub'}));
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({loader:'js',contents:a.path.endsWith('.css')?'export default new Proxy({}, {get:(_,k)=>String(k)})':a.path==='next/navigation'?'export const useRouter=()=>({push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>location.pathname;':`import React from 'react';export default function Stub({children,href,...props}){return React.createElement('${a.path==='next/link'?'a':'div'}',{href,...props},children)}`}));
 }}]});
 const server=http.createServer((q,s)=>q.url.startsWith('/bundle.js')?s.end(fs.readFileSync(scratch+'/bundle.js')):s.end('<div id="app"></div><script src="/bundle.js"></script>'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAWSPACE_TEST_BROWSER_EXECUTABLE}),results=[];
 // Fictional fixtures. Catalogue price 1234 (not the workbook's 1,349) and subscription 4321.
 const address={id:'addr-1',label:'Home',line1:'12, 5th Cross, HSR Layout',line2:null,area:'HSR Layout',city:'Bengaluru',postalCode:'560102',isDefault:true};
 const account={customerId:'cust-fixture-1',cityId:'blr',name:'Priya Fixture',primaryPhone:'+919999900001',secondaryPhone:null,email:null,memberSince:1,addresses:[address],pets:[{id:'pet-1',sourceId:null,name:'Biscuit',species:'dog',breed:'Golden Retriever',vaccinationStatus:'verified',ageYears:2,weightKg:28,profile:null}],bookings:[],foodOrders:[]};
 const bundle=(code,price)=>({petCount:1,packageCode:code+'-1',price,currency:'INR',slotMinutes:60,blockingMinutes:90,effectiveFrom:'2026-01-01',effectiveTo:null});
 const catalogue={serviceCode:'grooming',packages:[{code:'dog-bath',name:'Essential Bath',description:'Includes Bath, Shampoo & Conditioning, Deshedding, Blow Drying, Combing & Brushing.',audience:'dog',bundles:[bundle('dog-bath',1234)]},{code:'dog-basic',name:'Bath & Basic Grooming',description:'Includes more.',audience:'dog',bundles:[bundle('dog-basic',2345)]}],subscriptions:[{code:'sub-dog-bath-4',name:'Bath Club · 4 visits',price:4321,currency:'INR',sessions:4,validityValue:3,validityUnit:'months',eligiblePetTypes:['dog'],servicePackageCode:'dog-bath',maxPetsPerBooking:1,creditsPerPet:1,familyWallet:false,effectiveFrom:'2026-01-01',effectiveTo:null,version:1}]};
 const coverage=(city='Bengaluru')=>({data:{zone:{zoneId:'blr-south',zoneName:'HSR & Koramangala',serviceAvailable:true},assignment:{pincode:'560102',zoneId:'blr-south',cityId:'blr',city,area:'HSR Layout'}}});
 const fare=(label,total)=>({vehicleClass:label==='Citroen eC3'?'citroen_ec3':'xuv',vehicleLabel:label,eligible:true,distanceFare:total-100,waitingCharge:0,handlerCharge:100,quotedTotal:total,bookingFee:total/2,finalBalanceBeforeAdjustments:total/2,features:['AC','Pet-care trained driver']});
 const taxiQuote=body=>({quoteId:'q-fixture',originLabel:body.originLabel,destinationLabel:body.destinationLabel,returnDropLabel:body.returnDropLabel,passengerCount:body.passengerCount,petCount:body.petCount,luggageCount:body.luggageCount,scheduledStart:body.scheduledStart,scheduledEnd:new Date(Date.parse(body.scheduledStart)+3*3600e3).toISOString(),tripType:body.tripType,ridePurpose:body.ridePurpose,waitingMinutes:body.waitingMinutes,distanceKm:12.4,estimatedDurationMinutes:40,reservationMinutes:180,paymentMode:'split_50_50',recommendedVehicleClass:'citroen_ec3',fareOptions:{citroen_ec3:fare('Citroen eC3',1800),xuv:fare('XUV',2200)},expiresAt:Date.now()+600e3,routeSource:'synthetic_fixture',productionMapsVerified:false,liveMoney:false});
 function groomingApi(overrides={}){return (r)=>{const u=new URL(r.url()),p=u.pathname,m=r.method();
  if(p==='/api/customer-offers'&&overrides.offersFail)return {status:500,body:{error:'Offers unavailable (fixture failure)'}};
  if(p==='/api/identity-session')return {status:200,body:{data:{subjectType:'customer',subjectId:'cust-fixture-1'}}};
  if(p==='/api/service-availability')return {status:200,body:{data:[{code:'grooming',enabled:true}]}};
  if(p==='/api/customer-account')return {status:200,body:{data:overrides.account||account}};
  if(p==='/api/v2/grooming-catalogue')return overrides.catalogue?overrides.catalogue(u):{status:200,body:{data:catalogue}};
  if(p==='/api/service-zone')return overrides.zone||{status:200,body:coverage()};
  if(p==='/api/live-price-quote'&&m==='POST')return {status:200,body:{data:{price:1234,source:'pricing_control'}}};
  if(p==='/api/uat-scheduling'&&m==='POST'){const q=JSON.parse(r.postData()||'{}');return {status:200,body:{data:{providers:[{id:'g-1',name:'Asha Fixture',model:'full_time',rating:4.8}],availabilityChecked:true,reserved:false,cityId:q.cityId,zoneId:q.zoneId,scheduledStart:q.scheduledStart,scheduledEnd:q.scheduledEnd,occurrences:[{start:q.scheduledStart,end:q.scheduledEnd,occurrenceNumber:1}]}}};}
  if(p==='/api/customer-offers'){const orderValue=Number(u.searchParams.get('orderValue'));return {status:200,body:{data:{coupons:[{code:'GROOM200',name:'₹200 off grooming',discountType:'fixed',discountValue:200,maxDiscount:null,minOrder:0,description:'Synthetic offer fixture',autoApply:true,savings:200,finalAmount:orderValue-200}],normalCouponsAllowed:true,bookingCount:0}}};}
  if(p==='/api/coupon-governance'&&m==='POST'){const q=(JSON.parse(r.postData()||'{}').input)||{};return {status:200,body:{data:{valid:true,quoteId:'cq-1',code:'GROOM200',campaignId:'c1',discount:200,orderValue:q.orderValue,finalAmount:q.orderValue-200}}};}
  if(p==='/api/v2/test-coins')return {status:404,body:{error:'TEST coins are disabled in this environment'}};
  return null;};}
 function taxiApi(overrides={}){return (r)=>{const u=new URL(r.url()),p=u.pathname,m=r.method();
  if(p==='/api/service-zone'&&overrides.zoneFail)return {status:404,body:{error:'PIN code 560102 is outside the currently enabled service area.'}};
  if(p==='/api/customer-account')return {status:200,body:{data:overrides.account||account}};
  if(p==='/api/service-zone')return overrides.zone||{status:200,body:coverage()};
  if(p==='/api/taxi-commercial'&&m==='POST')return {status:200,body:{data:taxiQuote(JSON.parse(r.postData()||'{}'))}};
  if(p==='/api/v2/test-coins')return {status:404,body:{error:'TEST coins are disabled in this environment'}};
  return null;};}
 const ALLOWED_POST=new Set(['/api/live-price-quote','/api/uat-scheduling','/api/coupon-governance','/api/taxi-commercial','/api/v2/test-coins']);
 async function scenario(name,page,api,viewport,check){
  const c=await browser.newContext({viewport}),p=await c.newPage();let aborted=0,unmocked=[];
  await p.route('**/api/**',route=>{const r=route.request(),u=new URL(r.url());if(r.method()!=='GET'&&!ALLOWED_POST.has(u.pathname)){aborted++;return route.abort();}const a=api(r);if(!a){unmocked.push(r.method()+' '+u.pathname);return route.fulfill({status:500,contentType:'application/json',body:'{"error":"unmocked"}'});}const send=()=>route.fulfill({status:a.status,contentType:'application/json',body:JSON.stringify(a.body)});if(u.pathname==='/api/service-zone'&&api.zoneDelayMs)return setTimeout(send,api.zoneDelayMs);return send();});
  await p.goto(base+'/?page='+page);
  try{await check(p);results.push({scenario:name,result:'PASS',abortedWrites:aborted,unmocked});}
  catch(error){results.push({scenario:name,result:'FAIL',error:String(error.message).slice(0,240),unmocked});}
  await c.close();
 }
 const text=async p=>(await p.locator('body').innerText());
 const desktop={width:1280,height:900},mobile={width:390,height:800};
 // Grooming, desktop.
 await scenario('grooming desktop: subscription plan is visible in the package grid; serviceability resolves from the default address with no test widget; back control present','grooming',groomingApi(),desktop,async p=>{
  await p.getByText('Who’s getting pampered?').waitFor();
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  const t=await text(p);
  assert.ok(!t.includes('Check service area'),'no manual service-area button');
  assert.match(t,/Bath Club · 4 visits/,'subscription plan rendered on a 1280px viewport');
  assert.match(t,/Subscription · Dogs/);
  assert.match(t,/₹4,321/,'subscription price is the catalogue price given to the page');
  assert.match(t,/← Back to PawSpace/);assert.match(t,/Step 1 of 4/);
  assert.ok(!/1,349|1,899|2,399/.test(t),'no workbook example price leaks into the page');
 });
 await scenario('grooming desktop: selecting a package shows published inclusions/exclusions and the add-on picker; the total is package price plus the ticked add-on from the catalogue','grooming',groomingApi(),desktop,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  await p.getByText('Included',{exact:true}).waitFor();
  const t1=await text(p);
  assert.match(t1,/SELECTED PACKAGE · ₹1,234 for 1 pet/);
  assert.match(t1,/✓ Bath[\s\S]*✓ Shampoo & Conditioning[\s\S]*✓ Deshedding/,'inclusions from lib/grooming-commercial-catalogue dog-bath');
  assert.match(t1,/Not included[\s\S]*— Nail Clipping[\s\S]*— Hair Styling/,'exclusions from the commercial catalogue');
  await p.getByText(/Add-ons · add extra services/).click();
  await p.getByLabel(/Tick & flea treatment/).check();
  const t2=await text(p);
  assert.match(t2,/Package price\s*₹1,733/,'1234 + 499 (catalogue add-on) shown before any live check');
  assert.match(t2,/Includes extras ₹499/);
 });
 await scenario('grooming desktop: Next confirms the live price and groomers, then the coupon auto-applies without pre-filling the special-code box and the step reads Next · review payment','grooming',groomingApi(),desktop,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  const next=p.getByRole('button',{name:/Next · confirm price & groomers/});await next.waitFor();
  assert.equal(await next.isEnabled(),true,'Next is enabled once pets, package, address and slot resolve');
  await next.click();
  await p.getByText('Live price checked').waitFor({timeout:30000});await p.locator('#v2-grooming-summary').getByText('Verified live price').waitFor({timeout:30000}).catch(async()=>{const alerts=await p.getByRole('alert').allInnerTexts();const summary=await p.locator('#v2-grooming-summary').innerText();throw new Error('live check did not resolve; alerts='+JSON.stringify(alerts)+' summary='+summary.replace(/\s+/g,' ').slice(0,400));});
  await p.getByText(/GROOM200 automatically applied/).waitFor({timeout:30000}).catch(async()=>{const g=await p.getByRole('group',{name:'Coupon code'}).innerText().catch(()=>'(no coupon group rendered)');throw new Error('coupon did not auto-apply; coupon group says: '+g.replace(/\s+/g,' ').slice(0,500));});
  assert.equal(await p.getByLabel('Special code').inputValue(),'','the special-code box stays empty');
  const t=await text(p);
  assert.match(t,/GROOM200 applied to this booking/);
  assert.match(t,/Coupon GROOM200 · −₹200\s*₹1,034/);
  assert.match(t,/Next · review payment/);
  assert.ok(!t.includes('Reserve & review payment'));
 });
 await scenario('grooming mobile: the sticky running total and Next are visible on a 390px viewport','grooming',groomingApi(),mobile,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  const bar=p.getByRole('status',{name:'Running total'});await bar.waitFor();
  assert.equal(await bar.isVisible(),true);
  assert.match(await bar.innerText(),/Package price\s*₹1,234\s*Next/);
 });
 await scenario('grooming: a default address that contradicts its PIN is refused at the address step, before any quote or payment, with a retry','grooming',groomingApi({account:{...account,addresses:[{...address,line1:'12, Marine Drive, Mumbai'}]}}),desktop,async p=>{
  await p.getByRole('alert').waitFor({timeout:8000});
  const t=await text(p);
  assert.match(t,/names a different city from Bengaluru/);
  assert.match(t,/Check this address again/);
  assert.ok(!t.includes('is covered'));
  assert.equal(await p.getByRole('button',{name:/Next · confirm price & groomers/}).isDisabled(),true,'no live check without verified coverage');
 });
 await scenario('grooming mobile: after the coupon is server-checked the sticky total shows the NET amount; Remove returns it to the gross price','grooming',groomingApi(),mobile,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  await p.getByRole('button',{name:/Next · confirm price & groomers/}).click();
  await p.getByText(/GROOM200 automatically applied/).waitFor({timeout:30000});
  const bar=p.getByRole('status',{name:'Running total'});
  await bar.getByText('Total after coupon GROOM200').waitFor({timeout:10000});
  assert.match(await bar.innerText(),/Total after coupon GROOM200\s*₹1,034\s*₹1,234 − ₹200 coupon/,'net 1234-200, the same figure payment review shows');
  assert.match(await p.locator('#v2-grooming-summary').innerText(),/Coupon GROOM200 · −₹200\s*₹1,034/);
  assert.equal(await p.getByLabel('Special code').inputValue(),'');
  await p.getByRole('button',{name:'Remove coupon'}).click();
  await bar.getByText('Verified live price').waitFor({timeout:10000});
  assert.match(await bar.innerText(),/Verified live price\s*₹1,234/);
  assert.ok(!(await bar.innerText()).includes('coupon'));
 });
 await scenario('grooming mobile: when offers cannot be checked the special-code box stays empty and the total stays gross','grooming',groomingApi({offersFail:true}),mobile,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  await p.getByRole('button',{name:/Next · confirm price & groomers/}).click();
  await p.getByText(/Offers unavailable \(fixture failure\)/).waitFor({timeout:30000});
  assert.equal(await p.getByLabel('Special code').inputValue(),'');
  const bar=p.getByRole('status',{name:'Running total'});
  assert.match(await bar.innerText(),/Verified live price\s*₹1,234/);
  assert.ok(!(await p.locator('#v2-grooming-summary').innerText()).includes('GROOM200'));
 });
 await scenario('grooming mobile: changing booking details after an automatic offer re-checks it; the box stays empty and the total is re-derived','grooming',groomingApi(),mobile,async p=>{
  await p.getByText('HSR & Koramangala is covered').waitFor({timeout:8000});
  await p.getByRole('button',{name:/Essential Bath/}).click();
  await p.getByRole('button',{name:/Next · confirm price & groomers/}).click();
  await p.getByText(/GROOM200 automatically applied/).waitFor({timeout:30000});
  await p.getByText(/Add-ons · add extra services/).click();
  await p.getByLabel(/Tick & flea treatment/).check();
  const bar=p.getByRole('status',{name:'Running total'});
  await bar.getByText('Package price').waitFor({timeout:10000});
  assert.match(await bar.innerText(),/Package price\s*₹1,733/,'live check invalidated; gross shown, no coupon claimed');
  assert.equal(await p.getByLabel('Special code').count(),0,'coupon box is not rendered until the price is re-confirmed');
  await p.getByRole('button',{name:/Next · confirm price & groomers/}).click();
  await p.getByText(/GROOM200 automatically applied/).waitFor({timeout:30000});
  await bar.getByText('Total after coupon GROOM200').waitFor({timeout:10000});
  assert.match(await bar.innerText(),/Total after coupon GROOM200\s*₹1,533\s*incl\. add-ons ₹499\s*₹1,733 − ₹200 coupon/,'net = 1234 + 499 − 200, matching the summary');
  assert.equal(await p.getByLabel('Special code').inputValue(),'');
 });
 // Taxi.
 await scenario('taxi: no City/Airport choice; the saved address fills pickup and PIN together and is checked at the trip step; 50% is stated on the reserve CTA','taxi',taxiApi(),mobile,async p=>{
  await p.getByText('Who is travelling?').waitFor();
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByText('Trip details').waitFor();
  let t=await text(p);
  assert.ok(!/Airport flat fare|City \/ regular/.test(t));assert.match(t,/actual route kilometres/);assert.match(t,/← Back to passengers & pets/);
  await p.getByLabel('Saved pickup address').selectOption('addr-1');
  assert.equal(await p.getByLabel('Pickup PIN code').inputValue(),'560102','PIN filled from the same saved address');
  assert.match(await p.getByLabel('Pickup address',{exact:true}).inputValue(),/HSR Layout/);
  await p.getByText(/PIN 560102 is served/).waitFor({timeout:8000});
  await p.getByLabel('Drop address / Point 1').fill('Koramangala 5th Block, Bengaluru');
  await p.getByRole('button',{name:'Review ride requirements'}).click();
  t=await text(p);assert.ok(!/Purpose/.test(t));assert.match(t,/Pickup PIN\s*560102 · served/);
  await p.getByRole('button',{name:'Calculate Citroën & XUV fares'}).click();
  await p.getByText('Choose your car').waitFor({timeout:8000});
  t=await text(p);
  assert.match(t,/Pay now to confirm · 50% of the fare\s*₹900/);
  assert.match(t,/Reserve · then pay 50% booking fee \(₹900\)/);
  assert.match(t,/Parking is added only if incurred, at the actual amount/);assert.ok(!/toll/i.test(t));
  assert.match(t,/← Back to ride requirements/);
 });
 await scenario('taxi: a pickup that contradicts its PIN is refused at the trip step and cannot reach the quote','taxi',taxiApi(),mobile,async p=>{
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByLabel('Pickup address',{exact:true}).fill('7, Marine Drive, Mumbai');
  await p.getByLabel('Pickup PIN code').fill('560102');
  await p.getByRole('alert').waitFor({timeout:8000});
  assert.match(await text(p),/names a different city from Bengaluru/);
  await p.getByLabel('Drop address / Point 1').fill('Koramangala 5th Block');
  assert.equal(await p.getByRole('button',{name:'Review ride requirements'}).isDisabled(),true);
 });
 await scenario('taxi: a slow pickup check keeps Next disabled while checking and enables it only after the zone answers','taxi',Object.assign(taxiApi(),{zoneDelayMs:2500}),mobile,async p=>{
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByLabel('Saved pickup address').selectOption('addr-1');
  await p.getByLabel('Drop address / Point 1').fill('Koramangala 5th Block, Bengaluru');
  await p.getByText('Checking that PawSpace serves this pickup…').waitFor();
  const next=p.getByRole('button',{name:'Review ride requirements'});
  assert.equal(await next.isDisabled(),true,'disabled while checking');
  await p.getByText(/PIN 560102 is served/).waitFor({timeout:10000});
  assert.equal(await next.isEnabled(),true,'enabled after the check succeeds');
 });
 await scenario('taxi: a pickup PIN the zone service refuses keeps Next disabled with the refusal shown','taxi',taxiApi({zoneFail:true}),mobile,async p=>{
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByLabel('Saved pickup address').selectOption('addr-1');
  await p.getByLabel('Drop address / Point 1').fill('Koramangala 5th Block, Bengaluru');
  await p.getByRole('alert').waitFor({timeout:10000});
  assert.match(await text(p),/outside the currently enabled service area/);
  assert.equal(await p.getByRole('button',{name:'Review ride requirements'}).isDisabled(),true);
 });
 await scenario('taxi: a manually typed consistent address and PIN verifies and enables Next','taxi',taxiApi(),mobile,async p=>{
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByLabel('Pickup address',{exact:true}).fill('22, 7th Main, HSR Layout, Bengaluru');
  await p.getByLabel('Pickup PIN code').fill('560102');
  await p.getByLabel('Drop address / Point 1').fill('Koramangala 5th Block, Bengaluru');
  await p.getByText(/PIN 560102 is served/).waitFor({timeout:10000});
  assert.equal(await p.getByRole('button',{name:'Review ride requirements'}).isEnabled(),true);
 });
 await scenario('taxi round trip: route pricing is stated plainly, no package price or internal wording, drop and return inputs remain','taxi',taxiApi(),mobile,async p=>{
  await p.getByRole('button',{name:'Biscuit'}).waitFor();
  await p.getByRole('button',{name:'Continue to trip details'}).click();
  await p.getByRole('button',{name:'Round trip'}).click();
  const t=await text(p);
  assert.match(t,/Round trips are priced on the actual route to your drop and return points, plus any planned waiting\. Fixed-hour packages are not offered yet\./);assert.ok(!/admin|policy/i.test(t),'no internal wording');
  assert.ok(!/₹\s?\d+\s*\/\s*(hour|km)/.test(t),'no invented extra-hour or extra-km rate');
  await p.getByLabel('Return drop address').waitFor();
 });
 await browser.close();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});
 console.log(JSON.stringify(results,null,0));
 if(results.some(r=>r.result!=='PASS'))process.exitCode=1;
})();
