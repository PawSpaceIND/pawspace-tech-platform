import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node);
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)];}
function moduleFixture(file,exportName,context={}){
 const source=process.env.P1_BASELINE_SOURCE==='1'?execFileSync('git',['show','5e900065ffbd2100f5cd753a9a17fb279b23abc1:'+file],{encoding:'utf8'}):fs.readFileSync(new URL(file,root),'utf8'),parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);let stripped=source;
 for(const node of [...parsed.statements].reverse())if(ts.isImportDeclaration(node)){
  const names=[];if(node.importClause?.name)names.push(node.importClause.name.text);const b=node.importClause?.namedBindings;if(b&&ts.isNamedImports(b))for(const e of b.elements)if(!e.isTypeOnly)names.push(e.name.text);
  for(const name of names)if(!(name in context))context[name]=name.endsWith('Styles')?new Proxy({},{get:(_,k)=>k}):()=>{};
  stripped=stripped.slice(0,node.pos)+stripped.slice(node.end);
 }
 const compiled=ts.transpileModule(stripped.replace(/export default /g,'').replace(/export /g,''),{fileName:file,compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.None}}).outputText;
 try{return Function(...Object.keys(context),compiled+';return '+exportName+';')(...Object.values(context));}catch(error){fs.writeFileSync(new URL('../p1-evidence-ops-evidence/debug-'+exportName+'.js',root),compiled);throw error;}
}
function componentFixture(file,name,context={}){
 let slots=[],cursor=0,effects=[],tree;const hooks={
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
 useRef(value){const i=cursor++;return slots[i]??=( {current:value});},
 useMemo(fn){cursor++;return fn();},
 useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps?.some((v,j)=>v!==old[j])){slots[i]=deps;effects.push(fn);}}
 };const React={createElement(type,props,...children){return {type,props:{...props,children:children.length===1?children[0]:children}};},Fragment:'fragment'};
 const component=moduleFixture(file,name,{...context,...hooks,React,window:{setTimeout(){},prompt(){return'';}},fetch(){throw Error('external transport prohibited');},usePathname:()=>'/trainer',useSearchParams:()=>new URLSearchParams(),baseStyles:new Proxy({},{get:(_,k)=>k}),extraStyles:new Proxy({},{get:(_,k)=>k})});
 const render=()=>{cursor=0;tree=component();const tasks=effects;effects=[];tasks.forEach(fn=>fn());return tree;};
 return {render,find(predicate){const n=nodes(tree).find(predicate);assert.ok(n,'Expected actual component node');return n;},async settle(){for(let i=0;i<8;i++){await Promise.resolve();render();}},button(name){return this.find(n=>n.type==='button'&&text(n.props.children)===name);}};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
