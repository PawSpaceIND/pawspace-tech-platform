import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__SERVICE_FIX_GUEST_DB__');

// Signed-out /v2/grooming entry (app/v2/grooming/guest-preview.tsx). The component renders exactly the catalogue the
// server published and names loading, empty and refresh-error states with a plain Retry; Continue stays disabled
// until a published package is chosen; mobile verification still precedes pets, address and live scheduling.
// Rendering here uses the same transpile-and-stub technique as tests/task2-grooming-guest-preview.test.mjs, with a
// controllable catalogue loader so the refresh paths are exercised; real lib code is executed in the last test.
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const source=read('app/v2/grooming/guest-preview.tsx');
function elements(node,out=[]){if(Array.isArray(node)){node.forEach(n=>elements(n,out));return out;}if(node&&typeof node==='object'){out.push(node);elements(node.props?.children,out);}return out;}
function fixture(catalogue,loader){
 let values=[],index=0,selected='',verified=0;const jsx=(type,props)=>({type,props:props||{}}),moduleObject={exports:{}};
 const react={useState(initial){const key=index++;if(!(key in values))values[key]=typeof initial==='function'?initial():initial;return [values[key],v=>{values[key]=typeof v==='function'?v(values[key]):v;}];}};
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,Intl,Error,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='next/link')return {default:'a'};if(name.includes('customer-login'))return {default:'otp'};if(name.includes('components/native-art'))return {NativeServiceArt:'native-art'};if(name.includes('grooming.module'))return {default:new Proxy({},{get:(_,k)=>k})};if(name.includes('grooming-subscription-projection'))return {subscriptionPackage:()=>null,subscriptionSavings:()=>null};if(name.includes('grooming-client'))return {groomingBundleForCount:(p,n)=>p.bundles.find(b=>b.petCount===n),loadV2GroomingCatalogue:loader};throw Error(name);}});
 return {render(){index=0;return elements(moduleObject.exports.default({catalogue,selectedCode:selected,onSelect:c=>{selected=c;},onVerified:()=>verified++}));},get selected(){return selected;},get verified(){return verified;}};
}
const text=nodes=>JSON.stringify(nodes);
// Visible words only: JSX splits a sentence with an embedded expression into several children.
const words=nodes=>{const out=[];const walk=n=>{if(Array.isArray(n))n.forEach(walk);else if(n&&typeof n==='object')walk(n.props?.children);else if(typeof n==='string'||typeof n==='number')out.push(String(n));};walk(nodes);return out.join('');};
const bundle=(code,price)=>({petCount:1,packageCode:code+'-1',price,currency:'INR',slotMinutes:60,blockingMinutes:90,effectiveFrom:'2026-01-01',effectiveTo:null});
const populated={serviceCode:'grooming',packages:[{code:'dog-bath',name:'Essential Bath',description:'Fixture description',audience:'dog',bundles:[bundle('dog-bath',1234)]},{code:'cat-routine',name:'Routine Grooming',description:'Fixture cat',audience:'cat',bundles:[bundle('cat-routine',2345)]}]};
const empty={serviceCode:'grooming',packages:[]};
const byClass=(nodes,className)=>nodes.filter(n=>n.props&&n.props.className===className);
const roleText=(nodes,role)=>nodes.filter(n=>n.props&&n.props.role===role).map(n=>text(n)).join(' ');

test('populated: native presentation root, published packages for the chosen pet type, Continue disabled until a package is chosen, OTP only after Continue',()=>{
 const f=fixture(populated,()=>Promise.reject(new Error('not called')));let nodes=f.render();
 const root=nodes.find(n=>n.type==='main');assert.equal(root.props.className,'page');assert.equal(root.props['data-v2-hero-page'],'true');
 for(const cls of ['nav','brand','hero','eyebrow','heroArt','backBar','layout','journey','step','stepHead','packageGrid'])assert.ok(byClass(nodes,cls).length>=1,'native class present: '+cls);
 const art=nodes.find(n=>n.type==='native-art');assert.equal(art.props.service,'grooming');assert.equal(art.props.informative,true);assert.ok(!text(nodes).includes('pawspace-grooming-editorial.webp'),'guest must not fix the art to the Editorial prototype');
 assert.equal(byClass(nodes,'packageCard ').length,1,'only the dog package shows for the default pet type');assert.ok(text(nodes).includes('Essential Bath')&&text(nodes).includes('₹1,234'));
 assert.ok(!text(nodes).includes('Routine Grooming'),'cat package waits for its pet type');
 assert.equal(nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.disabled,true);
 assert.equal(nodes.some(n=>n.type==='otp'),false);
 nodes.find(n=>n.type==='button'&&n.props['aria-pressed']===false).props.onClick();nodes=f.render();
 assert.equal(f.selected,'dog-bath');assert.equal(nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.disabled,false);
 assert.ok(byClass(nodes,'packageCard selectedPackage').length===1);
 nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.onClick();nodes=f.render();
 assert.equal(nodes.filter(n=>n.type==='otp').length,1,'verification section appears only after Continue');
 assert.equal(nodes.find(n=>n.type==='otp').props.embedded,true);
 nodes.find(n=>n.type==='otp').props.onLoggedIn();assert.equal(f.verified,1);
});

