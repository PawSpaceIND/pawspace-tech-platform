import {reverseTrainingReadGeneration} from './helpers/training-finance-read-generation-review.mjs';
import {reverseFinancePrecision} from './helpers/ui-finance-precision-review.mjs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-training-finance-next-preservation.json',import.meta.url),'utf8'));
test('Training Finance preserves every original business byte after exact presentation reversal',()=>{
 let source=reverseFinancePrecision(reverseTrainingReadGeneration(readFileSync(new URL('../'+receipt.file,import.meta.url),'utf8'),receipt.file),receipt.file);
 for(const [before,after] of [...receipt.replacements].reverse()){
 assert.equal(source.split(after).length,2,'Exactly one reviewed scoped hook/landmark');source=source.replace(after,before);
 }
 assert.equal(createHash('sha256').update(source).digest('hex'),receipt.beforeHash);
});
installWorkersHooks('__TRAINING_FINANCE_NEXT_TEST__');
registerHooks({resolve(specifier,context,next){if(specifier==='../../../components/ui'&&context.parentURL?.includes('/finance/training/page.tsx'))return {url:new URL('../../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};return next(specifier,context);}});
const {default:Training}=await import('../app/team/finance/training/page.tsx');
test('actual Training Finance keeps all three reports and gives each a distinct keyboard landmark',()=>{
 const html=renderToStaticMarkup(h(Training));
 assert.match(html,/class="training"/);assert.equal((html.match(/class="trainingTable"/g)||[]).length,3);
 assert.equal((html.match(/tabindex="0"/g)||[]).length,3);
 for(const name of ['Training invoices','Training cancellation and refund cases','Trainer payout statements'])assert.ok(html.includes(`aria-label="${name}; scroll horizontally for all columns"`));
 for(const text of ['Publish trainer rate','Configure tax policy','Configure cancellation policy','No live payout/refund execution','href="/team/finance"'])assert.ok(html.includes(text));
 assert.equal((html.match(/<table /g)||[]).length,3);
});
