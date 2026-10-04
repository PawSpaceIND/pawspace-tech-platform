import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const source=readFileSync(new URL('../app/components/native-art.tsx',import.meta.url),'utf8');
function art(theme){
 const compiledModule={exports:{}},jsx=(type,props)=>({type,props:props||{}});
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 runInNewContext(code,{module:compiledModule,exports:compiledModule.exports,require(name){if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='./appearance-context')return {useEffectiveTheme:()=>theme};throw Error(name);}});
 return compiledModule.exports.NativeServiceArt({service:'grooming',informative:true});
}
for(const theme of ['editorial','concierge'])test(`actual native Grooming artwork selects only the effective ${theme} asset and sprite`,()=>{
 const frame=art(theme),img=frame.props.children;
 assert.equal(frame.props['data-native-art'],`${theme}-grooming`);
 assert.ok(img.props.src.startsWith(`/assets/native/${theme}/`));
 const other=theme==='editorial'?'concierge':'editorial';assert.ok(!img.props.srcSet.includes(`/assets/native/${other}/`));
 assert.equal(img.props.alt,'Illustrative grooming scene with a dog and a carer');
 assert.equal(frame.props.style['--sprite-width'],theme==='editorial'?'331.746032%':'311.940299%');
});
