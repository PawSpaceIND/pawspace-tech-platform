import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {trainingAttendanceReady,trainingBeforeCaptured} from '../lib/training-partner-precheck.ts';
const require=createRequire(import.meta.url),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),ts=require('typescript');
const source=readFileSync(new URL('../app/trainer/page.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const attendance={mode:'parent',safeAreaConfirmed:true,parentOrCaretakerConfirmed:true};
function render({status='arrived',providerModel='commission',saved=false,captured=false,access='quarantined',settled=true}={}){
 const session={id:'SESSION',booking_id:'BOOKING',programme_id:'PROGRAMME',status,providerModel,plan_name:'Puppy programme',customer_name:'Customer',sequence_no:1,total_sessions:4,completed_sessions:0,scheduled_start:'2099-01-01T05:30:00.000Z',attendance:saved?attendance:{}};
 const evidence=captured?[{purpose:'before_service',access_status:access,proofReady:false}]:[];
 const states=['today','TRAINER',[session],session.id,false,false,'','',evidence,null,'parent',true,true,'',{},null,'',Date.now(),settled?session.id:'',false,'','',false,''];let i=0;
 const nullComponent=()=>null,hookReact={...React,useState:()=>[states[i++],()=>{}],useEffect:()=>{},useMemo:fn=>fn(),useRef:value=>({current:value})};
 const localRequire=id=>{
  if(id==='react')return hookReact;if(id==='react/jsx-runtime')return require(id);
  if(id==='next/navigation')return{usePathname:()=>'/trainer',useSearchParams:()=>new URLSearchParams()};
  if(id==='next/link')return{__esModule:true,default:({href,children})=>React.createElement('a',{href},children)};
  if(id.endsWith('.css'))return{__esModule:true,default:{}};
  if(id.endsWith('training-partner-precheck'))return{trainingAttendanceReady,trainingBeforeCaptured};
  if(id.endsWith('training-progress-editor'))return{trainingProgressFromRecord:()=>({}),trainingProgressReady:()=>false};
  if(id.endsWith('india-time'))return{formatIndiaDateTimeMedium:value=>value};
  if(id.endsWith('lifecycle-presentation'))return{trainingHomeworkStatus:()=>'',trainingHandoverReminder:()=>false};
  if(id.endsWith('session-proof'))return{TrainingEvidenceControls:nullComponent,TrainingOwnerHandover:nullComponent,TrainingVideoControls:nullComponent};
  if(id.endsWith('training-session-client'))return{};
  return{__esModule:true,default:nullComponent};
 };
 const module={exports:{}};runInNewContext(code,{require:localRequire,module,exports:module.exports,Date,Intl,URLSearchParams});
 return renderToStaticMarkup(React.createElement(module.exports.default));
}
const button=(html,label)=>{const match=[...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find(m=>m[2]===label);return match?{disabled:/\bdisabled=/.test(match[1])}:null;};
test('actual trainer page renders arrived Save attendance before Start; persisted attendance and captured proof gate Start',()=>{
 const empty=render();assert.equal(button(empty,'Save attendance &amp; safety').disabled,false);assert.equal(button(empty,'Start session').disabled,true);assert.ok(empty.indexOf('Save attendance &amp; safety')<empty.indexOf('Start session'));
 assert.equal(button(render({saved:true}),'Start session').disabled,true);
 assert.equal(button(render({saved:true,captured:true}),'Start session').disabled,false);
 assert.equal(button(render({saved:true,captured:true,access:'pending_upload'}),'Start session').disabled,true);
 assert.equal(button(render({saved:true,captured:true,access:'revoked'}),'Start session').disabled,true);
 assert.equal(button(render({saved:true,captured:true,settled:false}),'Start session').disabled,true);
});
test('actual full-time scheduled controls omit Accept and enable travel; contractors must accept',()=>{
 const staff=render({status:'scheduled',providerModel:'full_time'});assert.equal(button(staff,'Accept'),null);assert.equal(button(staff,'On the way').disabled,false);
 const contractor=render({status:'scheduled'});assert.equal(button(contractor,'Accept').disabled,false);assert.equal(button(contractor,'On the way').disabled,true);
});
