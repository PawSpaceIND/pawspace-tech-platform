// Actual TSX event handlers, deterministic React hook adapter, no DOM/provider transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const require=createRequire(path.join(repo,'package.json'));
const ts=require('typescript');
const file='app/team/finance/sitting/sitting-finance-workspace.tsx';
const code=ts.transpileModule(readFileSync(path.join(repo,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const data=id=>({booking:{id,status:'completed',total_amount:id==='SIT-A'?548:9876,captured_amount:id==='SIT-A'?548:9876,payment_status:'captured'},cancellations:[{id:`CANCEL-${id}`,status:"policy_review_required",reason:"Synthetic QA"}],refunds:[{id:`REFUND-${id}`,amount:100,status:"sandbox_pending"}],dateChanges:[{id:`DATE-${id}`,status:"commercial_quote_required",old_total:548,new_total:548}],settlement:{approval_status:"awaiting_finance_approval"},reconciliation:null,sandboxOnly:true});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(load=async id=>data(id)){
 let slot=0;const states=[],effects=[],refs=[],pendingEffects=[],updates=[],loads=[];
 const hooks={
  createElement(type,props,...children){return {type,props:{...props,children}};},
  Fragment:'fragment',
  useState(initial){const index=slot++;if(!(index in states))states[index]=typeof initial==='function'?initial():initial;return [states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];},
  useRef(initial){const index=slot++;return refs[index]??=( {current:initial} );},
  useEffect(fn,deps){const index=slot++;const old=effects[index];if(!old||deps.some((v,i)=>v!==old.deps[i])){pendingEffects.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:fn()};});}},
 };
 const componentModule={exports:{}};
 const context=vm.createContext({module:componentModule,exports:componentModule.exports,React:hooks,require(name){if(name==='react')return hooks;if(name.includes('sitting-finance-client'))return {loadSittingFinance:async id=>{loads.push(id);return load(id);},updateSittingFinance:async payload=>{updates.push(payload);return {status:'ok'};}};if(name.includes('sitting-reconciliation-display'))return {sittingReconciliationLabel:()=>''};return new Proxy(()=>null,{get:()=>()=>null});},window:{prompt:text=>text.startsWith('Approved refund amount')?'100':'Synthetic QA approval'},console,Date,Intl,Number,String,Error,crypto:globalThis.crypto});
 vm.runInContext(code,context,{filename:file});
 let props={initialBookingId:'SIT-A'};
 const render=next=>{if(next)props=next;slot=0;const tree=componentModule.exports.default(props);while(pendingEffects.length)pendingEffects.shift()();return tree;};
 const nodes=tree=>{const out=[];function visit(n){if(Array.isArray(n)){n.forEach(visit);return;}if(!n||typeof n!=='object')return;out.push(n);visit(n.props?.children);}visit(tree);return out;};
 const text=n=>Array.isArray(n)?n.map(text).join(''):typeof n==='object'&&n?text(n.props?.children):String(n??'');
 const button=(tree,name)=>nodes(tree).find(n=>n.type==='button'&&text(n)===name);
 const input=tree=>nodes(tree).find(n=>n.type==='input'&&n.props.placeholder==='Canonical Sitting booking ID');
 return {render,button,input,updates,loads};
}
async function start(f){f.render();await flush();return f.render();}
test('normal loaded A settlement request retains A identity',async()=>{
 const f=fixture();const tree=await start(f);f.button(tree,'Prepare canonical settlement').props.onClick();await flush();assert.equal(f.updates.length,1);assert.equal(f.updates[0].bookingId,'SIT-A');assert.match(f.updates[0].idempotencyKey,/SIT-A/);
});
for(const action of ['Prepare canonical settlement','Run canonical reconciliation','Approve when eligible','Approve explicitly','Record sandbox refund','Apply with quote + replacement schedule'])test(`editing ID to B cannot retarget visible A ${action}`,async()=>{
 const f=fixture();let tree=await start(f);f.input(tree).props.onChange({target:{value:'SIT-B'}});tree=f.render();const button=f.button(tree,action);if(button&&!button.props.disabled)button.props.onClick();await flush();assert.equal(f.updates.length,0,`Old A controls remain active; actual request: ${JSON.stringify(f.updates)}`);
});
test('failed B load cannot leave actionable A rows under B identity',async()=>{
 const f=fixture(async id=>{if(id==='SIT-B')throw new Error('Synthetic B read failure');return data(id);});let tree=await start(f);f.input(tree).props.onChange({target:{value:'SIT-B'}});tree=f.render();f.button(tree,'Load booking').props.onClick();await flush();tree=f.render();const button=f.button(tree,'Prepare canonical settlement');if(button&&!button.props.disabled)button.props.onClick();await flush();assert.equal(f.updates.length,0);
});
test('late manual A read cannot overwrite fresh initial-prop B booking',async()=>{
 let aReads=0;const slow=deferred();const f=fixture(async id=>id==='SIT-A'&&++aReads===2?slow.promise:data(id));let tree=await start(f);f.button(tree,'Load booking').props.onClick();f.render({initialBookingId:'SIT-B'});await flush();slow.resolve(data('SIT-A'));await flush();tree=f.render();assert.equal(f.input(tree).props.value,'SIT-B');const button=f.button(tree,'Prepare canonical settlement');assert.ok(button&&!button.props.disabled);button.props.onClick();await flush();assert.equal(f.updates.at(-1).bookingId,'SIT-B');
});
test('editing while an A action is pending cannot change its refresh target',async()=>{
 const slow=deferred();let reads=0;const f=fixture(async id=>++reads===2?slow.promise:data(id));let tree=await start(f);f.button(tree,'Prepare canonical settlement').props.onClick();await flush();tree=f.render();const input=f.input(tree);assert.equal(input.props.disabled,true,'Booking identity is locked while mutation is pending.');slow.resolve(data('SIT-A'));await flush();assert.equal(f.updates[0].bookingId,'SIT-A');assert.equal(f.loads.at(-1),'SIT-A');
});

