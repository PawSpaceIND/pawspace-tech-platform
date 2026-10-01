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
test('only the reviewed radius declarations changed',()=>{
 const css=read('app/components/staff-workspace/staff-console.module.css').replace('--ds-radius-full:var(--paw-control-radius); --ds-radius-lg:var(--paw-card-radius);','--ds-radius-full:10px; --ds-radius-lg:16px;');
 assert.equal(createHash('sha256').update(css).digest('hex'),'d0209881dcebdb02e62d0d631177684e08c5d06f8b899dabe17c6c3fb3a054e3');
});
