import ts from 'typescript';
import {createHash} from 'node:crypto';

// Compare application behavior while allowing presentation-only JSX changes.
export function uiWiringContract(source, filename = 'page.tsx') {
 const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const printer = ts.createPrinter({removeComments: true});
 const print = node => printer.printNode(ts.EmitHint.Unspecified, node, file);
 function containsJsx(node) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  let found = false;
  ts.forEachChild(node, child => { if (containsJsx(child)) found = true; });
  return found;
 }
 const functions = [], declarations = [], props = [], conditions = [];
 function visit(node) {
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && !containsJsx(node)) functions.push(print(node));
  if (ts.isVariableDeclaration(node) && node.initializer && !containsJsx(node.initializer)) declarations.push(print(node));
  if (ts.isJsxAttribute(node) && /^(on[A-Z]|disabled$|value$|checked$|defaultValue$|defaultChecked$|href$|action$|method$|name$|type$|required$|pattern$|min$|max$|maxLength$)/.test(node.name.text)) props.push(print(node));
  if (ts.isIfStatement(node)) conditions.push(print(node.expression));
  ts.forEachChild(node, visit);
 }
 visit(file);
 const canonical = JSON.stringify({functions: functions.sort(), declarations: declarations.sort(), props: props.sort(), conditions: conditions.sort()});
 return {sha256: createHash('sha256').update(canonical).digest('hex'), functions: functions.length, declarations: declarations.length, interactionProps: props.length, conditions: conditions.length};
}
