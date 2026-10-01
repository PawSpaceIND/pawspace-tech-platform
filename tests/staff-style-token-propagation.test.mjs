import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('staff cards and controls consume the selected global style radii',()=>{
 const css=read('app/components/staff-workspace/staff-console.module.css');
 assert.ok(css.includes('--ds-radius-full:var(--paw-control-radius); --ds-radius-lg:var(--paw-card-radius);'));
 const tokens=read('app/pawspace-design-system.css');
 assert.match(tokens,/--paw-card-radius:16px; --paw-control-radius:12px/);
 assert.match(tokens,/html\[data-paw-style="cartoon"\] \{--paw-card-radius:24px;--paw-control-radius:18px/);
 const consumers=read('app/components/ui/ui.module.css');
 assert.match(consumers,/border-radius: var\(--ds-radius-lg\)/);
 assert.match(consumers,/border-radius: var\(--ds-radius-full\)/);
});
test('only the reviewed radii and scoped label colour changed',()=>{
 const css=read('app/components/staff-workspace/staff-console.module.css').replace('--ds-radius-full:var(--paw-control-radius); --ds-radius-lg:var(--paw-card-radius);','--ds-radius-full:10px; --ds-radius-lg:16px;')
  .replace('\n/* A section label is content text, including on dark staff surfaces. */\n.console :global(.eyebrow) { color:var(--staff-text); }\n','');
 assert.equal(createHash('sha256').update(css).digest('hex'),'d0209881dcebdb02e62d0d631177684e08c5d06f8b899dabe17c6c3fb3a054e3');
});
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAFF_STYLE_RENDER__');
const {default:StaffModule}=await import('../app/components/staff-workspace/StaffModule.tsx');
const {default:Card}=await import('../app/components/ui/Card.tsx');
const {default:Button}=await import('../app/components/ui/Button.tsx');
test('actual staff presentation retains shared cards and native disabled controls within its scope',()=>{
 const html=renderToStaticMarkup(createElement(StaffModule,null,createElement(Card,null,createElement(Button,{disabled:true},'Fixture action'))));
 assert.match(html,/data-staff-module="true"/);
 assert.match(html,/class="card cardPadded"/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>Fixture action<\/button>/);
});
