import {registerHooks} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-provider-training-next-preservation.json',import.meta.url),'utf8'));
test('Provider Training preserves every original business byte after exact presentation reversal',()=>{
 let source=readFileSync(new URL('../'+receipt.file,import.meta.url),'utf8');
 for(const [before,after] of [...receipt.replacements].reverse()){
 assert.equal(source.split(after).length,2,'Exactly one reviewed scoped hook/landmark');source=source.replace(after,before);
 }
 assert.equal(createHash('sha256').update(source).digest('hex'),receipt.beforeHash);
});
installWorkersHooks('__PROVIDER_TRAINING_NEXT_TEST__');
registerHooks({resolve(specifier,context,next){if(specifier==='../../../components/ui'&&context.parentURL?.includes('/people/provider-training/page.tsx'))return {url:new URL('../../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};return next(specifier,context);}});
const {default:Page}=await import('../app/team/people/provider-training/page.tsx');
test('actual provider authoring form has persistent associated labels without changing defaults',()=>{
 const html=renderToStaticMarkup(h(Page));
 for(const name of ['Title','Service','Summary','Content sections (one per line)','Quiz question','Quiz options (separate with |; first index is 0)'])assert.ok(html.includes('<span>'+name+'</span>'));
 assert.equal((html.match(/class="field"/g)||[]).length,6);
 assert.match(html,/<option value="all" selected="">All<\/option>/);
 assert.ok(html.includes('value="80"'));assert.ok(html.includes('Save draft'));assert.ok(html.includes('href="/team/people"'));
});
