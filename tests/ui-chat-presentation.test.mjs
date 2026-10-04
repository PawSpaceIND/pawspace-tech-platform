import {preservedAcceptedUiBytes} from './helpers/accepted-ui-reviewed-delta.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
const originalCssHash='b5d3692dca2db5b556538d6af13afb54bd2191c17d7e18763ecd4afdb365ce17';
const marker='\n/* UI-24/25/26: only the V2 chat page;';
// Exact reviewed sources: callback notice retention updates V2 chat; the other chat sources remain unchanged.
for(const [path,expected] of Object.entries({
 'app/v2/chat/page.tsx':'bbb1e902b59edf8e4ec5f93836a6165e4b73535ec170fcdf531281432e9bd594',
 'app/components/wati-chat/WatiConversation.tsx':'94a2cbcb18b9251502c417935085d8a8b5383555a6ceb69b1fab45814662e2f8',
 'app/components/wati-chat/wati-chat.module.css':'e7dd395378a4c42fac84c170a72358ddcb8968eb93037c3f7465ff5372670e07',
 // Reviewed Grooming-only mobile utility append; chat sources and assertions remain unchanged.
 'app/v2/presentation.module.css':'3a201fab2e8db78e646277e899222fec8528e441f529e8ae3babbc75fafed5ef',
}))test(`Chat visual repair preserves original source: ${path}`,()=>assert.equal(hash(preservedAcceptedUiBytes(path,read(path))),expected));
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

// Exercise the actual component as well as its immutable-source guards. CSS remains
// browser-tested; server rendering here proves the component's display contracts.
import 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__UI_CHAT_RENDER_CONTRACT__');
const {default:WatiConversation}=await import('../app/components/wati-chat/WatiConversation.tsx');
const chatProps={name:'PawSpace',presence:'PawSpace team',status:'Open',avatarSrc:'/assets/pawspace-icon.jpeg',messages:[],busy:false,draft:'',placeholder:'Type a question or pick a service',onDraft:()=>{},onSend:()=>{},onChoice:()=>{}};
const renderChat=overrides=>renderToStaticMarkup(createElement(WatiConversation,{...chatProps,...overrides}));
const textareaTag=html=>{const match=html.match(/<textarea\b[^>]*>/);assert.ok(match,'Actual component must render a textarea');return match[0];};
const sendTag=html=>{const match=html.match(/(<button\b[^>]*>)Send<\/button>/);assert.ok(match,'Actual component must render its Send control');return match[1];};
const disabled=tag=>/\sdisabled(?:=""|(?=\s|>))/.test(tag);

test('executed WATI renderer preserves composer and send states for busy, disabled and empty drafts',()=>{
 for(const busy of [false,true])for(const composerDisabled of [false,true])for(const draft of ['', ' \n ', 'Ready to send']){
  const html=renderChat({busy,composerDisabled,draft});
  const description=JSON.stringify({busy,composerDisabled,draft});
  assert.equal(disabled(textareaTag(html)),busy||composerDisabled,description);
  assert.equal(disabled(sendTag(html)),busy||composerDisabled||!draft.trim(),description);
 }
});

test('executed WATI renderer retains its labelled bounded field and escapes multiline draft text',()=>{
 const html=renderChat({draft:'Line one\n<untrusted> & line two'});
 assert.match(html,/<label\b[^>]*for="v2-chat-message"[^>]*>Your message<\/label>/);
 const input=textareaTag(html);assert.match(input,/id="v2-chat-message"/);assert.match(input,/maxLength="4000"/i);assert.match(input,/rows="1"/);
 assert.match(input,/placeholder="Type a question or pick a service"/);
 assert.match(html,/Line one\n&lt;untrusted&gt; &amp; line two/);assert.doesNotMatch(html,/<untrusted>/);
});

test('executed WATI renderer links only PawSpace booking references, never customer or external URLs',()=>{
 const booking='/v2/booking?bookingId=UI-BOOKING_1';
 const messages=[{id:'staff',side:'pawspace',author:'PawSpace team',text:`Pay securely: ${booking} https://example.invalid/external`},{id:'customer',side:'customer',text:booking}];
 const html=renderChat({messages});
 assert.deepEqual([...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(m=>({href:m[1],label:m[2]})),[{href:booking,label:'Pay now'}]);
 assert.match(html,/<p>\/v2\/booking\?bookingId=UI-BOOKING_1<\/p>/);
 assert.match(html,/https:\/\/example.invalid\/external/);
});

test('executed WATI renderer shows only latest choices and keeps them disabled during a reply',()=>{
 const messages=[{id:'old',side:'pawspace',text:'Earlier menu',choices:[{id:'old-choice',label:'Old choice'}]},{id:'new',side:'pawspace',text:'Latest menu',choices:[{id:'new-choice',label:'Current choice'}]}];
 for(const busy of [false,true]){
  const html=renderChat({messages,busy});
  assert.doesNotMatch(html,/Old choice/);assert.match(html,/role="group" aria-label="Choose an option"/);
  const choice=html.match(/(<button\b[^>]*>)<span>Current choice<\/span><\/button>/);assert.ok(choice);
  assert.equal(disabled(choice[1]),busy);
  assert.equal(html.includes('aria-label="PawSpace is typing"'),busy);
 }
 assert.doesNotMatch(renderChat({messages:[...messages,{id:'customer',side:'customer',text:'Chosen'}]}),/Current choice|Choose an option/);
});

test('executed WATI renderer exposes an escaped error without changing stored conversation text',()=>{
 const html=renderChat({error:'Temporary <failure>',messages:[{id:'one',side:'pawspace',text:'Saved <message> & details'}]});
 assert.match(html,/<p role="alert"[^>]*>Temporary &lt;failure&gt;<\/p>/);assert.match(html,/Saved &lt;message&gt; &amp; details/);
 assert.doesNotMatch(html,/<failure>|<message>/);
});
