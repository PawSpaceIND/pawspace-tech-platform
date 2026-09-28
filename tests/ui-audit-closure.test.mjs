import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import { uiBehaviorSignatures } from '../scripts/ui-audit-event-contract.mjs';
const read = file => readFileSync(new URL('../'+file,import.meta.url),'utf8');
const contract = JSON.parse(read('tests/fixtures/ui-audit-event-contract.json'));
for (const [file, expected] of Object.entries(contract.files)) {
  test(`UI audit preserves original events, requests and field contracts: ${file}`,()=>{
    assert.deepEqual(uiBehaviorSignatures(read(file),file),expected);
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
});
test('Atlas formatter treats content as text and retains the original response',()=>{
  const source=read('app/components/ui/ReadableText.tsx');
  assert.doesNotMatch(source,/dangerouslySetInnerHTML|innerHTML|eval\(|new Function|<iframe/);
  assert.match(read('app/team/ai/atlas-chat.tsx'),/<ReadableText text=\{item.content\}/);
  assert.match(read('app/team/ai/atlas-chat.tsx'),/<ReadableText text=\{answer.content\}/);
});

import {uiImperativeContract} from '../scripts/ui-audit-logic-contract.mjs';
const originalPrograms=JSON.parse(read('tests/fixtures/ui-audit-logic-contract.json'));
for(const [file,expected] of Object.entries(originalPrograms.files)) {
 test(`UI audit preserves original state, calculations and request functions: ${file}`,()=>{
  assert.equal(uiImperativeContract(read(file),file),expected);
 });
}
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
