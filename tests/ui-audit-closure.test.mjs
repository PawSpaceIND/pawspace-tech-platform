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

// Execute the actual new presentation component as well as preserving source contracts.
import 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__UI_AUDIT_RENDER_DB__');
const {default:ReadableText}=await import('../app/components/ui/ReadableText.tsx');
const renderText=text=>renderToStaticMarkup(createElement(ReadableText,{text}));

test('Atlas rendering executes paragraphs, emphasis and inline references',()=>{
 const html=renderText('First paragraph\r\n\r\n**Review required**: use `PS-123` for ₹1,349.');
 assert.equal(html,'<div class="paw-readable-text"><p>First paragraph</p><p><strong>Review required</strong>: use <code>PS-123</code> for ₹1,349.</p></div>');
});
test('Atlas rendering preserves heading content and ordered-list starting numbers',()=>{
 const html=renderText('# Review summary\n- First item\n+ Second **item**\n\n3. Third step\n4. Fourth step');
 assert.equal(html,'<div class="paw-readable-text"><h3>Review summary</h3><ul><li>First item</li><li>Second <strong>item</strong></li></ul><ol start="3"><li>Third step</li><li>Fourth step</li></ol></div>');
});
test('Atlas rendering never turns supplied markup or links into active controls',()=>{
 const html=renderText('<button type="submit">Confirm & pay</button>\n[Reference](https://example.invalid)');
 assert.match(html,/&lt;button type=&quot;submit&quot;&gt;Confirm &amp; pay&lt;\/button&gt;/);
 assert.match(html,/\[Reference\]\(https:\/\/example\.invalid\)/);
 assert.doesNotMatch(html,/<button|<a\s/);
});
test('Atlas rendering keeps fenced examples literal and handles an unfinished fence',()=>{
 const html=renderText('```text\n<strong>literal</strong>\n**not emphasis**\n```\nAfter the example');
 assert.equal(html,'<div class="paw-readable-text"><pre><code>&lt;strong&gt;literal&lt;/strong&gt;\n**not emphasis**</code></pre><p>After the example</p></div>');
 assert.equal(renderText('```\nunfinished'),'<div class="paw-readable-text"><pre><code>unfinished</code></pre></div>');
});
test('Atlas rendering keeps unclosed inline markers and empty responses safe',()=>{
 assert.equal(renderText('**unclosed\n`reference'),'<div class="paw-readable-text"><p>**unclosed</p><p>`reference</p></div>');
 assert.equal(renderText(' \r\n\r\n'),'<div class="paw-readable-text"></div>');
});
test('Atlas rendering keeps repeated records without truncating long replies',()=>{
 const text=Array.from({length:200},(_,i)=>`- Record ${i}: ₹${i+1}`).join('\n');
 const html=renderText(text);
 assert.equal((html.match(/<li>/g)||[]).length,200);
 assert.match(html,/<li>Record 0: ₹1<\/li>/);
 assert.match(html,/<li>Record 199: ₹200<\/li>/);
});
