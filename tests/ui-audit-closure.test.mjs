import {reverseTrainingReadGeneration} from './helpers/training-finance-read-generation-review.mjs';
import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
import {reverseAtlasHandoffDeadline} from './helpers/atlas-handoff-deadline-review.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import { uiBehaviorSignatures } from '../scripts/ui-audit-event-contract.mjs';
const read = file => readFileSync(new URL('../'+file,import.meta.url),'utf8');
const contract = JSON.parse(read('tests/fixtures/ui-audit-event-contract.json'));
for (const [file, expected] of Object.entries(contract.files)) {
  test(`UI audit preserves original events, requests and field contracts: ${file}`,()=>{
    const reviewed=[...expected];
  for(const patch of [...(contract.presentationChanges?.[file]||[])].reverse()) {
   assert.deepEqual(reviewed.slice(patch.index,patch.index+patch.remove.length),patch.remove);
   reviewed.splice(patch.index,patch.remove.length,...patch.insert);
  }
  assert.deepEqual(uiBehaviorSignatures(reverseAtlasHandoffDeadline(read(file),file),file),reviewed);
  });
}
test('table repair stays scoped and never hides document overflow',()=>{
  const css=read('app/components/staff-workspace/visual-audit-closure.module.css');
  const sheet=postcss.parse(css);
  sheet.walkDecls(declaration=>{
    if (/^overflow/.test(declaration.prop)) assert.ok(!/hidden|clip/.test(declaration.value));
  });
  assert.match(css,/table-layout:auto !important/);
  assert.match(css,/min-width:42rem !important/);
  assert.match(css,/word-break:normal/);
  assert.match(css,/\[data-audit-list-detail\] > article:has\(> p:only-child\) \{ min-height:0 !important; \}/);
});
test('Atlas formatter treats content as text and retains the original response',()=>{
  const source=read('app/components/ui/ReadableText.tsx');
  assert.doesNotMatch(source,/dangerouslySetInnerHTML|innerHTML|eval\(|new Function|<iframe/);
  assert.match(read('app/team/ai/atlas-chat.tsx'),/<ReadableText text=\{item.content\}/);
  assert.match(read('app/team/ai/atlas-chat.tsx'),/<ReadableText text=\{answer.content\}/);
});

import {uiProgramContract,uiJsxExpressions,uiImperativeContract} from '../scripts/ui-audit-logic-contract.mjs';
const originalPrograms=JSON.parse(read('tests/fixtures/ui-audit-logic-contract.json'));
// Historical program hashes stay pinned. Reverse only these exact reviewed CSS imports.
function reviewedProgramSource(source,file){
 source=reverseAtlasHandoffDeadline(reverseFinancePrecision(reverseTrainingReadGeneration(source,file),file),file);
 if(file==='app/team/people/provider-training/page.tsx'){
  const {replacements}=JSON.parse(read('tests/fixtures/ui-provider-training-next-preservation.json'));
  for(const [before,after] of [...replacements].reverse()){assert.equal(source.split(after).length,2,'Exactly one Provider Training presentation hook');source=source.replace(after,before);}
  return source;
 }
 const imports={
  'app/team/finance/finance-ledger.tsx':'\nimport styles from "./finance-content.module.css";',
  'app/team/finance/boarding/boarding-finance-workspace.tsx':'\nimport styles from "./boarding-content.module.css";',
  'app/team/finance/training/page.tsx':'\nimport styles from "./training-content.module.css";',
 };
 const exact=imports[file];
 if(!exact)return source;
 assert.equal(source.split(exact).length,2,'Exactly one reviewed stylesheet import');
 return source.replace(exact,'');
}
for(const [file,expected] of Object.entries(originalPrograms.files)) {
 test(`UI audit preserves original state, calculations and request functions: ${file}`,()=>{
  assert.equal(uiProgramContract(reviewedProgramSource(read(file),file),file),expected);
 });
}
test('reviewed Finance stylesheet reversals retain calculation and booking-authority detection',()=>{
 for(const [file,before,after] of [
  ['app/team/finance/finance-ledger.tsx','maximumFractionDigits: 2','maximumFractionDigits: 0'],
  ['app/team/finance/boarding/boarding-finance-workspace.tsx','await loadBoardingFinance(id)','await loadBoardingFinance(bookingId)'],
 ]){
  const source=read(file),changed=source.replace(before,after);assert.notEqual(source,changed);
  assert.notEqual(uiProgramContract(reviewedProgramSource(changed,file),file),originalPrograms.files[file]);
 }
});
test('imperative guard rejects a changed employee request rather than approving new behavior',()=>{
 const file='app/me/page.tsx',source=read(file);
 const changed=source.replace('action:"apply_leave"','action:"approve_leave"');
 assert.notEqual(changed,source);
 assert.notEqual(uiImperativeContract(changed,file),uiImperativeContract(source,file));
});
test('event guard rejects a removed busy guard and a redirected request',()=>{
 const file='app/team/ai/atlas-chat.tsx',source=read(file);
 for(const [before,after] of [['disabled={busy||loading||!question.trim()}','disabled={false}'],['/api/admin/atlas-chat','/api/wrong-atlas']]) {
  const changed=source.replace(before,after);assert.notEqual(changed,source);
  assert.notDeepEqual(uiBehaviorSignatures(changed,file),uiBehaviorSignatures(source,file));
 }
});

test('appearance placement cannot introduce network calls or identity storage',()=>{
 const source=read('app/components/pawspace-appearance.tsx');
 assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie/);
 const allowed=new Set(['THEME_STORAGE_KEY','APPEARANCE_STORAGE_KEY','STYLE_STORAGE_KEY']);
 for(const match of source.matchAll(/localStorage\.setItem\(([^,]+),/g))assert.ok(allowed.has(match[1].trim()),match[1]);
});

// Execute the actual new presentation component as well as preserving source contracts.
import 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__UI_AUDIT_RENDER_DB__');
const {default:ReadableText}=await import('../app/components/ui/ReadableText.tsx');
const renderText=text=>renderToStaticMarkup(createElement(ReadableText,{text}));

test('Atlas rendering executes paragraphs, emphasis and inline references',()=>{
 const html=renderText('First paragraph\r\n\r\n**Review required**: use `PS-123` for ₹1,349.');
 assert.equal(html,'<div class="paw-readable-text"><p>First paragraph</p><p><strong>Review required</strong>: use <code>PS-123</code> for ₹1,349.</p></div>');
});
test('Atlas rendering preserves heading content and ordered-list starting numbers',()=>{
 const html=renderText('# Review summary\n- First item\n+ Second **item**\n\n3. Third step\n4. Fourth step');
 assert.equal(html,'<div class="paw-readable-text"><h3>Review summary</h3><ul><li>First item</li><li>Second <strong>item</strong></li></ul><ol start="3"><li value="3">Third step</li><li value="4">Fourth step</li></ol></div>');
});
test('Atlas rendering never turns supplied markup or links into active controls',()=>{
 const html=renderText('<button type="submit">Confirm & pay</button>\n[Reference](https://example.invalid)');
 assert.match(html,/<button type="submit">Confirm & pay<\/button>/);
 assert.match(html,/\[Reference\]\(https:\/\/example\.invalid\)/);
 assert.doesNotMatch(html,/<button|<a\s/);
});
test('Atlas rendering keeps fenced examples literal and handles an unfinished fence',()=>{
 const html=renderText('```text\n<strong>literal</strong>\n**not emphasis**\n```\nAfter the example');
 assert.equal(html,'<div class="paw-readable-text"><pre><code><strong>literal</strong>\n**not emphasis**</code></pre><p>After the example</p></div>');
 assert.equal(renderText('```\nunfinished'),'<div class="paw-readable-text"><pre><code>unfinished</code></pre></div>');
});
test('Atlas rendering keeps unclosed inline markers and empty responses safe',()=>{
 assert.equal(renderText('**unclosed\n`reference'),'<div class="paw-readable-text"><p>**unclosed</p><p>`reference</p></div>');
 assert.equal(renderText(' \r\n\r\n'),'<div class="paw-readable-text"></div>');
});
test('Atlas rendering keeps repeated records without truncating long replies',()=>{
 const text=Array.from({length:200},(_,i)=>`- Record ${i}: ₹${i+1}`).join('\n');
 const html=renderText(text);
 assert.equal((html.match(/<li>/g)||[]).length,200);
 assert.match(html,/<li>Record 0: ₹1<\/li>/);
 assert.match(html,/<li>Record 199: ₹200<\/li>/);
});

// Newly labelled Training scroll wrappers reverse exactly; original JSX expressions stay signed.
function reviewedTrainingJsxSource(source,file){
 source=reverseAtlasHandoffDeadline(source,file);
 if(file==='app/team/people/provider-training/page.tsx')return reviewedProgramSource(source,file);
 if(file!=='app/team/finance/training/page.tsx')return source;
 const {replacements}=JSON.parse(read('tests/fixtures/ui-training-finance-next-preservation.json'));
 for(const [before,after] of [...replacements].reverse()){
  assert.equal(source.split(after).length,2,'Exactly one reviewed Training display hook');
  source=source.replace(after,before);
 }
 return source;
}
for(const [file,original] of Object.entries(originalPrograms.jsxOriginal)) {
 test(`UI audit preserves JSX data expressions with explicit presentation deltas: ${file}`,()=>{
  const expected=[...original];
  for(const patch of [...(originalPrograms.jsxPresentationChanges[file]||[])].reverse()) {
   assert.deepEqual(expected.slice(patch.index,patch.index+patch.remove.length),patch.remove,'Review patch must match its historical expression range');
   expected.splice(patch.index,patch.remove.length,...patch.insert);
  }
  assert.deepEqual(uiJsxExpressions(reviewedTrainingJsxSource(read(file),file),file),expected);
 });
}
test('JSX protection covers every original imperative baseline',()=>{
 assert.deepEqual(Object.keys(originalPrograms.jsxOriginal).sort(),Object.keys(originalPrograms.files).sort());
});
test('JSX guard rejects unsigned custom-prop, child, nested and spread mutations',()=>{
 const variants=[
  ['<Card total={calculateAmount(row)}/>','calculateAmount','wrongAmount'],
  ['<p>{calculateAmount(row)}</p>','calculateAmount','wrongAmount'],
  ['<section>{rows.map(row=><Card total={calculateAmount(row)}/>)}</section>','calculateAmount','wrongAmount'],
  ['<Card {...invoiceProps}/>','invoiceProps','otherProps'],
  ['<Card fee={approved ? fee : 0}/>','approved','true'],
  ['<Card data-audit-total={calculateAmount(row)}/>','calculateAmount','wrongAmount'],
 ];
 for(const [jsx,from,to] of variants) {
  const before=`export default function View(){return ${jsx};}`,after=before.replace(from,to);
  assert.notEqual(uiImperativeContract(before),uiImperativeContract(after),jsx);
 }
});
test('control identities detect swapped handlers without rejecting visual wrappers',()=>{
 const before='export default function View(){return <><button onClick={()=>approve()}>Approve</button><button onClick={()=>reject()}>Reject</button></>;}' ;
 const swapped=before.replace('approve()','TEMP()').replace('reject()','approve()').replace('TEMP()','reject()');
 assert.notDeepEqual(uiBehaviorSignatures(before),uiBehaviorSignatures(swapped));
 assert.notEqual(uiImperativeContract(before),uiImperativeContract(swapped));
 const wrapped=before.replace('<>','<section className="panel">').replace('</>','</section>');
 assert.deepEqual(uiBehaviorSignatures(before),uiBehaviorSignatures(wrapped));
 assert.equal(uiImperativeContract(before),uiImperativeContract(wrapped));
});
test('control signatures preserve whitespace inside string arguments',()=>{
 const before='const view=<button onClick={()=>send("two  spaces")}>Send</button>;';
 assert.notDeepEqual(uiBehaviorSignatures(before),uiBehaviorSignatures(before.replace('two  spaces','two spaces')));
});
test('Atlas rendering preserves non-consecutive and repeated ordered-list numbers',()=>{
 const html=renderText('3. First\n5. Second\n5. Repeated\n1. Restart');
 assert.equal(html,'<div class="paw-readable-text"><ol start="3"><li value="3">First</li><li value="5">Second</li><li value="5">Repeated</li><li value="1">Restart</li></ol></div>');
});
test('Atlas rendering preserves lone markers and aligned text',()=>{
 for(const text of ['**','****','`','``','Customer    Net amount'])assert.equal(renderText(text),`<div class="paw-readable-text"><p>${text}</p></div>`);
 const css=postcss.parse(read('app/pawspace-design-system.css'));
 const rules=[];css.walkRules('.paw-readable-text',rule=>rule.walkDecls('white-space',decl=>rules.push(decl.value)));
 assert.equal(rules.at(-1),'pre-wrap');
});
test('audit server cannot silently reuse a stale local process',()=>{
 assert.match(read('playwright.ui-audit.config.ts'),/reuseExistingServer:false/);
});

import {resolveUiAuditServer} from '../scripts/ui-audit-server.mjs';
import {UI_AUDIT_BASE,verifyHistoricalUiContracts} from '../scripts/ui-audit-history.mjs';
const {TeamTable}=await import('../app/components/ui/TeamShell.tsx');
test('table landmarks describe their actual distinct columns without modifying data',()=>{
 const renderTable=head=>renderToStaticMarkup(createElement(TeamTable,{head,rows:[['A','B','C']]}));
 const first=renderTable(['Setting','State','Detail']),second=renderTable(['Policy check','Result','Detail']);
 assert.match(first,/aria-label="Table: Setting \/ State \/ Detail; scroll horizontally for all columns"/);
 assert.match(second,/aria-label="Table: Policy check \/ Result \/ Detail; scroll horizontally for all columns"/);
 assert.equal((first.match(/<td/g)||[]).length,3);
 assert.match(first,/tabindex="0"/);
});
test('audit browser and server use one resolved local port',()=>{
 assert.deepEqual(resolveUiAuditServer(),{port:'4197',baseURL:'http://127.0.0.1:4197'});
 assert.deepEqual(resolveUiAuditServer({PW_BASE_URL:'http://localhost:4318'}),{port:'4318',baseURL:'http://localhost:4318'});
 assert.deepEqual(resolveUiAuditServer({PW_PORT:'4318'}),{port:'4318',baseURL:'http://127.0.0.1:4318'});
 assert.equal(resolveUiAuditServer({PW_PORT:'4318',PW_BASE_URL:'http://localhost:4318/'}).port,'4318');
 assert.throws(()=>resolveUiAuditServer({PW_PORT:'4197',PW_BASE_URL:'http://localhost:4318'}),/must match/);
 for(const PW_BASE_URL of ['https://localhost:4197','http://example.invalid:4197','http://localhost:4197/path','http://localhost:4197/?x=1','http://u:p@localhost:4197','http://localhost:4197/#part'])assert.throws(()=>resolveUiAuditServer({PW_BASE_URL}),/loopback HTTP/);
 for(const PW_PORT of ['','0','65536','not-a-port','4197.5'])assert.throws(()=>resolveUiAuditServer({PW_PORT}),/port must/);
});
test('literal and uncontrolled field changes cannot bypass either UI guard',()=>{
 for(const [before,after] of [
  ['placeholder="Old"','placeholder="Other"'],['defaultValue="A"','defaultValue="B"'],
  ['defaultChecked','defaultChecked={false}'],['readOnly','readOnly={false}'],
  ['pattern="[0-9]+"','pattern=".*"'],['disabled','disabled={false}'],
  ['type="submit"','type="button"'],['formAction="/safe"','formAction="/other"'],
 ]) {
  const a=`const view=<input ${before}/>;`,b=`const view=<input ${after}/>;`;
  assert.notDeepEqual(uiBehaviorSignatures(a),uiBehaviorSignatures(b),before);
  assert.notEqual(uiImperativeContract(a),uiImperativeContract(b),before);
 }
 assert.notEqual(uiImperativeContract('const v=<Card total="10"/>;'),uiImperativeContract('const v=<Card total="99"/>;'));
});
test('qualified fetch requests retain their target and body in the event contract',()=>{
 for(const target of ['fetch','window.fetch','globalThis.fetch','self.fetch','window["fetch"]','globalThis["fetch"]']) {
  const a=`const load=()=>${target}("/api/first",{method:"POST",body:"original"});`;
  assert.equal(uiBehaviorSignatures(a).filter(s=>s.startsWith('fetch:')).length,1,target);
  assert.notDeepEqual(uiBehaviorSignatures(a),uiBehaviorSignatures(a.replace('/api/first','/api/second')),target);
  assert.notDeepEqual(uiBehaviorSignatures(a),uiBehaviorSignatures(a.replace('original','different')),target);
 }
 assert.notDeepEqual(uiBehaviorSignatures('fetch("/api/x")'),uiBehaviorSignatures('window.fetch("/api/x")'));
});
test('historical verification rejects a rebased or self-approved fixture',()=>{
 const file='app/example.tsx',source='export default function View(){return <button disabled onClick={()=>save()}>Save</button>;}';
 const events={base:UI_AUDIT_BASE,files:{[file]:uiBehaviorSignatures(source,file)}};
 const programs={base:UI_AUDIT_BASE,files:{[file]:uiProgramContract(source,file)},jsxOriginal:{[file]:uiJsxExpressions(source,file)}};
 const historical=(base,path)=>{assert.equal(base,UI_AUDIT_BASE);assert.equal(path,file);return source;};
 assert.equal(verifyHistoricalUiContracts(events,programs,historical),1);
 assert.throws(()=>verifyHistoricalUiContracts({...events,base:'main'},programs,historical),/pinned audit revision/);
 const changed=source.replace('save()','otherAction()');
 const updatedEvents={...events,files:{[file]:uiBehaviorSignatures(changed,file)}};
 assert.throws(()=>verifyHistoricalUiContracts(updatedEvents,programs,historical),/historical events/);
 const updatedPrograms={...programs,jsxOriginal:{[file]:uiJsxExpressions(changed,file)}};
 assert.throws(()=>verifyHistoricalUiContracts(events,updatedPrograms,historical),/historical JSX/);
 assert.throws(()=>verifyHistoricalUiContracts(events,programs,()=>{throw new Error('Historical source unavailable');}),/Historical source unavailable/);
});
test('hosted audit fetches and verifies the pinned history before current-source checks',()=>{
 const workflow=read('.github/workflows/ui-audit-closure.yml');
 assert.ok(workflow.includes(`git fetch --no-tags --depth=1 origin ${UI_AUDIT_BASE}`));
 assert.ok(workflow.indexOf('node scripts/ui-audit-history.mjs')<workflow.indexOf('node --test tests/ui-audit-closure.test.mjs'));
 assert.doesNotMatch(workflow,/continue-on-error/);
});

import ts from 'typescript';
test('existing multi-table screens have distinct header-derived region names',()=>{
 for(const file of ['app/team/revenue-mission/page.tsx','app/team/voice/ai-test/page.tsx','app/team/voice/page.tsx','app/team/ai/analytics/page.tsx']) {
  const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),names=[];
  function visit(node) {
   if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(tree)==='TeamTable') {
    const head=node.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(tree)==='head');
    assert.ok(head&&ts.isJsxExpression(head.initializer)&&ts.isArrayLiteralExpression(head.initializer.expression),file+' table header must have a reviewed accessible name');
    const labels=head.initializer.expression.elements.map(item=>{assert.ok(ts.isStringLiteral(item),file);return item.text;});
    names.push(labels.join(' / '));
   }
   ts.forEachChild(node,visit);
  }
  visit(tree);assert.ok(names.length>0,file);assert.equal(new Set(names).size,names.length,file+' duplicate table purpose');
 }
});
