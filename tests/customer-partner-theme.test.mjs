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
 for(const [p,h]of Object.entries(c.protected))assert.equal(hash(read(p)),h,p);
});
test('Theme consumers compose the same palette; style changes cannot grant permissions',()=>{
 for(const [p,x]of Object.entries(c.styles)){
  const s=read(p).toString().split(c.marker)[1];assert.ok(s,p);
  const root=postcss.parse(s);let compositions=0;
  root.walkDecls('composes',d=>{assert.match(d.value,/palette from .*brand-surface\.module\.css/);compositions++;});
  assert.equal(compositions,x.roots.length,p);
 }
 const shared=read('app/components/brand/brand-surface.module.css').toString();
 assert.match(shared,/#894aed/i);assert.match(shared,/#ffaf00/i);assert.match(shared,/#01261f/i);assert.match(shared,/#e6b34e/i);assert.match(shared,/Nunito-Variable/);
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
 const expected=pages.map(p=>'/v2'+(p==='page.tsx'?'':'/'+p.slice(0,-9))).filter(p=>!['/v2/partner','/v2/workspaces','/v2/crm','/v2/control-center'].includes(p)).sort();
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
 const employee=postcss.parse(read('app/mobile-app/employee-ai-mobile.module.css').toString());
 const brand=postcss.parse(read('app/components/brand/brand-surface.module.css').toString());
 const names=['bg','surface','text','muted','primary','line','on-primary'];
 function values(tree,prefix,theme,mode){
  const out={};tree.walkRules(rule=>{
   if(rule.selector.includes('data-paw-theme="signature"')&&theme!=='signature')return;
   if(rule.selector.includes('data-paw-mode="dark"')&&mode!=='dark')return;
   rule.walkDecls(d=>{if(d.prop.startsWith(prefix)&&!d.value.includes('var('))out[d.prop.slice(prefix.length)]=d.value;});
  });return out;
 }
 for(const theme of ['emerald','signature'])for(const mode of ['light','dark']){
  const actual=values(employee,'--employee-',theme,mode),expected=values(brand,'--brand-',theme,mode);
  for(const name of names)assert.equal(actual[name],expected[name],theme+'/'+mode+' '+name);
 }
 employee.walkRules(rule=>{if(rule.selector.includes('main[data-pawspace-mobile]'))assert.ok(rule.selectors.every(s=>s.includes(':has(.shell.shell)')),'Legacy chrome changes must be conditional on the employee AI panel');});
});
