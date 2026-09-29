import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
const originalCssHash='b5d3692dca2db5b556538d6af13afb54bd2191c17d7e18763ecd4afdb365ce17';
const marker='\n/* UI-24/25/26: only the V2 chat page;';
// These are the exact unchanged sources from deployed 428fa899, not re-generated expectations.
for(const [path,expected] of Object.entries({
 'app/v2/chat/page.tsx':'60bf2ccadcfefed68858133c62220721ae50f104a7ba9fb10b7b7bca9ec990b1',
 'app/components/wati-chat/WatiConversation.tsx':'94a2cbcb18b9251502c417935085d8a8b5383555a6ceb69b1fab45814662e2f8',
 'app/components/wati-chat/wati-chat.module.css':'e7dd395378a4c42fac84c170a72358ddcb8968eb93037c3f7465ff5372670e07',
 'app/v2/presentation.module.css':'1dbf3855516d0899bf9a57e8b8f1a6be203df7778df537b8cc38ca54644e338c',
}))test(`Chat visual repair preserves original source: ${path}`,()=>assert.equal(hash(read(path)),expected));
test('chat CSS repair preserves the complete pre-repair stylesheet as an exact prefix',()=>{
 const css=read('app/v2/chat/page.module.css'),at=css.indexOf(marker);
 assert.ok(at>0);assert.equal(hash(css.slice(0,at)),originalCssHash);
});
test('chat additions are presentation-only and cannot hide document overflow or unrelated routes',()=>{
 const css=read('app/v2/chat/page.module.css');const sheet=postcss.parse(css.slice(css.indexOf(marker)));
 let count=0;sheet.walkRules(rule=>{count++;for(const selector of rule.selectors)assert.ok(selector.includes('.page'),selector);});
 assert.ok(count>=8);sheet.walkAtRules(rule=>assert.equal(rule.name,'media'));
 sheet.walkDecls(decl=>{assert.doesNotMatch(decl.value,/expression\(|javascript:|https?:\/\//i);if(/^overflow/.test(decl.prop))assert.doesNotMatch(decl.value,/hidden|clip/);if(decl.prop==='display')assert.notEqual(decl.value,'none');});
});
test('chat audit isolates the browser from shared deployment and never reuses a stale server',()=>{
 const source=read('playwright.ui-chat.config.ts');assert.match(source,/resolveUiChatServer/);assert.match(source,/reuseExistingServer:false/);assert.match(source,/retries:0/);assert.match(source,/PAWSPACE_PAYMENT_ENV:'sandbox'/);assert.match(source,/PAWSPACE_PAYMENT_LIVE_APPROVED:'false'/);
});

import {resolveUiChatServer} from '../scripts/ui-chat-server.mjs';
test('chat test server uses explicit unprivileged local ports and refuses portless origins',()=>{
 assert.deepEqual(resolveUiChatServer(),{port:'4209',baseURL:'http://127.0.0.1:4209'});
 assert.deepEqual(resolveUiChatServer({PW_BASE_URL:'http://localhost:4318/'}),{port:'4318',baseURL:'http://localhost:4318'});
 assert.deepEqual(resolveUiChatServer({PW_PORT:'4318'}),{port:'4318',baseURL:'http://127.0.0.1:4318'});
 for(const PW_BASE_URL of ['http://localhost/','http://127.0.0.1','http://localhost:80','http://localhost:1023'])assert.throws(()=>resolveUiChatServer({PW_BASE_URL}),/unprivileged port/);
 for(const PW_PORT of ['1','80','1023'])assert.throws(()=>resolveUiChatServer({PW_PORT}),/unprivileged port/);
 assert.equal(resolveUiChatServer({PW_PORT:'1024'}).port,'1024');assert.equal(resolveUiChatServer({PW_PORT:'65535'}).port,'65535');
 assert.throws(()=>resolveUiChatServer({PW_PORT:'4209',PW_BASE_URL:'http://localhost:4318'}),/must match/);
 for(const PW_BASE_URL of ['https://localhost:4209','http://example.invalid:4209','http://localhost:4209/path','http://u:p@localhost:4209'])assert.throws(()=>resolveUiChatServer({PW_BASE_URL}),/loopback HTTP/);
});
