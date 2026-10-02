import {preservedReviewedFoodBytes} from './helpers/food-route-review.mjs';
import {reverseGuestContinuity} from './helpers/guest-continuity-review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
import {preservedBrandStyleBytes} from './helpers/approved-brand-style.mjs';
const base=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,base));
const c=JSON.parse(read('tests/fixtures/customer-partner-theme-contract.json'));
const hash=v=>createHash('sha256').update(v).digest('hex');
for(const [p,x]of Object.entries(c.styles))test('Approved theme append preserves original stylesheet: '+p,()=>assert.equal(hash(preservedBrandStyleBytes(p)),x.hash));
test('All application logic, route aliases, validation and business engines retain exact bytes',()=>{
 for(const [p,h]of Object.entries(c.protected))assert.equal(hash(preservedReviewedFoodBytes(p,read(p))),h,p);
});
test('Theme consumers compose the same palette; style changes cannot grant permissions',()=>{
 for(const [p,x]of Object.entries(c.styles)){
  const s=read(p).toString().split(c.marker)[1];assert.ok(s,p);
  const root=postcss.parse(s);let compositions=0;
  root.walkDecls('composes',d=>{assert.match(d.value,/palette from .*brand-surface\.module\.css/);compositions++;});
  assert.equal(compositions,x.roots.length,p);
 }
 const shared=read('app/components/brand/brand-surface.module.css').toString(),tokens=read('app/pawspace-design-system.css').toString();
 assert.match(shared,/--brand-primary:var\(--paw-primary\)/);assert.match(shared,/--brand-gold:var\(--paw-gold\)/);assert.match(shared,/font-family:var\(--paw-font\)/);assert.match(shared,/Nunito-Variable/);
 assert.match(tokens,/#894aed/i);assert.match(tokens,/#ffaf00/i);assert.match(tokens,/#01261f/i);assert.match(tokens,/#e6b34e/i);
 assert.doesNotMatch(shared,/https?:\/\/|javascript:|expression\(/);
});

test('New customer management layouts preserve their only child and reuse existing V2 navigation',()=>{
 const expected='import V2ServiceBridgeShell from "../../service-bridge-shell"; export default function Layout({children}:{children:React.ReactNode}){return <V2ServiceBridgeShell>{children}</V2ServiceBridgeShell>;}';
 for(const p of ['app/v2/boarding/manage/layout.tsx','app/v2/sitting/manage/layout.tsx']){
  const source=read(p).toString().replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,' ').trim();
  assert.equal(source,expected,p);
 }
});
test('Browser appearance inventory includes every Customer V2 page without claiming staff aliases',()=>{
 const pages=fs.readdirSync(new URL('app/v2',base),{recursive:true}).filter(p=>p==='page.tsx'||p.endsWith('/page.tsx'));
 const expected=pages.map(p=>'/v2'+(p==='page.tsx'?'':'/'+p.slice(0,-9))).filter(p=>!['/v2/partner','/v2/workspaces','/v2/crm','/v2/control-center','/v2/control','/v2/system-integration','/v2/assisted-booking','/v2/employee','/v2/payroll','/v2/people','/v2/people/offboarding'].includes(p)&&!p.startsWith('/v2/partner/')&&!p.startsWith('/v2/team')).sort();
 // Staff aliases have their own employee-surface coverage; verify their exact canonical target.
 for(const [path,target] of [['employee','../../me/page'],['payroll','../../team/people/payroll/page'],['people','../../team/people/page'],['people/offboarding','../../../team/people/offboarding/page']]){
  const source=read(`app/v2/${path}/page.tsx`).toString();assert.ok(source.includes('export {default} from '));assert.ok(source.includes(target),path+' must remain a canonical staff alias');
 }
 const script=read('scripts/verify-customer-partner-theme-ui.mjs').toString(),array=script.match(/const paths=(\[[^;]+\]);/);
 assert.ok(array,'Explicit browser route inventory is required');
 const actual=[...array[1].matchAll(/'([^']+)'/g)].map(m=>m[1].split('?')[0]).filter(p=>p!=='/partner'&&p!=='/v2/partner').sort();
 assert.deepEqual(actual,expected);
});

import {createFoodQuote,createCanonicalFoodOrder} from '../lib/food-client.ts';
import {validateRelocationInquiry} from '../lib/relocation-inquiry-input.ts';
import {customerScopedHref} from '../lib/v2/route-scope.ts';
test('Executed Food clients retain customer/pet quote identity, source quote and idempotency',async()=>{
 const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options={})=>{requests.push({url,method:options.method,body:JSON.parse(options.body)});return Response.json({data:url==='/api/food-commercial'?{quoteId:'THEME-QUOTE',totalAmount:1300}:{orderId:'THEME-ORDER',totalAmount:1300}});};
 try{
  const quote=await createFoodQuote({sku:'THEME-FOOD',quantity:2,customerId:'THEME-CUSTOMER',petIds:['THEME-PET']});
  assert.equal(quote.quoteId,'THEME-QUOTE');assert.equal(quote.totalAmount,1300);
  const customer={id:'THEME-CUSTOMER',name:'Theme fixture',primaryPhone:'9000000001'};
  const order=await createCanonicalFoodOrder({idempotencyKey:'food:THEME-QUOTE:THEME-CUSTOMER',quoteId:quote.quoteId,customer});
  assert.equal(order.orderId,'THEME-ORDER');assert.equal(order.totalAmount,1300);
  assert.deepEqual(requests,[{url:'/api/food-commercial',method:'POST',body:{sku:'THEME-FOOD',quantity:2,customerId:'THEME-CUSTOMER',petIds:['THEME-PET'],zoneId:'blr-east',paymentMode:'sandbox_deferred'}},{url:'/api/food-orders',method:'POST',body:{idempotencyKey:'food:THEME-QUOTE:THEME-CUSTOMER',quoteId:'THEME-QUOTE',customer,cityId:'blr',zoneId:'blr-east'}}]);
 }finally{globalThis.fetch=original;}
});
test('Executed Relocation validator keeps explicit age zero and refuses missing route data',()=>{
 const now=Date.UTC(2026,8,25),input={customerId:'THEME-CUSTOMER',petName:'Milo',breed:'Indie',ageYears:'0',sizeClass:'small',travelMode:'road',originCountry:'India',originCity:'Bengaluru',destinationCountry:'India',destinationCity:'Pune',targetTravelDate:'2026-12-01',crateRequirement:''};
 const valid=validateRelocationInquiry(input,now);assert.equal(valid.ok,true);assert.equal(valid.kind,'domestic');assert.equal(valid.value.ageYears,0);assert.equal(valid.value.destinationCountry,'India');assert.equal(valid.value.crateRequirement,'assessment_required');
 const invalid=validateRelocationInquiry({...input,ageYears:'',destinationCountry:'',destinationCity:''},now);assert.equal(invalid.ok,false);assert.ok(invalid.errors.ageYears);assert.ok(invalid.errors.destinationCountry);assert.ok(invalid.errors.destinationCity);assert.equal(invalid.value,null);
});
test('Executed route scoping retains original Food and Relocation record identifiers',()=>{
 assert.equal(customerScopedHref('/v2/food/subscriptions','/food/subscription-invoice?invoiceId=THEME%2FINVOICE'),'/v2/food/subscription-invoice?invoiceId=THEME%2FINVOICE');
 assert.equal(customerScopedHref('/v2/relocation','/relocation?caseId=THEME%2FCASE'),'/v2/relocation?caseId=THEME%2FCASE');
 assert.equal(customerScopedHref('/food/subscriptions','/food/subscription-invoice?invoiceId=THEME%2FINVOICE'),'/food/subscription-invoice?invoiceId=THEME%2FINVOICE');
});

