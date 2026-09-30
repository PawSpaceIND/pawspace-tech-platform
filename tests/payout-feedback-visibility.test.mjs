import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {uiBehaviorSignatures} from '../scripts/ui-audit-event-contract.mjs';
installWorkersHooks('__PAYOUT_FEEDBACK_UI_DB__');
const {default:PayoutActionFeedback}=await import('../app/components/ui/PayoutActionFeedback.tsx');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const baseline=JSON.parse(read('tests/fixtures/payout-feedback-source-contract.json'));
const completion='setPayoutFeedbackRequest(request=>request+1);';
const wrapper='<PayoutActionFeedback requestId={payoutFeedbackRequest}>';
function validatePlacement(source,path){
 const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),wrappers=[],functions=[],calls=[];
 function walk(node){
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='PayoutActionFeedback')wrappers.push(node);
  if(ts.isFunctionDeclaration(node))functions.push(node);
  if(ts.isCallExpression(node)&&node.expression.getText(tree)==='setPayoutFeedbackRequest')calls.push(node);
  ts.forEachChild(node,walk);
 }
 walk(tree);assert.equal(wrappers.length,1);
 const children=wrappers[0].children.filter(n=>!ts.isJsxText(n)||n.text.trim());
 assert.equal(children.length,2,'Feedback wraps exactly the original error and notice expressions');
 for(const[index,name]of ['error','notice'].entries()){
  const child=children[index];assert.ok(ts.isJsxExpression(child)&&child.expression&&ts.isBinaryExpression(child.expression),'Feedback child must be an outcome expression');
  assert.equal(child.expression.operatorToken.kind,ts.SyntaxKind.AmpersandAmpersandToken);assert.equal(child.expression.left.getText(tree),name);
 }
 const names=path.includes('/partners/')?['release','sendTestPayout']:['sendPayout'];
 assert.equal(calls.length,names.length,'No unrelated action may advance the payout focus token');
 for(const name of names){
  const matches=functions.filter(fn=>fn.name?.text===name);assert.equal(matches.length,1);
  const guarded=matches[0].body.statements.filter(ts.isTryStatement);assert.equal(guarded.length,1);
  assert.equal(guarded[0].finallyBlock?.statements.at(-1)?.getText(tree),completion,'Only explicit payout completion requests focus');
 }
}
function recoverOriginal(source,path){
 validatePlacement(source,path);
 for(const addition of ['import PayoutActionFeedback from "../../../components/ui/PayoutActionFeedback";\n',wrapper,'</PayoutActionFeedback>',',[payoutFeedbackRequest,setPayoutFeedbackRequest]=useState(0)']){
  assert.equal(source.split(addition).length,2,'Exactly one reviewed wrapper/import/counter is allowed');source=source.replace(addition,'');
 }
 const count=path.includes('/partners/')?2:1;assert.equal(source.split(';'+completion).length,count+1);
 return path.includes('/partners/')?source.replaceAll(';'+completion,''):source.replace(completion,'');
}
for(const[p,before]of Object.entries(baseline.files))test('Payout feedback retains original complete page bytes and request events: '+p,()=>{
 const source=read(p),original=recoverOriginal(source,p);assert.equal(hash(original),before.sha256);
 assert.deepEqual(uiBehaviorSignatures(source,p),uiBehaviorSignatures(original,p));
});
test('Feedback is keyboard-focusable and preserves alert text safely',()=>{
 const html=renderToStaticMarkup(createElement(PayoutActionFeedback,{requestId:1},createElement('p',{role:'alert'},'<Pay again?>')));
 assert.match(html,/tabindex="-1"/);assert.match(html,/role="group"/);assert.match(html,/aria-label="Payout action outcome"/);
 assert.match(html,/<p role="alert">&lt;Pay again\?&gt;<\/p>/);
});
test('Feedback has no network, identity storage, payout authority or scheduled work',()=>{
 const source=read('app/components/ui/PayoutActionFeedback.tsx');
 assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|document\.cookie|setTimeout|setInterval|dangerouslySetInnerHTML/);
 assert.match(source,/if\(!requestId\|\|!feedback\.current\?\.textContent\?\.trim\(\)\)return/);
 assert.match(source,/\},\[requestId\]\)/);assert.doesNotMatch(source,/\[notice\]|\[error\]/);
 assert.match(source,/focus\(\{preventScroll:true\}\)/);assert.match(source,/scrollIntoView\(\{block:"center",inline:"nearest",behavior:"instant"\}\)/);
});
test('Original-byte proof rejects changed payout endpoints, payloads and busy safeguards',()=>{
 const p='app/team/finance/partners/page.tsx',source=read(p);
 for(const[from,to]of [['/api/razorpayx-test-dispatch','/api/unsafe-dispatch'],['JSON.stringify({payoutId})','JSON.stringify({payoutId:"other"})'],['disabled={Boolean(busy)}','disabled={false}']]){
  assert.ok(source.includes(from));assert.notEqual(hash(recoverOriginal(source.replace(from,to),p)),baseline.files[p].sha256);
 }
});
test('Placement proof rejects a wrapper moved away from the payout outcomes',()=>{
 const p='app/team/finance/partners/page.tsx',source=read(p);
 const moved=source.replace(wrapper,'').replace('</PayoutActionFeedback>','').replace('<header ',wrapper+'<header ').replace('</header>','</header></PayoutActionFeedback>');
 assert.throws(()=>validatePlacement(moved,p),/Feedback wraps exactly|Feedback child/);
});
test('Placement proof rejects a missing completion request or unrelated focus trigger',()=>{
 const p='app/team/finance/contractors/page.tsx',source=read(p);
 assert.throws(()=>validatePlacement(source.replace(completion,''),p),/No unrelated action/);
 assert.throws(()=>validatePlacement(source+'\nfunction unrelated(){'+completion+'}',p),/No unrelated action/);
});
test('Original historical source baseline was not repinned',()=>{
 assert.equal(baseline.base,'1610115c881220eb6db5cb67298779cb0c9f6f63');
});
const requiredUiSuites=['ui-audit-closure.spec.ts','ui-audit-finance-feedback.spec.ts','ui-audit-readiness.spec.ts'];
function validateUiWorkflow(source){
 const tree=ts.createSourceFile('playwright.ui-audit.config.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const exported=tree.statements.find(ts.isExportAssignment)?.expression;
 assert.ok(exported&&ts.isCallExpression(exported)&&exported.expression.getText(tree)==='defineConfig');
 const config=exported.arguments[0];
 function value(object,key){
  assert.ok(ts.isObjectLiteralExpression(object),'Configuration must remain a reviewable object');
  const matches=object.properties.filter(p=>ts.isPropertyAssignment(p)&&p.name.getText(tree)===key);
  assert.equal(matches.length,1,'Exactly one '+key+' configuration is required');
  return matches[0].initializer;
 }
 const suites=value(config,'testMatch');assert.ok(ts.isArrayLiteralExpression(suites));
 const names=suites.elements.map(n=>{assert.ok(ts.isStringLiteral(n));return n.text;});
 for(const name of requiredUiSuites)assert.ok(names.includes(name),'Required UI suite missing: '+name);
 assert.equal(value(config,'retries').getText(tree),'0');
 assert.equal(value(config,'workers').getText(tree),'1');
 assert.equal(value(value(config,'webServer'),'reuseExistingServer').kind,ts.SyntaxKind.FalseKeyword);
}
test('Viewport and review regressions remain in the zero-retry isolated UI workflow',()=>{
 validateUiWorkflow(read('playwright.ui-audit.config.ts'));
 const suite=read('e2e/ui-audit-finance-feedback.spec.ts');
 assert.match(suite,/toBeFocused\(\)/);assert.match(suite,/r\.top>=0&&r\.bottom<=innerHeight/);
 assert.match(suite,/review error-only payout/);assert.match(suite,/review unrelated action keeps focus/);
 assert.doesNotMatch(suite,/scrollIntoViewIfNeeded|\.focus\(|waitForTimeout|test\.skip|test\.only/);
});

test('UI workflow proof rejects removed suites, retries and reused servers',()=>{
 const source=read('playwright.ui-audit.config.ts');
 for(const suite of requiredUiSuites)assert.throws(()=>validateUiWorkflow(source.replace('"'+suite+'"','"unrelated.spec.ts"')),/Required UI suite missing/);
 for(const[from,to]of [['retries:0','retries:1'],['workers:1','workers:2'],['reuseExistingServer:false','reuseExistingServer:true']]){
  assert.ok(source.includes(from));assert.throws(()=>validateUiWorkflow(source.replace(from,to)));
 }
});