const session=id=>({id,booking_id:'BOOK-'+id,programme_id:'P-'+id,plan_name:id,customer_name:'Synthetic',status:'in_session',scheduled_start:'2026-10-03',sequence_no:1,total_sessions:2,completed_sessions:0,requirements:[],progress:{},homework:{text:'Draft '+id},attendance:{},ownerHandover:null});
const asset=(id,purpose)=>({ref:'media://asset/'+id,purpose,proofReady:true});
test('Trainer switching A to delayed B clears A evidence and refuses proof-bearing Save until B settles',async()=>{
 const b=deferred(),writes=[];const f=componentFixture('app/trainer/page.tsx','TrainerPageContent',{TrainingEvidenceControls:'TrainingEvidenceControls',currentProviderIdentity:async()=>({subjectType:'provider',subjectId:'PROV'}),loadTrainerSessions:async()=>[session('A'),session('B')],loadTrainingEvidence:async id=>id==='A'?{assets:[asset('A-before','before_service'),asset('A-after','after_service')]}:b.promise,trainingSessionAction:async payload=>{writes.push(payload);},trainingProgressFromRecord:()=>({focus:null}),trainingProgressReady:()=>false,formatIndiaDateTimeMedium:v=>v});
 f.render();await f.settle();assert.equal(f.button('Save report').props.disabled,false);
 f.find(n=>n.type==='button'&&n.props.key==='B').props.onClick();f.render();
 const controls=f.find(n=>n.type==='TrainingEvidenceControls');assert.deepEqual(controls.props.assets,[]);
 assert.equal(f.button('Save report').props.disabled,true);f.button('Save report').props.onClick();await f.settle();assert.deepEqual(writes,[]);
 b.resolve({assets:[asset('B-before','before_service')]});await f.settle();assert.equal(f.button('Save report').props.disabled,false);
 f.button('Save report').props.onClick();await f.settle();assert.equal(writes[0].sessionId,'B');assert.deepEqual(writes[0].report.evidenceRefs,['media://asset/B-before']);
});
for(const kind of ['boarding','sitting'])test(kind+' released settlement is clear, outstanding/unknown/reversed stays in attention',async()=>{
 let settlement={approval_status:'approved',payout_status:'released_sandbox',payout_rule_status:'rule_applied',tax_status:'resolved'};
 const record={id:'SYNTHETIC',status:'completed',payment_status:'captured',care_plan_status:'ready'};
 const db={prepare(sql){return {bind(){return this;},async run(){return{meta:{changes:0}};},async first(){return sql.includes('settlement_ledger')?settlement:null;},async all(){return{results:sql.includes('SELECT s.*')||sql.includes('SELECT b.*')?[record]:[]};}};},async batch(){return[];}};
 const fn=moduleFixture('lib/'+kind+'-ops-governance.ts',kind==='boarding'?'getBoardingOpsSnapshot':'getSittingOpsSnapshot',{collectedForBooking:async()=>1200});
 const flags=async()=>{const result=await fn(db);return (result.stays??result.bookings)[0].exceptionFlags;};
 assert.ok(!(await flags()).includes('settlement_not_ready'));
 for(const [approval,payout] of [['awaiting_finance_approval','not_instructed'],['approved','not_instructed'],['approved','unknown'],['approved','reversed'],['unknown','released_sandbox']]){settlement={approval_status:approval,payout_status:payout,payout_rule_status:'rule_applied',tax_status:'resolved'};assert.ok((await flags()).includes('settlement_not_ready'),approval+'/'+payout);}
 for(const overrides of [{tax_status:'configuration_required'},{payout_rule_status:'rule_pending'}]){settlement={approval_status:'approved',payout_status:'released_sandbox',payout_rule_status:'rule_applied',tax_status:'resolved',...overrides};assert.ok((await flags()).includes('settlement_not_ready'));}
});
for(const kind of ['host','sitter'])test(kind+' proof refresh is read-only, preserves drafts and rejects stale/rejected approval',async()=>{
 let reads=0,fail=false;const writes=[];const media=kind==='host'?{id:'PHOTO',ref:'media://asset/PHOTO',purpose:'stay_update',scan_status:'clean',access_status:'ready',retention_status:'active',synthetic:0,review_status:'approved',proofReady:true}:{id:'PHOTO',mediaRef:'media://asset/PHOTO',purpose:'sitting_update',scan_status:'clean',access_status:'ready',retention_status:'active',synthetic:0,review_status:'approved',proofReady:true};
 const snapshot=()=>kind==='host'?{stay:{status:'in_progress',carePlanStatus:'ready'},media:[{...media}],medication:[],incidents:[],storage:{},communications:{}}:{status:'in_progress',media:[{...media}],medications:[],incidents:[],communications:{}};
 const load=async()=>{reads++;if(fail)throw Error('Synthetic read error');return snapshot();};
 const f=componentFixture('app/'+kind+'/proof/page.tsx',kind==='host'?'BoardingProofPage':'SittingProofPage',{useQueryParameter:()=> 'SYNTHETIC',loadBoardingProof:load,loadSittingProof:load,isVerifiedProof:item=>item.review_status==='approved',partnerProofState:item=>item.review_status,PARTNER_PROOF_STATE_TEXT:{approved:'verified',rejected:'rejected'},updateBoardingProof:async p=>writes.push(p),updateSittingProof:async p=>writes.push(p)});
 f.render();await f.settle();const choice=kind==='host'?'Select a verified daily stay photo':'Select a verified care update photo';
 f.find(n=>n.type==='select'&&text(n.props.children).includes(choice)).props.onChange({target:{value:'media://asset/PHOTO'}});if(kind==='host')f.find(n=>n.type==='textarea'&&n.props.placeholder==='Care update shown in the stay timeline').props.onChange({target:{value:'Keep care draft'}});f.render();
 const actionName=kind==='host'?'Record daily update with verified proof':'Record care update with verified proof';assert.equal(f.button(actionName).props.disabled,false);
 const draft=f.find(n=>n.type==='input'&&n.props.placeholder==='Medication');draft.props.onChange({target:{value:'Keep this draft'}});f.render();
 const refresh=f.button('Refresh photo approval');assert.equal(refresh.props.disabled,false);media.review_status='rejected';refresh.props.onClick();await f.settle();assert.equal(reads,2);assert.deepEqual(writes,[]);assert.equal(f.button(actionName).props.disabled,true);f.button(actionName).props.onClick();await f.settle();assert.deepEqual(writes,[]);assert.equal(f.find(n=>n.type==='input'&&n.props.placeholder==='Medication').props.value,'Keep this draft');
 fail=true;f.button('Refresh photo approval').props.onClick();await f.settle();assert.ok(nodes(f.render()).some(n=>n.props?.role==='alert'));assert.deepEqual(writes,[]);
});
for(const kind of ['boarding','sitting'])test(kind+' Operations resolves exact incident with required note through existing API and refreshes counts',async()=>{
 const incident={id:'INC-1',status:'open',severity:'attention',summary:'Synthetic care issue',ops_status:'open'};let reads=0;const writes=[];
 const snapshot=()=>({[kind==='boarding'?'stays':'bookings']:[{id:'SERVICE-A',booking_id:'BOOK-A',status:'in_progress',exceptionFlags:incident.status==='open'?['care_incident']:[],incidents:[{...incident}],replacementCandidates:[],refunds:[],media:[],notes:[]}],readiness:{engineeringGate:'local',productionReady:false,externalDependencies:[]},metrics:{total:1,openIncidents:incident.status==='open'?1:0}});
 const load=async()=>{reads++;return snapshot();};const update=async p=>{writes.push(p);incident.status='resolved';return{status:'resolved'};};
 const f=componentFixture('app/team/operations/'+kind+'/page.tsx',kind==='boarding'?'BoardingOperationsPage':'SittingOperationsPage',{loadBoardingOps:load,loadSittingOps:load,updateBoardingProof:update,updateSittingProof:update});f.render();await f.settle();
 assert.equal(f.button('Resolve incident').props.disabled,true);f.button('Resolve incident').props.onClick();await f.settle();assert.deepEqual(writes,[]);
 f.find(n=>n.type==='textarea'&&n.props['aria-label']==='Resolution note for incident INC-1').props.onChange({target:{value:'Independent staff reviewed and resolved'}});f.render();assert.equal(f.button('Resolve incident').props.disabled,false);f.button('Resolve incident').props.onClick();await f.settle();assert.equal(writes.length,1);assert.equal(writes[0].action,'resolve_incident');assert.equal(writes[0].incidentId,'INC-1');assert.equal(writes[0][kind==='boarding'?'stayId':'bookingId'],'SERVICE-A');assert.equal(writes[0].resolution,'Independent staff reviewed and resolved');assert.equal(reads,2);assert.ok(!nodes(f.render()).some(n=>n.type==='button'&&text(n.props.children)==='Resolve incident'));
});
test('actual Training save_report rejects A refs for B before writing, but preserves evidence-free draft notes',async()=>{
 const writes=[],row={id:'B',booking_id:'BOOK-B',provider_id:'PROV',programme_id:'P-B',status:'in_session',attendance_json:'{}',homework_json:'{}',progress_json:'{}',evidence_json:'[]'};
 const db={prepare(sql){let args;return{bind(...values){args=values;return this;},async first(){if(sql.startsWith('SELECT s.*'))return row;if(sql.startsWith('SELECT status FROM canonical_bookings'))return{status:'confirmed'};if(sql.includes('JOIN training_session_media_links'))return{session_id:'A',booking_id:'BOOK-A',provider_id:'PROV',link_provider_id:'PROV'};return null;},async all(){return{results:[]};},async run(){if(sql.startsWith('UPDATE training_sessions'))writes.push({sql,args});return{meta:{changes:1}};}};},async batch(){return[];}};
 const action=moduleFixture('lib/training-session-lifecycle.ts','mutateTrainingSessionCore');
 const input={sessionId:'B',action:'save_report',actorId:'trainer',idempotencyKey:'SYNTHETIC',report:{homework:'Keep draft notes',evidenceRefs:['media://asset/A']}};
 await assert.rejects(action(db,input),error=>error instanceof Response&&error.status===409);assert.equal(writes.length,0);
 const result=await action(db,{...input,idempotencyKey:'DRAFT',report:{homework:'Keep draft notes'}});assert.equal(result.reportSaved,true);assert.equal(writes.length,1);assert.ok(writes[0].args.includes('{"text":"Keep draft notes"}'));
});
