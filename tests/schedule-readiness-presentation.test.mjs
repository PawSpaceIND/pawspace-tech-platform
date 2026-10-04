import {preservedAcceptedUiBytes} from './helpers/accepted-ui-reviewed-delta.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import ts from 'typescript';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const edits=JSON.parse(read('tests/helpers/schedule-readiness-edits.json'));
function reverse(path,source){for(const [before,after]of edits[path]){assert.ok(source.includes(after),after);source=source.replaceAll(after,before);}return source;}
test('Walking retains every handler, quote, request and default outside reviewed readiness props/copy',()=>{
 assert.equal(createHash('sha256').update(reverse('app/walking/page.tsx',read('app/walking/page.tsx'))).digest('hex'),'6e8b3160aed12b62bc445c4ea09e6a563bd5f7dc9a884811d1b158baad7d35e1');
 for(const [before,after]of [['setSlot(index)','setSlot(0)'],['accountLoading||quoteLoading','accountLoading'],['setStartDate(event.target.value)','setStartDate("2026-01-01")']]){
  const source=read('app/walking/page.tsx');assert.ok(source.includes(before));assert.throws(()=>assert.equal(createHash('sha256').update(reverse('app/walking/page.tsx',source.replace(before,after))).digest('hex'),'6e8b3160aed12b62bc445c4ea09e6a563bd5f7dc9a884811d1b158baad7d35e1'));
 }
});
function scheduleDisabledProps(path,historical=true){
 const source=historical?preservedAcceptedUiBytes(path,read(path)):read(path),file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),expressions=[];
 const visit=node=>{if(ts.isJsxAttribute(node)&&node.name.text==='disabled'&&node.initializer?.expression){const text=node.initializer.expression.getText(file);if(text.includes('accountLoading||catalogueLoading')||text.includes('accountLoading||quoteLoading'))expressions.push(text);}ts.forEachChild(node,visit);};visit(file);return expressions;
}
test('rendered native schedule controls stay disabled through delayed initial readiness then unlock',async()=>{
 for(const [path,loading,expectedCount,historical=true]of [['app/training/page.tsx','catalogueLoading',3],['app/walking/page.tsx','quoteLoading',6],['app/training/page.tsx','catalogueLoading',2,false]]){
  const expressions=scheduleDisabledProps(path,historical);assert.equal(expressions.length,expectedCount);
  let accountLoading=true,optionsLoading=true,releaseAccount,releaseOptions;
  const account=new Promise(resolve=>releaseAccount=resolve).then(()=>accountLoading=false);
  const options=new Promise(resolve=>releaseOptions=resolve).then(()=>optionsLoading=false);
  const render=()=>renderToStaticMarkup(createElement('div',null,...expressions.map((expression,index)=>createElement('input',{key:index,disabled:new Function('accountLoading',loading,'packageCode','return '+expression)(accountLoading,optionsLoading,'training-8-basic')}))));
  assert.equal((render().match(/disabled=""/g)||[]).length,expectedCount);
  releaseAccount();await account;assert.equal((render().match(/disabled=""/g)||[]).length,expectedCount);
  releaseOptions();await options;assert.equal((render().match(/disabled=""/g)||[]).length,0);
 }
});
