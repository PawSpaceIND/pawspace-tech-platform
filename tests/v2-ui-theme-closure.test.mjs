import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import {uiWiringContract} from './helpers/ui-wiring-contract.mjs';
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const baseline = JSON.parse(read('tests/fixtures/v2-ui-wiring-contract.json'));
for (const [name, expected] of Object.entries(baseline.files)) {
 test('V2 UI preserves executable wiring: ' + name, () => assert.deepEqual(uiWiringContract(read(name), name), expected));
}
test('wiring contract detects changes to handlers and disabled guards', () => {
 const source = read('app/walking/page.tsx');
 const changedHandler = source.replace('onClick={()=>void finalizeBooking()}', 'onClick={()=>void otherBooking()}');
 assert.notEqual(changedHandler, source);
 assert.notDeepEqual(uiWiringContract(changedHandler), uiWiringContract(source));
 const changedGuard = source.replace('disabled={!quote||quoteLoading||', 'disabled={false||quoteLoading||');
 assert.notEqual(changedGuard, source);
 assert.notDeepEqual(uiWiringContract(changedGuard), uiWiringContract(source));
});
test('new layout is a V2 presentation wrapper, not a data or permission layer', () => {
 const source = read('app/v2/layout.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
 assert.match(source, /data-pawspace-v2="true"/);
 assert.match(source, /\{children\}/);
 assert.doesNotMatch(source, /fetch\(|useEffect|localStorage|cookie|identity|payment\(/i);
});
test('every document-wide utility override is conditional on the V2 route boundary', () => {
 const css = postcss.parse(read('app/v2/presentation.module.css'));
 css.walkRules(rule => {
  if (/\bbody\b/.test(rule.selector)) assert.ok(rule.selectors.every(s => s.includes(':has([data-pawspace-v2])')), rule.selector);
 });
 assert.match(read('app/v2/presentation.module.css'), /composes: palette from/);
});
test('sparse V2 booking states keep their content and shared navigation', () => {
 for (const path of ['booking/layout.tsx', 'booking-confirmation/layout.tsx', 'grooming/manage/layout.tsx']) {
  const source = read('app/v2/' + path);
  assert.match(source, /<V2ServiceBridgeShell>\{children\}<\/V2ServiceBridgeShell>/);
  assert.doesNotMatch(source, /fetch\(|useState|useEffect/);
 }
});
test('sandbox and no-auto-charge notices survive customer-copy changes', () => {
 assert.match(read('app/food/canonical-food-page.tsx'), /explicit test catalogue\/inventory values only/);
 assert.match(read('app/taxi/canonical-taxi-page.tsx'), /synthetic UAT route class/);
 assert.match(read('app/training/page.tsx'), /DOG TRAINING · CANONICAL UAT/);
 assert.match(read('app/food/subscriptions/page.tsx'), /silently change price/);
});
