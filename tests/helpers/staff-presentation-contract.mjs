import ts from 'typescript';
import {createHash} from 'node:crypto';

export function parseStaffPage(source, name='page.tsx') {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
export function collectStyleRoots(file) {
  const declarations=new Map(), roots=new Set(), aliases=new Set();
  function declarationsIn(node) {
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)declarations.set(node.name.text,node);
    ts.forEachChild(node,declarationsIn);
  }
  declarationsIn(file);
  function follow(node) {
    if(!node)return;
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node))return follow(node.expression);
    if(ts.isIdentifier(node)) {
      const decl=declarations.get(node.text);
      if(decl&&!aliases.has(decl)){aliases.add(decl);follow(decl.initializer);}return;
    }
    if(ts.isObjectLiteralExpression(node)) {
      roots.add(node);
      for(const prop of node.properties)if(ts.isSpreadAssignment(prop))follow(prop.expression);
    } else if(ts.isConditionalExpression(node)){follow(node.whenTrue);follow(node.whenFalse);}
  }
  function walk(node) {
    if(ts.isJsxAttribute(node)&&node.name.text==='style'&&node.initializer&&ts.isJsxExpression(node.initializer))follow(node.initializer.expression);
    ts.forEachChild(node,walk);
  }
  walk(file);return {roots,aliases};
}

/** Ignore only presentation fields; every handler, request, payload, condition and text remains. */
export function staffSemanticContract(source, name='page.tsx') {
  const file=parseStaffPage(source,name), {aliases}=collectStyleRoots(file);
  const transformed=ts.transform(file,[context=>{
    const visit=node=>{
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.endsWith('/staff-workspace/StaffModule'))return undefined;
      if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='StaffModule') {
        const children=node.children.filter(child=>!ts.isJsxText(child)||child.text.trim());
        if(children.length!==1)throw new Error('StaffModule must wrap exactly one existing root.');
        return ts.visitNode(children[0],visit);
      }
      if(ts.isJsxAttribute(node)&&['style','data-staff-grid'].includes(node.name.text))return undefined;
      if(aliases.has(node))return ts.factory.updateVariableDeclaration(node,node.name,node.exclamationToken,node.type,ts.factory.createIdentifier('__EXISTING_STYLE__'));
      return ts.visitEachChild(node,visit,context);
    };
    return node=>ts.visitNode(node,visit);
  }]);
  const normalized=ts.createPrinter({removeComments:true}).printFile(transformed.transformed[0]);transformed.dispose();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Normalize an explicitly labelled disclosure around the original local rail, not its contents. */
export function staffContextSemanticContract(source, name='page.tsx') {
  const file=parseStaffPage(source,name);
  const transformed=ts.transform(file,[context=>{
    const visit=node=>{
      if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='details'&&node.openingElement.attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.text==='data-staff-context')) {
        const children=node.children.filter(c=>!ts.isJsxText(c)||c.text.trim());
        if(children.length!==2||!ts.isJsxElement(children[0])||children[0].openingElement.tagName.getText(file)!=='summary'||!ts.isJsxElement(children[1])||children[1].openingElement.tagName.getText(file)!=='aside')throw new Error('Context disclosure must retain exactly the original aside plus its label.');
        return ts.visitNode(children[1],visit);
      }
      return ts.visitEachChild(node,visit,context);
    };
    return node=>ts.visitNode(node,visit);
  }]);
  const normalized=ts.createPrinter().printFile(transformed.transformed[0]);transformed.dispose();
  return staffSemanticContract(normalized,name);
}
