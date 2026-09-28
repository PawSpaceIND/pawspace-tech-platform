import ts from 'typescript';
import {createHash} from 'node:crypto';
import {collectStyleRoots} from '../tests/helpers/staff-presentation-contract.mjs';

/** Preserve the imperative program independently of the rendered markup and CSS. */
export function uiImperativeContract(source, filename='page.tsx') {
 const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const {aliases}=collectStyleRoots(file);
 const transformed=ts.transform(file,[context=>{
  const visit=node=>{
   if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.endsWith('/ui/ReadableText'))return undefined;
   if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node))return ts.factory.createIdentifier('__UI_RENDER__');
   if(aliases.has(node))return ts.factory.updateVariableDeclaration(node,node.name,node.exclamationToken,node.type,ts.factory.createIdentifier('__UI_STYLE__'));
   return ts.visitEachChild(node,visit,context);
  };
  return node=>ts.visitNode(node,visit);
 }]);
 const normalized=ts.createPrinter({removeComments:true}).printFile(transformed.transformed[0]);
 transformed.dispose();
 return createHash('sha256').update(normalized).digest('hex');
}
