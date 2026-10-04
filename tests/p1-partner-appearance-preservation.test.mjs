import {preservedCombinedLocalBytes} from './helpers/combined-local-reviewed-delta.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Exact source pins from reviewed P1 head912fd3; also match actual main559da3d.
const sourcePins={"app/components/pawspace-appearance.tsx":"26b59e11e9e25420613991e3dcfb545fc61a245a378d1b67784b308e348af34d","app/trainer/page.tsx":"806fb04f542bb8fa0e71184ae347e6f3a3066e3863565793c754af2e60c1a060","app/trainer/trainer.module.css":"82a3d29b07748ac0ff4d7279eb33aa0418f767d10d5774ec861047d4569285fc","app/host/proof/page.tsx":"047195ddee59a584d451d02c9694e8163282c6a5c45279686c2ebc5303189d7d","app/sitter/proof/page.tsx":"65a5b41c0642c354a6f3c24a5b83956acd11980df629892a588c6d0a95170192","app/team/operations/boarding/page.tsx":"0e9c511ea7fc4ca9387bef59c6ef3d1c143808a721d4336390bc107a924b291d","app/team/operations/sitting/page.tsx":"ca032e887882d86bbf6bf5b3f16459612f1e842717cc2a4c643948da75bda984"};
const files=['app/components/pawspace-appearance.tsx','app/trainer/page.tsx','app/trainer/trainer.module.css','app/host/proof/page.tsx','app/sitter/proof/page.tsx','app/team/operations/boarding/page.tsx','app/team/operations/sitting/page.tsx'];
for(const file of files)test(`Published source unchanged: ${file}`,()=>assert.equal(createHash('sha256').update(preservedCombinedLocalBytes(file,readFileSync(file))).digest('hex'),sourcePins[file]));
test('Only the three reviewed V2 proof workspaces acquire an existing hydrated utility slot',()=>{
 const source=readFileSync('app/v2/partner/layout.tsx','utf8');
 assert.match(source,/new Set\(\["\/v2\/partner\/trainer","\/v2\/partner\/host\/proof","\/v2\/partner\/sitter\/proof"\]\)/);
 assert.match(source,/if\(!scoped\)return children/);assert.match(source,/data-paw-appearance-slot="partner-proof"/);
 assert.match(source,/slot.dataset.pawAppearanceReady="true"/);assert.match(source,/delete slot.dataset.pawAppearanceReady/);
 assert.doesNotMatch(source,/fetch\(|localStorage|showModal|createPortal|permission|bookingId|stayId/);
});
test('Utility occupies normal flow; no global fixed offset or hidden control',()=>{
 const css=readFileSync('app/v2/partner/proof-appearance.module.css','utf8');
 assert.match(css,/\.scope \.utility :global\(\.paw-appearance-trigger\)/);assert.match(css,/position:static !important/);assert.match(css,/min-width:44px/);assert.match(css,/min-height:44px/);
 assert.doesNotMatch(css,/position:(?:fixed|absolute|sticky)|display:none|visibility:hidden/);
});

// Execute the complete application module; this hook fixture commits refs before effects,
// as React does. Browser hydration/portal/focus evidence remains in the separate E2E suite.
async function layoutFixture(initialPath){
 const ts=await import('typescript');const {runInNewContext}=await import('node:vm');
 let path=initialPath,cursor=0,effects=[],tree;const slots=[],cleanups=new Map();
 const react={useRef(value){const i=cursor++;return slots[i]??={current:value};},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>v!==old[j])){slots[i]=deps;effects.push(()=>{cleanups.get(i)?.();cleanups.delete(i);const cleanup=fn();if(typeof cleanup==='function')cleanups.set(i,cleanup);});}}};
 const jsx=(type,props)=>({type,props});const runtimeModule={exports:{}};
 const compiled=ts.transpileModule(readFileSync(new URL('app/v2/partner/layout.tsx',new URL('../',import.meta.url)),'utf8'),{fileName:'layout.tsx',compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 runInNewContext(compiled,{module:runtimeModule,exports:runtimeModule.exports,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name==='next/navigation')return{usePathname:()=>path};if(name==='./proof-appearance.module.css')return{default:{scope:'scope',utility:'utility'}};throw Error('Unexpected application dependency: '+name);},fetch(){throw Error('External request prohibited');}});
 const component=runtimeModule.exports.default;
 return{render(children,nextPath=path){path=nextPath;cursor=0;tree=component({children});const utilityNode=tree?.props?.children?.[0];if(utilityNode?.props?.ref){const ref=utilityNode.props.ref;ref.current??={dataset:{}};return{tree,slot:ref.current};}slots[0].current=null;return{tree,slot:null};},commit(){const pending=effects;effects=[];pending.forEach(fn=>fn());},unmount(){cleanups.forEach(fn=>fn());cleanups.clear();},};
}
for(const path of ['/v2/partner/trainer','/v2/partner/host/proof','/v2/partner/sitter/proof'])test(`Actual layout commits a ready utility slot and retains exact child at ${path}`,async()=>{
 const f=await layoutFixture(path),child={type:'workspace',props:{draft:'Retain exact synthetic draft'}};
 const {tree,slot}=f.render(child);assert.equal(tree.props.children[1],child);assert.equal(tree.props.children[0].props['data-paw-appearance-slot'],'partner-proof');assert.equal(slot.dataset.pawAppearanceReady,undefined);
 f.commit();assert.equal(slot.dataset.pawAppearanceReady,'true');f.unmount();assert.equal(slot.dataset.pawAppearanceReady,undefined);
});
for(const path of ['/v2/partner','/v2/partner/driver/proof','/v2/partner/host','/v2/partner/future/proof'])test(`Actual layout leaves unlisted route untouched: ${path}`,async()=>{
 const f=await layoutFixture(path),child={type:'existing-workspace'};const {tree,slot}=f.render(child);assert.equal(tree,child);assert.equal(slot,null);f.commit();f.unmount();
});
test('Actual scoped-to-unlisted navigation revokes the captured slot without replacing children',async()=>{
 const f=await layoutFixture('/v2/partner/trainer'),child={type:'workspace'};const first=f.render(child);f.commit();assert.equal(first.slot.dataset.pawAppearanceReady,'true');
 const second=f.render(child,'/v2/partner/driver');assert.equal(second.tree,child);assert.equal(second.slot,null);f.commit();assert.equal(first.slot.dataset.pawAppearanceReady,undefined);f.unmount();
});
