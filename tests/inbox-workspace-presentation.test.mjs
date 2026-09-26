import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';import ts from 'typescript';
import {installWorkersHooks} from './helpers/module-hooks.mjs';import {staffSemanticContract} from './helpers/staff-presentation-contract.mjs';
installWorkersHooks('__INBOX_UI_DB__','__INBOX_UI_ENV__');
const {visibleStaffGroups}=await import('../app/components/staff-workspace/navigation.ts');
const c=JSON.parse(fs.readFileSync('tests/fixtures/inbox-workspace-contract.json','utf8')),hash=v=>createHash('sha256').update(v).digest('hex');
const read=p=>fs.readFileSync(p,'utf8');
test('Inbox changes preserve every other application source',()=>{for(const[p,h]of Object.entries(c.protected))assert.equal(hash(fs.readFileSync(p)),h,p);});
test('Inbox requests, state, polling, selection, idempotency and actions stay unchanged',()=>{
 const path='app/team/customer-experience/page.tsx',s=read(path),sf=ts.createSourceFile(path,s,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),fn=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='CustomerExperiencePage');
 const body=fn.body.statements.slice(0,fn.body.statements.findIndex(ts.isReturnStatement)).map(n=>n.getText(sf)).join('\n'),bindings=[];
 function visit(n){if(ts.isJsxAttribute(n)&&/^(on[A-Z]|disabled$|value$|checked$|name$)/.test(n.name.getText(sf)))bindings.push(n.getText(sf));ts.forEachChild(n,visit);}visit(sf);
 assert.equal(hash(body),c.targets[path].contract.logicHash);assert.deepEqual(bindings.sort(),c.targets[path].contract.bindings);
});
test('Exactly reviewed presentation edits remain and no stylesheet was replaced',()=>{for(const[p,x]of Object.entries(c.targets))assert.equal(hash(read(p)),x.after,p);assert.equal(Object.keys(c.targets).length,2);});
test('Four core inbox destinations use existing routes and keyboard-operable links',()=>{
 const s=read('app/team/customer-experience/page.tsx'),rail=s.slice(s.indexOf('<nav className={styles.nav}'),s.indexOf('</nav>',s.indexOf('<nav className={styles.nav}')));
 assert.equal((rail.match(/<Link /g)||[]).length,3);assert.match(rail,/<a href="#inbox-conversations"/);
 for(const path of ['/team/whatsapp/templates','/team/whatsapp/automation','/team/ai/handoff']){assert.ok(rail.includes('href="'+path+'"'));assert.ok(fs.existsSync('app'+path+'/page.tsx'));}
 assert.doesNotMatch(rail,/Booking Drafts|<div className=\{styles.navItem/);assert.match(s,/<strong>Conversation details<\/strong><span>Recorded fields<\/span>/);
 assert.match(s,/onClick=\{\(\) => \{ void controlAct\("set_mode", \{ mode: "chatbot_only", reason: routingReason \}\); \}\}>Chatbot only<\/Button>/);
});
test('Executed Inbox & AI menu matches the existing communications permission',()=>{
 const inbox=p=>visibleStaffGroups(p).flatMap(g=>g.links).find(l=>l.href==='/team/customer-experience');
 assert.equal(inbox(['customers.view']),undefined);assert.equal(inbox([]),undefined);assert.equal(inbox(['finance.view']),undefined);
 assert.equal(inbox(['communications.manage']).label,'Inbox & AI');assert.equal(inbox(['*']).permission,'communications.manage');
});
test('Integrated business sources retain upstream bytes and Atlas retains upstream behavior',()=>{
 const m=JSON.parse(read('tests/fixtures/ui-mainline-integration-contract.json'));
 for(const[p,h]of Object.entries(m.protected))assert.equal(hash(fs.readFileSync(p)),h,p);
 for(const[p,x]of Object.entries(m.presentation))assert.equal(staffSemanticContract(read(p),p),x.semantic,p);
});