test('empty: an authoritative empty catalogue is named, offers Retry, shows no price and keeps Continue disabled',()=>{
 const f=fixture(empty,()=>Promise.reject(new Error('not called')));const nodes=f.render();
 assert.match(text(nodes),/No grooming packages are published for this preview right now\. Only published packages and prices are ever shown here\./);
 assert.ok(!text(nodes).includes('₹'),'no fabricated price');assert.equal(byClass(nodes,'packageGrid').length,0);
 assert.equal(nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.disabled,true);
 assert.ok(nodes.some(n=>n.type==='button'&&n.props.children==='Retry'));
});

test('per pet type: a published catalogue without this pet type says so instead of an empty grid',()=>{
 const f=fixture({serviceCode:'grooming',packages:[populated.packages[1]]},()=>Promise.reject(new Error('not called')));const nodes=f.render();
 assert.match(words(nodes),/No published package for dogs right now\. Choose another pet type above\./);
 assert.ok(!text(nodes).includes('No grooming packages are published'),'the catalogue itself is not empty');
});

test('refresh: Retry shows a loading state with Continue disabled, then the refreshed catalogue; a failed refresh shows the error with Retry and keeps the last catalogue',async()=>{
 let answer;const loader=()=>new Promise((resolve,reject)=>{answer={resolve,reject};});
 const f=fixture(empty,loader);let nodes=f.render();
 nodes.find(n=>n.type==='button'&&n.props.children==='Retry').props.onClick();
 nodes=f.render();
 assert.match(roleText(nodes,'status'),/Refreshing the published packages…/);assert.equal(nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.disabled,true);
 assert.ok(!text(nodes).includes('No grooming packages are published'),'no empty claim while refreshing');
 answer.resolve(populated);await new Promise(r=>setTimeout(r,0));nodes=f.render();
 assert.ok(text(nodes).includes('Essential Bath'),'refreshed catalogue replaces the empty one');assert.equal(roleText(nodes,'status'),'');
 // Now a failing refresh.
 const g=fixture(populated,()=>Promise.reject(new Error('Catalogue unavailable (fixture)')));nodes=g.render();
 assert.equal(nodes.some(n=>n.type==='button'&&n.props.children==='Retry'),false,'no Retry while the catalogue is populated and fresh');
});

test('refresh failure on an empty catalogue: error with Retry, still no price, Continue disabled',async()=>{
 const f=fixture(empty,()=>Promise.reject(new Error('Catalogue unavailable (fixture)')));let nodes=f.render();
 nodes.find(n=>n.type==='button'&&n.props.children==='Retry').props.onClick();await new Promise(r=>setTimeout(r,0));nodes=f.render();
 assert.match(roleText(nodes,'alert'),/Catalogue unavailable \(fixture\)/);
 assert.ok(nodes.some(n=>n.type==='button'&&n.props.children==='Retry'),'Retry remains after a failure');
 assert.ok(!text(nodes).includes('₹'));assert.equal(nodes.find(n=>n.type==='button'&&n.props.className==='continue').props.disabled,true);
});

test('source contract: no fabricated fallback, the same catalogue client and verification component, no new stylesheet or shared-shell imports',()=>{
 assert.doesNotMatch(source,/fallback|placeholderPackages|defaultPackages|\b1,?349\b|\b1,?899\b/i);
 assert.match(source,/loadV2GroomingCatalogue\(\{cityId:'blr'\}\)/,'Retry uses the existing catalogue client for the same city the page uses for guests');
 assert.match(source,/import CustomerLogin from "\.\.\/\.\.\/mobile-app\/customer-login";/);assert.match(source,/<CustomerLogin embedded onLoggedIn=\{onVerified\}\/>/);
 assert.match(source,/import styles from "\.\/grooming\.module\.css";/);assert.doesNotMatch(source,/guest-preview\.module\.css|native-shell|service-bridge-shell|pawspace-appearance/);
 assert.match(source,/data-v2-hero-page="true"/);
 assert.match(source,/disabled=\{!chosen\|\|refresh\.busy\} className=\{styles\.continue\}/);
});

test('executes the real catalogue helpers the preview uses: bundle lookup and subscription projection over a fictional plan',async()=>{
 const {groomingBundleForCount}=await import('../lib/v2/grooming-client.ts');
 const {subscriptionPackage,subscriptionSavings}=await import('../lib/v2/grooming-subscription-projection.ts');
 const pkg=populated.packages[0];
 assert.equal(groomingBundleForCount(pkg,1)?.price,1234);assert.equal(groomingBundleForCount(pkg,2),null,'no two-pet bundle is invented');
 const plan={code:'plan-fixture',name:'Fixture plan',price:4321,currency:'INR',sessions:4,validityValue:3,validityUnit:'months',eligiblePetTypes:['dog'],servicePackageCode:'dog-bath',maxPetsPerBooking:1,creditsPerPet:1,familyWallet:false,effectiveFrom:'2026-01-01',effectiveTo:null,version:1};
 const projected=subscriptionPackage(plan,pkg,'dog');
 assert.ok(projected&&projected.subscription?.code==='plan-fixture'&&groomingBundleForCount(projected,1)?.price===4321);
 assert.equal(subscriptionSavings(projected,pkg),Math.max(0,1234*4-4321));
 assert.equal(subscriptionPackage(plan,pkg,'cat'),null,'a plan is not projected onto a pet type it does not cover');
});
