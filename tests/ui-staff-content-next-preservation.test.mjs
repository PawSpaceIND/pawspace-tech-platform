import {registerHooks} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
const receipt=JSON.parse(readFileSync(new URL('./fixtures/ui-staff-content-next-preservation.json',import.meta.url),'utf8'));
for(const [file,{hash,replacements}] of Object.entries(receipt))test(`staff business source unchanged: ${file}`,()=>{
 let source=readFileSync(new URL('../'+file,import.meta.url),'utf8');
 for(const [before,after] of [...replacements].reverse())source=source.replaceAll(after,before);
 assert.equal(createHash('sha256').update(source).digest('hex'),hash);
});
installWorkersHooks('__STAFF_CONTENT_NEXT_RENDER__');
const {default:Operations}=await import('../app/team/operations/page.tsx');
test('actual Operations page retains five existing reachable workspace routes',()=>{
 const html=renderToStaticMarkup(createElement(Operations));
 assert.match(html,/queues/);assert.match(html,/queue/);
 for(const route of ['live-tracking','bookings','boarding','sitting','walking'])assert.ok(html.includes(`/team/operations/${route}`));
 assert.match(html,/Operations control/);assert.match(html,/production credentials remain disabled/);
});

// Resolve the actual UI barrel directory as the application bundler does; no component is stubbed.
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='../../components/ui' && context.parentURL?.includes('/app/team/people/page.tsx'))return {url:new URL('../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};
 return nextResolve(specifier,context);
}});
const {default:People}=await import('../app/team/people/page.tsx');
test('actual People page retains workspace destinations, labeled search and permission disclosure',()=>{
 const html=renderToStaticMarkup(createElement(People));
 assert.match(html,/People workspaces/);assert.match(html,/Find someone/);
 assert.match(html,/Loading the employee record/);assert.match(html,/Sensitive fields are masked/);
 for(const path of ['onboarding','offboarding','time','payroll','incentives','service-incentives','manager-dashboard','finance','reports'])assert.ok(html.includes(`/v2/team/people/${path}`));
 assert.ok(html.includes('/v2/team/performance'));
});
