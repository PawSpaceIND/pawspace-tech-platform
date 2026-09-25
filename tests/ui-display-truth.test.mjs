import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {snapshotMetric,controlSignalLabel,currentNavigationSnapshot} from '../app/components/staff-workspace/display-state.ts';
const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root));
const contract=JSON.parse(read('tests/fixtures/ui-display-truth-contract.json'));
const hash=v=>createHash('sha256').update(v).digest('hex');
test('All other existing application sources and business engines remain unchanged',()=>{
 for(const[p,h]of Object.entries(contract.protected))assert.equal(hash(read(p)),h,p);
});
for(const value of [0,27,'INR 0','INR 1250'])test('Snapshot value stays unavailable on loading/failure: '+value,()=>{
 assert.equal(snapshotMetric(value,true,''),'\u2014');assert.equal(snapshotMetric(value,false,'Denied'),'\u2014');
 assert.equal(snapshotMetric(value,false,''),value);
});
test('Missing and invalid snapshot numbers never masquerade as zero',()=>{
 for(const v of [null,undefined,NaN,Infinity])assert.equal(snapshotMetric(v,false,''),'\u2014');
 assert.equal(snapshotMetric(0,false,''),0);
});
test('Control signal descriptions retain attention, critical and unknown states',()=>{
 assert.equal(controlSignalLabel('critical'),'Action required');assert.equal(controlSignalLabel('attention'),'Needs attention');
 assert.equal(controlSignalLabel('clear'),'Clear');for(const v of [null,undefined,'other',''])assert.equal(controlSignalLabel(v),'Status unavailable');
});
test('Menu actor cannot cross a pathname or retry boundary',()=>{
 const snapshot={pathname:'/control',attempt:0,actor:{permissions:['*']},error:'',signInUrl:'',status:200};
 assert.equal(currentNavigationSnapshot(snapshot,'/control',0),snapshot);
 assert.equal(currentNavigationSnapshot(snapshot,'/me',0),null);assert.equal(currentNavigationSnapshot(snapshot,'/control',1),null);
 assert.equal(currentNavigationSnapshot(null,'/control',0),null);
});

function originalSource(path){const entry=contract.corrections[path],current=read(path).toString();assert.equal(hash(current),entry.afterHash,path);
 if(entry.append){assert.ok(current.endsWith(entry.append));const before=current.slice(0,-entry.append.length);assert.equal(hash(before),entry.beforeHash);return before;}
 let before=current;for(const[a,b]of [...entry.changes].reverse()){assert.equal(before.split(b).length,2,path);before=before.replace(b,a);}
 assert.equal(hash(before),entry.beforeHash,path);return before;
}
for(const path of Object.keys(contract.corrections))test('Only the reviewed UI correction is present: '+path,()=>originalSource(path));
import ts from 'typescript';
function businessBindings(source){const tree=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),bindings=[];
 function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='fetch')bindings.push(node.getText(tree));
  if(ts.isJsxAttribute(node)&&/^(on[A-Z]|disabled$|value$|checked$)/.test(node.name.getText(tree)))bindings.push(node.getText(tree));
  ts.forEachChild(node,visit);
 }visit(tree);return bindings.sort();
}
for(const path of ['app/control/page.tsx','app/booking-command-center/page.tsx','app/components/staff-workspace/StaffWorkspace.tsx'])test('Existing requests and UI actions retain their bindings: '+path,()=>{
 assert.deepEqual(businessBindings(read(path).toString()),businessBindings(originalSource(path)));
});
test('Existing snapshot tests inspect the actual reviewed source rather than a substitute',()=>{
 for(const file of ['customer-partner-theme-contract.json','partner-services-presentation-contract.json']){
  const snapshot=JSON.parse(read('tests/fixtures/'+file));for(const[path,entry]of Object.entries(contract.corrections))assert.equal(snapshot.protected[path],entry.afterHash,path);
 }
});
