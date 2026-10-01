import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const base='267db2d279d59094513f4d92fb7214cb5c0efca3';
const changes=[
 ['app/host/proof/page.tsx','<button disabled={!!busy} onClick={()=>void refreshApproval()}>Refresh photo approval','<button style={{minHeight:44}} disabled={!!busy} onClick={()=>void refreshApproval()}>Refresh photo approval'],
 ['app/sitter/proof/page.tsx','<button disabled={!!busy} onClick={()=>void refreshApproval()}>Refresh photo approval','<button style={{minHeight:44}} disabled={!!busy} onClick={()=>void refreshApproval()}>Refresh photo approval'],
 ...['boarding','sitting'].map(service=>[`app/team/operations/${service}/page.tsx`,'<button disabled={!!busy||!incident.id||','<button style={{minHeight:44}} disabled={!!busy||!incident.id||']),
];
for(const [file,old,next] of changes)test(`${file}: scoped 44px control and all other source preserved`,()=>{
 const source=readFileSync(file,'utf8');assert.equal(source.split(next).length,2);
 assert.equal(source.replace(next,old),execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}));
});
const file='app/trainer/trainer.module.css';
const appended='\n/* Keep the session columns within the available workspace width. */\n.actions button{min-height:44px}\n@media(max-width:1100px){.layout{grid-template-columns:minmax(0,1fr)}.schedule,.session{min-width:0}}\n';
test('Trainer: bounded grid breakpoint and 44px actions, prior CSS preserved',()=>{
 const source=readFileSync(file,'utf8');assert.ok(source.endsWith(appended));
 assert.equal(source.slice(0,-appended.length),execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}));
 assert.ok(1100>=225+56+320+480+13);
});
test('Trainer handlers and shared CSS remain byte-identical',()=>{
 for(const file of ['app/trainer/page.tsx','app/trainer/trainer-extra.module.css'])assert.equal(readFileSync(file,'utf8'),execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'}));
});
