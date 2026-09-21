import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Staff-console defects found by the launch verification pass: a section index that 404s (EMP-10),
// a customer list that hides what the server just found (EMP-09) and a list that renders every
// record in one column (EMP-14).
const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('EMP-10: /team/whatsapp has a section index that links to each child route', () => {
  // Rendered through OpsShell in the browser; asserted here on the route tree and the page source,
  // because OpsShell pulls next/navigation, which this suite's loader does not provide.
  const source = read('app/team/whatsapp/page.tsx');
  for (const child of ['analytics', 'templates', 'automation']) {
    assert.ok(fs.existsSync(new URL(`../app/team/whatsapp/${child}/page.tsx`, import.meta.url)), `${child} route must exist`);
    assert.ok(source.includes(`/team/whatsapp/${child}`), `the index must link to /team/whatsapp/${child}`);
  }
  assert.match(source, /export default function/, 'the parent route must render a page, not 404');
  assert.match(source, /WhatsApp workspace/);
});

test('EMP-09: the CRM customer list keeps the rows the server searched, whose text is masked', () => {
  const source = read('app/crm/page.tsx');
  assert.match(source, /serverSearched/, 'the filter must know when the query already went to the server');
  const filterLine = source.split('\n').find((line) => line.includes('const filtered=useMemo'));
  assert.ok(filterLine, 'the filtered memo must exist');
  assert.match(filterLine, /const hit=!q\|\|serverSearched\|\|/, 'a server-searched result set must not be re-filtered against masked text');
  assert.match(filterLine, /\[contacts,search,query,segment\]/, 'the memo must recompute when the server query changes');
});

test('EMP-14: /team/sales pages its customer list instead of rendering every record', () => {
  const source = read('app/team/sales/page.tsx');
  assert.match(source, /const PAGE=\d+;/, 'a page size must be defined');
  assert.match(source, /listed\.slice\(0,shown\)/, 'only a page of the filtered list may render');
  assert.match(source, /visible\.map\(c=>/, 'the list must render the paged slice, not every customer');
  assert.ok(!/\{customers\.map\(c=><button/.test(source), 'the unpaged render must be gone');
  assert.match(source, /Show \{Math\.min\(PAGE,listed\.length-visible\.length\)\} more/, 'the operator needs a way to load the rest');
});
