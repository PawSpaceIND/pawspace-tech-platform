import ts from 'typescript';
import { createHash } from 'node:crypto';

/** Pin each existing control's handlers and fields to its source-order identity. Pure layout wrappers do not count as controls. */
export function uiBehaviorSignatures(text, file = 'page.tsx') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const signatures = [];
  const fieldNames = new Set(['value','checked','disabled','required','min','max','step','minLength','maxLength','type','name','href','action','method']);
  const printer = ts.createPrinter({removeComments:true});
  const hash = node => createHash('sha256').update(node ? printer.printNode(ts.EmitHint.Unspecified,node,source) : 'true').digest('hex');
  const signed = name => /^on[A-Z]/.test(name) || fieldNames.has(name);
  let control = 0;
  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const fields = node.attributes.properties.filter(prop => ts.isJsxAttribute(prop) && signed(prop.name.getText(source)));
      if (fields.length) {
        const identity = `${control++}:${node.tagName.getText(source)}`;
        for (const field of fields) signatures.push(`control:${identity}:${field.name.getText(source)}:${hash(field.initializer)}`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'fetch') signatures.push(`fetch:${hash(node)}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return signatures.sort();
}
