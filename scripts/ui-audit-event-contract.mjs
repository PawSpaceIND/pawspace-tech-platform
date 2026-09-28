import ts from 'typescript';
import { createHash } from 'node:crypto';

/** Compare existing event handlers and request/field contracts across UI-only edits. */
export function uiBehaviorSignatures(text, file = 'page.tsx') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const signatures = [];
  const fieldNames = new Set(['value','checked','disabled','required','min','max','step','minLength','maxLength','type','name','href','action','method']);
  const hash = value => createHash('sha256').update(value.replace(/\s+/g, ' ').trim()).digest('hex');
  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (/^on[A-Z]/.test(name) || fieldNames.has(name)) signatures.push(`${name}:${hash(node.initializer?.getText(source) || 'true')}`);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'fetch') signatures.push(`fetch:${hash(node.getText(source))}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return signatures.sort();
}
