import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const baseline=JSON.parse(readFileSync(new URL('./fixtures/payroll-shell-baseline.json',import.meta.url),'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const canonical='app/team/people/payroll/page.tsx',layout='app/v2/team/people/payroll/layout.tsx';
const source=p=>readFileSync(p,'utf8');
function moduleAt(path,deps,effects){
 const moduleObject={exports:{}};
 const React={Fragment:'fragment',useState:value=>[value,()=>{}],useEffect:fn=>effects.push(fn)};
 const jsx=(type,props)=>({type,props:props||{}});
 const code=ts.transpileModule(source(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,require(name){if(name==='react')return React;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};if(name in deps)return {default:deps[name]};throw Error('Unexpected import '+name);},fetch:async(url,options)=>{assert.equal(url,'/api/payroll');assert.equal(options?.method,undefined);return {ok:true,json:async()=>({data:{runs:[],employees:[],structures:[],truth:{}}})};},Intl,Date,Error});
 return moduleObject.exports.default;
}
function flatten(node,out=[]){if(!node)return out;if(Array.isArray(node)){node.forEach(n=>flatten(n,out));return out;}if(typeof node!=='object')return out;if(typeof node.type==='function')return flatten(node.type(node.props),out);out.push(node);flatten(node.props?.children,out);return out;}
test('V2 composes both functional sections inside one shell; legacy remains standalone',()=>{
 const effects=[];const Shell=({children})=>({type:'workspace',props:{children}});
 const Payroll=moduleAt(canonical,{'next/link':'a','../../../components/staff-workspace/StaffModule':Shell,'./PayrollSetupPanel':'setup','./SalarySandboxPanel':'salary'},effects);
 const V2Page=moduleAt('app/v2/team/people/payroll/page.tsx',{'../../../../team/people/payroll/page':Payroll},effects);
 const Layout=moduleAt(layout,{'../../../../components/staff-workspace/StaffModule':Shell,'./V2PayrollGovernancePanel':'governance'},effects);
 const tree=flatten(Layout({children:{type:V2Page,props:{}}}));
 assert.equal(tree.filter(n=>n.type==='workspace').length,1);
 assert.equal(tree.filter(n=>n.type==='h1').length,1);
 assert.deepEqual(tree.filter(n=>n.type==='a').map(n=>n.props.href),['/v2/team/people','/v2/team/people/finance']);
 assert.deepEqual(flatten(Payroll()).filter(n=>n.type==='a').map(n=>n.props.href),['/team/people','/team/people/finance']);
 assert.equal(tree.filter(n=>n.type==='main').length,2,'Both content sections survive');
 assert.equal(flatten(Payroll()).filter(n=>n.type==='workspace').length,1);
});
test('canonical handlers, requests, permissions and business content retain exact baseline bytes',()=>{
 const reverted=source(canonical).replace('href={embedded?"/v2/team/people":"/team/people"}','href="/team/people"').replace('href={embedded?"/v2/team/people/finance":"/team/people/finance"}','href="/team/people/finance"').replace('import{Fragment,useEffect,useState}from"react";','import{useEffect,useState}from"react";').replace('export default function PayrollPage({embedded=false}:{embedded?:boolean}={}){const Frame=embedded?Fragment:StaffModule;','export default function PayrollPage(){').replace('return <Frame><main','return <StaffModule><main').replace('</main></Frame>','</main></StaffModule>');
 assert.equal(hash(reverted),baseline.sha256[canonical]);
 const revertedLayout=source(layout).replace('return <StaffModule>{children}<main','return <>{children}<StaffModule><main').replace('</main></StaffModule>;','</main></StaffModule></>;');
 assert.equal(hash(revertedLayout),baseline.sha256[layout]);
});
