// Actual TSX handler -> actual client -> actual authenticated route -> real SQLite governance.
// Only the React hook adapter and same-process HTTP dispatch are simulated. No external transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {world,seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedSittingBooking} from './helpers/stay-harness.mjs';
installWorkersHooks('__TASK5_ROW_DB__','__TASK5_ROW_ENV__');
const client=await import('../lib/sitting-finance-client.ts');
const governance=await import('../lib/sitting-finance-governance.ts');
const route=await import('../app/api/sitting-finance/route.ts');
const require=createRequire(import.meta.url),ts=require('typescript');
const sourcePath='app/team/finance/sitting/sitting-finance-workspace.tsx';
const source=readFileSync(new URL('../'+sourcePath,import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const FINANCE='row.checker@example.test',MAKER='row.maker@example.test',CUSTOMER='row.customer@example.test';
const BOOKING='TEST-SIT-ROW-A',REFERENCE='TEST-REF-INTENDED-100';
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function completedDispatch(completion){
 let timer;try{await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Actual Finance dispatch did not complete within 15 seconds')),15000);})]);}
 finally{clearTimeout(timer);}
}
function workspace(initialBookingId,prompts){
 let slot=0;const state=[],refs=[],effects=[],pending=[];
 const hooks={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
  useState(initial){const i=slot++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value;}];},
  useRef(initial){const i=slot++;return refs[i]??={current:initial};},
  useEffect(fn,deps){const i=slot++,old=effects[i];if(!old||deps.some((value,j)=>value!==old.deps[j]))pending.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:fn()};});},
 };
 const componentModule={exports:{}};
 vm.runInNewContext(code,{module:componentModule,exports:componentModule.exports,React:hooks,require(name){if(name==='react')return hooks;if(name.includes('sitting-finance-client'))return client;if(name.includes('sitting-reconciliation-display'))return {sittingReconciliationLabel:()=>''};return new Proxy(()=>null,{get:()=>()=>null});},window:{prompt(message){prompts.push(message);return REFERENCE;}},Date,Intl,Number,String,Error,crypto:globalThis.crypto,console},{filename:sourcePath});
 const render=()=>{slot=0;const tree=componentModule.exports.default({initialBookingId});while(pending.length)pending.shift()();return tree;};
 const text=n=>Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):String(n??'');
 const nodes=tree=>{const out=[];function visit(n){if(Array.isArray(n)){n.forEach(visit);return;}if(!n||typeof n!=='object')return;out.push(n);visit(n.props?.children);}visit(tree);return out;};
 const refundButton=(tree,amount)=>{const formatted=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);const row=nodes(tree).find(n=>n.type==='div'&&n.props.children?.some(c=>c?.type==='strong'&&text(c)===formatted));return nodes(row).find(n=>n.type==='button'&&text(n)==='Record sandbox refund');};
 return {render,refundButton};
}
test('actual row click records its explicit row or fails closed, never the newer obligation',async t=>{
 const f=world('__TASK5_ROW_DB__','__TASK5_ROW_ENV__',{NODE_ENV:'test',APP_ENV:'staging',PAWSPACE_LOCAL_PREVIEW:'off',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'});
 t.after(()=>f.sqlite.close());
 const realNow=Date.now;let clock=realNow();Date.now=()=>++clock;t.after(()=>{Date.now=realNow;});
 const seeded=await seedSittingBooking(f.db,f.sqlite,{bookingId:BOOKING,customerId:'TEST-CUS-ROW-A',groupId:'TEST-GRP-ROW-A',reservationId:'TEST-RES-ROW-A',amount:1000,amountDueNow:1000});
 f.sqlite.prepare("UPDATE canonical_customers SET name='Synthetic row fixture',primary_phone='synthetic-no-contact' WHERE id=?").run(seeded.customerId);
 await seedActors(f.sqlite,f.db,[{id:'TEST-ROW-FIN',email:FINANCE,role:'finance'},{id:'TEST-ROW-CUS',email:CUSTOMER,role:'customer'}]);
 const direct=(action,key,extra={})=>governance.mutateSittingFinance(f.db,{bookingId:BOOKING,action,actorId:MAKER,idempotencyKey:key,...extra});
 // Both requests genuinely precede cancellation; real approval creates both obligations and cases.
 const request1=await direct('request_cancel','TEST-ROW-REQUEST-1',{reason:'Synthetic split refund request one'});
 const request2=await direct('request_cancel','TEST-ROW-REQUEST-2',{reason:'Synthetic split refund request two'});
 const older=await direct('approve_cancel','TEST-ROW-APPROVAL-100',{actorId:FINANCE,cancellationRequestId:request2.requestId,approvedRefundAmount:100,reason:'Synthetic Finance approval100'});
 const newer=await direct('approve_cancel','TEST-ROW-APPROVAL-500',{actorId:FINANCE,cancellationRequestId:request1.requestId,approvedRefundAmount:500,reason:'Synthetic Finance approval500'});
 assert.notEqual(older.refundId,newer.refundId);
 const rows=()=>f.sqlite.prepare('SELECT id,booking_id,amount,status,reference,created_at FROM sitting_refund_ledger ORDER BY created_at').all().map(row=>({...row}));
 const before=rows();assert.deepEqual(before.map(row=>[row.amount,row.status]),[[100,'sandbox_pending'],[500,'sandbox_pending']]);
 let actor=FINANCE;const calls=[],original=globalThis.fetch;let forbidden=0;
 let finishFinanceRead,finishFinancePost;const financeReadCompleted=new Promise(resolve=>{finishFinanceRead=resolve;}),financePostCompleted=new Promise(resolve=>{finishFinancePost=resolve;});
 t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(path,init={})=>{
  const url=new URL(String(path),'https://app.pawspace.in');
  if(url.origin!=='https://app.pawspace.in'||url.pathname!=='/api/sitting-finance'||!['GET','POST'].includes(init.method||'GET')){forbidden++;throw new Error('Forbidden test transport');}
  const request=asActor(actor,url.pathname+url.search,init),response=await route[init.method||'GET'](request);
  calls.push({method:init.method||'GET',actor,body:init.body?JSON.parse(String(init.body)):null,status:response.status,response:await response.clone().json()});
  if(actor===FINANCE){if((init.method||'GET')==='GET')finishFinanceRead();else finishFinancePost();}
  return response;
 };
 // Customer role cannot mutate either pending row through the same actual client/route.
 actor=CUSTOMER;await assert.rejects(client.updateSittingFinance({bookingId:BOOKING,action:'record_refund',idempotencyKey:'TEST-ROW-CUSTOMER-DENIAL',refundReference:'TEST-ROW-DENIED'}));
 assert.equal(calls.at(-1).status,403);assert.deepEqual(rows(),before);actor=FINANCE;
 const prompts=[],ui=workspace(BOOKING,prompts);ui.render();await completedDispatch(financeReadCompleted);await flush();let tree=ui.render();
 const button=ui.refundButton(tree,100);assert.ok(button,'The genuine UI renders the older INR100 pending refund action');assert.equal(Boolean(button.props.disabled),false);
 button.props.onClick();await completedDispatch(financePostCompleted);await flush();tree=ui.render();
 const posted=calls.find(call=>call.method==='POST'&&call.actor===FINANCE&&call.body?.action==='record_refund');assert.ok(posted,'Actual client reached the actual Finance route');
 const after=rows();
 const evidence={source_base:'5e900065ffbd2100f5cd753a9a17fb279b23abc1',component_sha256:createHash('sha256').update(source).digest('hex'),intended_refund:{id:older.refundId,amount:100},newer_refund:{id:newer.refundId,amount:500},before,prompts,posted,after,canonical_cases:f.sqlite.prepare('SELECT id,amount,status,gateway_reference FROM booking_refund_cases WHERE booking_id=? ORDER BY created_at').all().map(row=>({...row})),reconciliation:f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_reconciliation_records'").get()?f.sqlite.prepare('SELECT * FROM payment_reconciliation_records WHERE payment_id=?').get('PAY-'+BOOKING):null,customer_denial_status:403,forbidden_transport_attempts:forbidden,limitations:'Deterministic React hook adapter and in-process HTTP; real client/route/SQLite governance. Seeded collected payment; no hosted UI, gateway transport, live money, GST acceptance or customer contact.'};
 writeFileSync(new URL('../../task5-sitting-row-v2-ui-contract-green-evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
 t.diagnostic(JSON.stringify({intended:evidence.intended_refund,actual:posted.response?.data,prompt:prompts[0],customer_denial:403,forbidden_transport_attempts:forbidden}));
 assert.equal(forbidden,0);assert.ok(posted.body.idempotencyKey.includes(String(older.refundId)),"Actual UI key identifies the clicked older row");
 if(posted.body.refundId){
  assert.equal(posted.body.refundId,older.refundId);assert.equal(posted.status,200,JSON.stringify(posted.response));
  assert.equal(posted.response.data.refundId,older.refundId);assert.equal(posted.response.data.amount,100);assert.equal(after.find(row=>row.id===newer.refundId).status,'sandbox_pending');
 }else{
  assert.equal(posted.status,400,'Legacy UI missing explicit refundId must fail closed');assert.deepEqual(after,before,'Missing row identity cannot process either obligation');
  t.diagnostic('UI row-ID forwarding remains pending integration; legacy handler is safely refused. This is not UI acceptance.');
 }
});