test('explicit successful B load makes B the only action and idempotency authority',async()=>{
 const f=fixture();let tree=await start(f);f.input(tree).props.onChange({target:{value:'SIT-B'}});tree=f.render();f.button(tree,'Load booking').props.onClick();await flush();tree=f.render();f.button(tree,'Prepare canonical settlement').props.onClick();await flush();assert.equal(f.updates.length,1);assert.equal(f.updates[0].bookingId,'SIT-B');assert.match(f.updates[0].idempotencyKey,/SIT-B/);assert.equal(f.loads.at(-1),'SIT-B');
});
test('a mismatched finance response does not grant authority to returned booking A',async()=>{
 const f=fixture(async()=>data('SIT-A'));let tree=await start(f);f.input(tree).props.onChange({target:{value:'SIT-B'}});tree=f.render();f.button(tree,'Load booking').props.onClick();await flush();tree=f.render();const button=f.button(tree,'Prepare canonical settlement');assert.equal(button,undefined);assert.equal(f.updates.length,0);
});
test('repeated same rendered callback cannot submit a second concurrent mutation',async()=>{
 const slow=deferred();let reads=0;const f=fixture(async id=>++reads===2?slow.promise:data(id));const tree=await start(f);const button=f.button(tree,'Prepare canonical settlement');button.props.onClick();button.props.onClick();await flush();assert.equal(f.updates.length,1);slow.resolve(data('SIT-A'));await flush();
});

for(const [label,field,prefix] of [['Approve explicitly','cancellationRequestId','CANCEL'],['Record sandbox refund','refundId','REFUND'],['Apply with quote + replacement schedule','dateChangeRequestId','DATE']])test(`selected ${field} is explicit in the actual UI mutation`,async()=>{
 const f=fixture(async id=>{const value=data(id);value.refunds.push({id:'REFUND-NEWER',amount:500,status:'sandbox_pending'});value.cancellations.push({id:'CANCEL-NEWER',status:'policy_review_required'});value.dateChanges.push({id:'DATE-NEWER',status:'commercial_quote_required',old_total:548,new_total:548});return value;});const tree=await start(f);f.button(tree,label).props.onClick();await flush();assert.equal(f.updates.length,1);assert.equal(f.updates[0].bookingId,'SIT-A');assert.equal(f.updates[0][field],`${prefix}-SIT-A`);assert.match(f.updates[0].idempotencyKey,new RegExp(`${prefix}-SIT-A`));
});
test('whitespace lookup keeps settlement identity key canonical',async()=>{
 const f=fixture();const tree=await start(f);f.input(tree).props.onChange({target:{value:' SIT-A '}});f.button(f.render(),'Load booking').props.onClick();await flush();f.button(f.render(),'Prepare canonical settlement').props.onClick();await flush();assert.equal(f.updates[0].bookingId,'SIT-A');assert.equal(f.updates[0].idempotencyKey,'sitting-finance:settlement:SIT-A');
});
