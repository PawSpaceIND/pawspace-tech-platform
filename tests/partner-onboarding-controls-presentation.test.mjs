import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
const marker='\n/* Partner onboarding: presentation-only target and foreground consistency. */';
test('onboarding page preserves all handlers, network requests, permissions and submission bytes',()=>{
 assert.equal(hash(read('app/partner/onboarding/page.tsx')),'2054df9119f8ea50468d608a4402ce16db0f1e67fd447aa89eb941ca8345b690');
});
test('original stylesheet remains byte-identical before the bounded appendix',()=>{
 const css=read('app/partner/onboarding/onboarding.module.css');assert.equal(css.split(marker).length,2);assert.equal(hash(css.split(marker)[0]),'727181e7b6a79477eeb50781490775b08605831dcf2a103a592788da8c32290c');
});
test('appendix is confined to existing control and feedback classes without hiding or positioning controls',()=>{
 const css=postcss.parse(read('app/partner/onboarding/onboarding.module.css').split(marker)[1]);
 css.walkRules(r=>r.selectors.forEach(s=>assert.match(s,/^\.(backLink|btn|btnGhost|stepDone|errorBox|option|stepper|step|page)(?:\b|:)/)));
 css.walkDecls(d=>{if(d.prop==='position'){assert.equal(d.parent.selector,'.step b');assert.equal(d.value,'static');}else assert.doesNotMatch(d.prop,/^(visibility|opacity|z-index)$/);assert.notEqual(d.value,'none');assert.doesNotMatch(d.value,/url\(|expression\(/);});
});

import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__PARTNER_ONBOARDING_CONTROL_RENDER__');
const {default:PartnerOnboardingPage}=await import('../app/partner/onboarding/page.tsx');
test('actual onboarding page withholds application and qualification controls until session hydration',()=>{
 const html=renderToStaticMarkup(createElement(PartnerOnboardingPage));
 assert.match(html,/^<main\b/);
 assert.doesNotMatch(html,/<form|<input|<select|<button|Start application|Submit answers|Accept agreement/);
 assert.match(html,/<\/main>$/);
});