// Employee AI is embedded in a legacy shell. Its opt-in outer chrome must match the shared palette too.
test('Employee AI chrome matches all seven shared palette values in both palettes and modes',()=>{
 const employee=read('app/mobile-app/employee-ai-mobile.module.css').toString(),brand=read('app/components/brand/brand-surface.module.css').toString();
 const mapping={bg:'bg',surface:'surface',text:'text',muted:'muted',primary:'primary',line:'line','on-primary':'on-primary'};
 for(const [name,paw] of Object.entries(mapping)){
  assert.match(employee,new RegExp(`--employee-${name}:var\\(--paw-${paw}\\)`),name);
  assert.match(brand,new RegExp(`--brand-${name}:var\\(--paw-${paw}\\)`),name);
 }
 assert.doesNotMatch(employee,/--employee-(?:bg|surface|text|muted|primary|line|on-primary):#/);
 const tree=postcss.parse(employee);tree.walkRules(rule=>{if(rule.selector.includes('main[data-pawspace-mobile]'))assert.ok(rule.selectors.every(selector=>selector.includes(':has(.shell.shell)')),'Legacy chrome changes must be conditional on the employee AI panel');});
});

// Additional V2 audit source contracts. Runtime proof remains in the browser and service tests.
import {uiWiringContract} from "./helpers/ui-wiring-contract.mjs";
{
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const baseline = JSON.parse(read('tests/fixtures/v2-ui-wiring-contract.json'));
function reviewedTrainingAndContinuitySource(source,name){
 if(name==='app/training/page.tsx'){
  // Only the independently reviewed V2 default changes; handlers and guards stay in the contract.
  const cadence='[cadenceDays,setCadenceDays]=useState(routeScope==="v2"?3:7)';
  assert.equal(source.split(cadence).length,2,'Exactly one reviewed V2 cadence default');
  source=source.replace(cadence,'[cadenceDays,setCadenceDays]=useState(7)');
 }
 return reverseGuestContinuity(source,name);
}
for (const [name, expected] of Object.entries(baseline.files)) {
 test('AST interaction snapshot matches baseline: ' + name, () => assert.deepEqual(uiWiringContract(reviewedTrainingAndContinuitySource(read(name),name), name), expected));
}
test('wiring contract detects changes to handlers and disabled guards', () => {
 const source = read('app/walking/page.tsx');
 const changedHandler = source.replace('onClick={()=>void finalizeBooking()}', 'onClick={()=>void otherBooking()}');
 assert.notEqual(changedHandler, source);
 assert.notDeepEqual(uiWiringContract(changedHandler), uiWiringContract(source));
 const changedGuard = source.replace('disabled={!quote||quoteLoading||', 'disabled={false||quoteLoading||');
 assert.notEqual(changedGuard, source);
 assert.notDeepEqual(uiWiringContract(changedGuard), uiWiringContract(source));
});
test('new layout is a V2 presentation wrapper, not a data or permission layer', () => {
 const source = read('app/v2/layout.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
 assert.match(source, /data-pawspace-v2="true"/);
 assert.match(source, /\{children\}/);
 assert.doesNotMatch(source, /fetch\(|useEffect|localStorage|cookie|identity|payment\(/i);
});
test('every document-wide utility override is conditional on the V2 route boundary', () => {
 const css = postcss.parse(read('app/v2/presentation.module.css'));
 css.walkRules(rule => {
  if (/\bbody\b/.test(rule.selector)) assert.ok(rule.selectors.every(s => s.includes(':has([data-pawspace-v2])')), rule.selector);
 });
 assert.match(read('app/v2/presentation.module.css'), /composes: palette from/);
});
test('sparse V2 booking states keep their content and shared navigation', () => {
 for (const path of ['booking/layout.tsx', 'booking-confirmation/layout.tsx', 'grooming/manage/layout.tsx']) {
  const source = read('app/v2/' + path);
  assert.match(source, /<V2ServiceBridgeShell>\{children\}<\/V2ServiceBridgeShell>/);
  assert.doesNotMatch(source, /fetch\(|useState|useEffect/);
 }
});
test('sandbox and no-auto-charge notices survive customer-copy changes', () => {
 assert.match(read('app/food/canonical-food-page.tsx'), /explicit test catalogue\/inventory values only/);
 assert.match(read('app/taxi/canonical-taxi-page.tsx'), /synthetic UAT route class/);
 assert.match(read('app/training/page.tsx'), /DOG TRAINING · CANONICAL UAT/);
 assert.match(read('app/food/subscriptions/page.tsx'), /silently change price/);
});

}

// Compact navigation is allowed to move; executable data-flow, validation and submission are not.
import {uiDataFlowContract} from './helpers/ui-wiring-contract.mjs';
{
 const compact=JSON.parse(read('tests/fixtures/v2-ui-wiring-contract.json')).compactDataFlow;
 for(const [file,expected] of Object.entries(compact.files))test('Compact UI preserves pre-change data flow: '+file,()=>assert.deepEqual(uiDataFlowContract(reverseGuestContinuity(read(file).toString(),file),file),expected));
 test('Compact UI keeps the exact official PawSpace logo bytes',()=>assert.equal(hash(read('public/assets/pawspace-official-lockup.png')),compact.logoSha256));
 test('Data-flow guard rejects a changed booking call despite navigation exclusions',()=>{
  const file='app/v2/page.tsx',source=read(file).toString(),changed=source.replace('loadV2CustomerAccount()', 'loadDifferentCustomerAccount()');
  assert.notEqual(changed,source);assert.notDeepEqual(uiDataFlowContract(changed,file),uiDataFlowContract(source,file));
 });
 test('Funeral V2 entry reuses the established support component without a new data path',()=>{
  const source=read('app/v2/funeral-memorial/page.tsx').toString();assert.match(source,/<FuneralMemorialPage homeHref="\/v2"\/>/);assert.doesNotMatch(source,/fetch\(|useEffect|useState|localStorage/);
 });
}

test('High-risk customer and partner audit fixes retain their scoped readability safeguards',()=> {
 const appended=path=>read(path).toString().split(c.marker)[1];
 const rules=path=>postcss.parse(appended(path));
 const values=(root,selectorNeedle,property)=>{const out=[];root.walkRules(rule=>{if(rule.selector.includes(selectorNeedle))rule.walkDecls(property,d=>out.push(d.value));});return out;};
 const grooming=rules('app/v2/grooming/grooming.module.css');
 assert.ok(values(grooming,'.page .summary','background').includes('var(--brand-hero)'));
 for(const selector of ['summaryTop span','summaryRows span','priceBlock > span','priceBlock small','safe p'])
  assert.ok(values(grooming,selector,'color').includes('var(--brand-on-primary)'),selector);
 for(const selector of ['summaryTop b','priceBlock > b','safe > span'])
  assert.ok(values(grooming,selector,'color').includes('var(--brand-gold)'),selector);
 const partner=rules('app/partner-app/partner.module.css');
 assert.ok(values(partner,'detailCard .detailHead small','color').includes('var(--brand-text)'));
 assert.ok(values(partner,'headerSignOut','min-width').includes('66px'));
 assert.ok(values(partner,'headerSignOut','white-space').includes('nowrap'));
 assert.ok(values(partner,'headerSignOut','word-break').includes('normal'));
 assert.ok(values(partner,'headerSignOut','overflow-wrap').includes('normal'));
});

// Exact reviewed Food migration and mutation rejection.
const reviewedFoodPath='app/v2/food/page.tsx',bridge=read(reviewedFoodPath);
test('reviewed Food bridge reconciles exactly with immutable historical source hash',()=>{
 const before=preservedReviewedFoodBytes(reviewedFoodPath,bridge);
 assert.equal(createHash('sha256').update(before).digest('hex'),'15bb74478aa59bbdd8f74e35b9ff00e1025b9b051d26c68202c98192921fad49');
 assert.equal(preservedReviewedFoodBytes(reviewedFoodPath,before),before);
});
test('unreviewed route redirection or parameter change is refused',()=>{
 for(const [from,to]of [['../food-experience','../other-experience'],['<V2FoodExperience/>','<V2FoodExperience unsafe/>']])assert.throws(()=>preservedReviewedFoodBytes(reviewedFoodPath,bridge.toString().replace(from,to)));
});
test('Food handler, identity, stock and disabled-guard mutations are refused',()=>{
 for(const[from,to]of [['createCanonicalFoodOrder({','unsafeOrder({'],['loadV2CustomerSession()','fakeCustomerSession()'],['active.uat_available_units','999'],['!quoteCurrent||quoteLoading','false||quoteLoading']]){
  const source=read('app/v2/food-experience.tsx').toString();assert.ok(source.includes(from),from);
  assert.throws(()=>preservedReviewedFoodBytes(reviewedFoodPath,bridge,file=>file.endsWith('.tsx')?source.replace(from,to):read(file)),from);
 }
});
test('unreviewed Food CSS drift is refused',()=>{
 assert.throws(()=>preservedReviewedFoodBytes(reviewedFoodPath,bridge,file=>file.endsWith('.css')?Buffer.concat([read(file),Buffer.from('\nbutton{display:none}')]):read(file)));
});
test('legacy Food, clients, APIs, subscriptions and unrelated routes never get transformed',()=>{
 for(const file of ['app/food/canonical-food-page.tsx','lib/food-client.ts','lib/food-subscription-client.ts','app/api/food-commercial/route.ts','app/v2/grooming/page.tsx']){
  const bytes=read(file);assert.equal(preservedReviewedFoodBytes(file,bytes),bytes,file);
 }
});
