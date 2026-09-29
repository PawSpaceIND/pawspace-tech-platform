import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {uiBehaviorSignatures} from '../scripts/ui-audit-event-contract.mjs';
installWorkersHooks('__PAYOUT_FEEDBACK_UI_DB__');
const {default:PayoutActionFeedback}=await import('../app/components/ui/PayoutActionFeedback.tsx');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const baseline=JSON.parse(read('tests/fixtures/payout-feedback-source-contract.json'));
function removeReviewedWrapper(source){
 for(const addition of ['import PayoutActionFeedback from "../../../components/ui/PayoutActionFeedback";\n','<PayoutActionFeedback notice={notice}>','</PayoutActionFeedback>']){
  assert.equal(source.split(addition).length,2,'Exactly one reviewed wrapper/import is allowed');
  source=source.replace(addition,'');
 }
 return source;
}
for(const[p,before]of Object.entries(baseline.files))test('Payout feedback changes only its reviewed wrapper; original handlers and money rules remain: '+p,()=>{
 const source=read(p),original=removeReviewedWrapper(source);
 assert.equal(hash(original),before.sha256);
 assert.deepEqual(uiBehaviorSignatures(source,p),uiBehaviorSignatures(original,p));
});
test('New feedback remains keyboard-focusable and preserves alert text safely',()=>{
 const html=renderToStaticMarkup(createElement(PayoutActionFeedback,{notice:'Review'},createElement('p',{role:'alert'},'<Pay again?>')));
 assert.match(html,/tabindex="-1"/);assert.match(html,/role="group"/);assert.match(html,/aria-label="Payout action outcome"/);
 assert.match(html,/<p role="alert">&lt;Pay again\?&gt;<\/p>/);
});
test('Payout feedback has no network, storage, payout authority or scheduled work',()=>{
 const source=read('app/components/ui/PayoutActionFeedback.tsx');
 assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|document\.cookie|setTimeout|setInterval|dangerouslySetInnerHTML/);
 assert.match(source,/if\(!notice\|\|!feedback\.current\)return/);
 assert.match(source,/focus\(\{preventScroll:true\}\)/);
 assert.match(source,/scrollIntoView\(\{block:"center",inline:"nearest",behavior:"instant"\}\)/);
});
test('Original-byte proof still catches a changed payout endpoint or disabled safeguard',()=>{
 const p='app/team/finance/partners/page.tsx',source=read(p);
 for(const[from,to]of [['/api/razorpayx-test-dispatch','/api/unsafe-dispatch'],['JSON.stringify({payoutId})','JSON.stringify({payoutId:"other"})'],['disabled={Boolean(busy)}','disabled={false}']]){
  assert.ok(source.includes(from));assert.notEqual(hash(removeReviewedWrapper(source.replace(from,to))),baseline.files[p].sha256);
 }
});
test('Viewport regressions are included in the zero-retry isolated UI workflow',()=>{
 assert.match(read('playwright.ui-audit.config.ts'),/testMatch:\["ui-audit-closure.spec.ts","ui-audit-finance-feedback.spec.ts"\]/);
 assert.match(read('playwright.ui-audit.config.ts'),/retries:0/);
 const suite=read('e2e/ui-audit-finance-feedback.spec.ts');
 assert.match(suite,/toBeFocused\(\)/);assert.match(suite,/r\.top>=0&&r\.bottom<=innerHeight/);
 assert.doesNotMatch(suite,/scrollIntoViewIfNeeded|\.focus\(|waitForTimeout|test\.skip|test\.only/);
});
