import ts from 'typescript';
import {createHash} from 'node:crypto';
import {collectStyleRoots} from '../tests/helpers/staff-presentation-contract.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const isJsx = node => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);

/** Retain the original pre-JSX program fingerprint as an independent, unchanged protection. */
export function uiProgramContract(source, filename='page.tsx') {
 const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const {aliases}=collectStyleRoots(file);
 const transformed=ts.transform(file,[context=>{
  const visit=node=>{
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.endsWith('/ui/ReadableText'))return undefined;
   if(isJsx(node))return ts.factory.createIdentifier('__UI_RENDER__');
   if(aliases.has(node))return ts.factory.updateVariableDeclaration(node,node.name,node.exclamationToken,node.type,ts.factory.createIdentifier('__UI_STYLE__'));
   return ts.visitEachChild(node,visit,context);
  };
  return node=>ts.visitNode(node,visit);
 }]);
 const normalized=ts.createPrinter({removeComments:true}).printFile(transformed.transformed[0]);
 transformed.dispose();
 return digest(normalized);
}

/** Sign children, spreads and every non-style prop value, including literal and boolean custom props. */
export function uiJsxExpressions(source, filename='page.tsx') {
 const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const printer=ts.createPrinter({removeComments:true}), expressions=[];
 function add(kind,expression) {
  const normalized=ts.transform(expression,[context=>{
   const visit=node=>isJsx(node)?ts.factory.createIdentifier('__UI_RENDER__'):ts.visitEachChild(node,visit,context);
   return node=>ts.visitNode(node,visit);
  }]);
  expressions.push(`${kind}:${printer.printNode(ts.EmitHint.Expression,normalized.transformed[0],file)}`);
  normalized.dispose();
 }
 function visit(node) {
  if(ts.isJsxAttribute(node)) {
   const name=node.name.getText(file);
   if(name==='style'||name==='className')return;
   if(!node.initializer)add(`prop:${name}`,ts.factory.createTrue());
   else if(ts.isStringLiteral(node.initializer))add(`prop:${name}`,node.initializer);
  }
  if(ts.isJsxExpression(node)&&node.expression) {
   const parent=node.parent;
   add(ts.isJsxAttribute(parent)?`prop:${parent.name.getText(file)}`:'child',node.expression);
  }
  if(ts.isJsxSpreadAttribute(node))add('spread',node.expression);
  ts.forEachChild(node,visit);
 }
 visit(file);
 return expressions;
}

/** Combine the preserved imperative program with ordered JSX expressions; markup alone is normalized. */
export function uiImperativeContract(source, filename='page.tsx') {
 return digest(JSON.stringify({program:uiProgramContract(source,filename),jsx:uiJsxExpressions(source,filename)}));
}
