import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import postcss from 'postcss';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__PARTNER_ENTRY_REDESIGN__');
const {default:PartnerEntry}=await import('../app/partner/page.tsx');
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
test('actual partner entry retains all existing destinations and readiness statements',()=>{
 assert.equal(hash(read('app/partner/page.tsx')),'b7dbbea6c64d31ae86eaa284ab4865afc6aff6a0be86340ed827a09e7db3b375');
 const html=renderToStaticMarkup(createElement(PartnerEntry));
 assert.equal((html.match(/href="\/partner\/jobs"/g)||[]).length,2);
 assert.match(html,/href="\/partner\/onboarding"/);assert.match(html,/href="\/partner-app"/);
 assert.match(html,/PRODUCTION READY = FALSE/);assert.match(html,/Live money: No/);
});
test('presentation append preserves prior styling and permits no hiding, placement or external resource changes',()=>{
 const css=read('app/partner/partner-hub.module.css'),marker='\n/* Partner entry: clear primary actions';
 const offset=css.indexOf(marker);assert.ok(offset>0);
 assert.equal(hash(css.slice(0,offset)), '1bfa1058b7245ec6a2e2ec0d6292b456fc567c826b3d2e3cd0f694e13a089794');
 const tree=postcss.parse(css.slice(offset));
 tree.walkRules(rule=>assert.ok(rule.selector.includes('.hub')));
 tree.walkAtRules(rule=>assert.equal(rule.name,'media'));
 tree.walkDecls(d=>{
  assert.ok(!['position','visibility','opacity','z-index','pointer-events'].includes(d.prop));
  assert.ok(!(d.prop==='display'&&d.value==='none'));
  assert.doesNotMatch(d.value,/https?:|javascript:|expression\(/);
 });
 assert.match(css.slice(offset),/min-height:48px/);assert.match(css.slice(offset),/focus-visible/);
 assert.match(css.slice(offset),/--brand-on-gold/);assert.match(css.slice(offset),/max-width:767px/);
});
