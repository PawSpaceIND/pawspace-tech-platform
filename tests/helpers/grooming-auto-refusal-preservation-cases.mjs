import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {preservedGroomingAutoRefusalBytes} from './grooming-auto-refusal-reviewed-delta.mjs';
import {preservedServiceFixBytes} from './service-fix-reviewed-delta.mjs';
const e=JSON.parse(readFileSync(new URL('../fixtures/grooming-auto-refusal-reviewed-delta.json',import.meta.url))),bytes=readFileSync(new URL('../../'+e.file,import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
test('Exact refusal correction restores prior bytes before historical service reversal',()=>{const prior=preservedGroomingAutoRefusalBytes(e.file,bytes);assert.equal(hash(prior),e.beforeSha256);assert.equal(prior.toString(),e.replacements[0][0]);assert.equal(preservedGroomingAutoRefusalBytes(e.file,prior),prior);assert.doesNotThrow(()=>preservedServiceFixBytes(e.file,prior));});
for(const [name,alter]of [['appended',b=>b+'\nUNREVIEWED'],['changed',b=>'X'+b.toString().slice(1)],['removed',b=>b.toString().slice(1)],['line endings',b=>b.toString().replaceAll('\n','\r\n')]])test('Refuses '+name+' mutation',()=>assert.throws(()=>preservedGroomingAutoRefusalBytes(e.file,Buffer.from(alter(bytes)))));
test('Unrelated source identity preserved',()=>{const b=Buffer.from('unrelated');assert.equal(preservedGroomingAutoRefusalBytes('lib/unrelated.ts',b),b);});

// Execute the actual component with an explicit in-memory React/transport harness.
// No production module, provider or network transport is invoked.
import ts from 'typescript';
test('Actual pending automatic coupon can be removed and a late valid quote cannot apply',async()=>{
 const source=readFileSync(new URL('../../app/v2/grooming/coupon-box.tsx',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const state=[],refs=[],effects=[];let index=0,refIndex=0,resolveQuote;const changes=[],checks=[];
 const quote=new Promise(resolve=>{resolveQuote=resolve;});const jsx=(type,props)=>({type,props});
 const react={useState(initial){const i=index++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useRef(initial){const i=refIndex++;return refs[i]??(refs[i]={current:initial});},useCallback(fn){return fn;},useEffect(fn){if(effects.length===0)effects.push(fn);}};
 const module={exports:{}};new Function('module','exports','require',js)(module,module.exports,name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name.includes('coupon-governance-client'))return{quoteGovernedCoupon:()=>quote};if(name.includes('grooming-money'))return{groomingCouponPayable:()=>{throw Error('Late quote must never reach money/application');}};if(name.includes('grooming-offers-client'))return{loadV2GroomingOffers:async()=>({normalCouponsAllowed:true,coupons:[{code:'NORMAL',name:'Normal',description:'Synthetic'}]})};if(name.endsWith('.css'))return{default:new Proxy({},{get:(_,k)=>k})};throw Error(name);});
 const intentRef={current:{customerId:'C1',mode:'automatic',code:''}},props={customerId:'C1',cityId:'blr',packageCode:'basic',orderValue:1899,contextKey:'same',paymentMode:'prepaid',intentRef,onChange:(...args)=>changes.push(args),onChecked:k=>checks.push(k)};
 const render=()=>{index=0;refIndex=0;return module.exports.default(props);};
 const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'?[n,...nodes(n.props?.children)]:[];
 render();effects[0]();await Promise.resolve();await Promise.resolve();
 const tree=render(),remove=nodes(tree).find(n=>n.type==='button'&&n.props.children==='Remove coupon');assert.ok(remove,'Remove remains visible while automatic quote is pending');assert.equal(intentRef.current.mode,'automatic');assert.equal(state[3],true);remove.props.onClick();assert.equal(intentRef.current.mode,'removed');assert.equal(state[3],false);assert.deepEqual(changes.at(-1),[0,'']);
 resolveQuote({valid:true,code:'NORMAL',quoteId:'late',discount:200});await Promise.resolve();await Promise.resolve();render();assert.equal(intentRef.current.mode,'removed');assert.equal(changes.some(c=>c[0]>0||c[2]),false);assert.equal(state[1],'');assert.deepEqual(changes.at(-1),[0,'']);
});
