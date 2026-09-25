import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('V2 Partner workspace routing stays inside /v2/partner',()=>{
  const helper=read('lib/partner-job-workspace.ts');
  assert.match(helper,/options:\{v2\?:boolean\}/);
  for(const name of ['trainer','host','walker','driver','sitter'])assert.match(helper,new RegExp('\\$\\{prefix\\}/'+name+'\\?bookingId='));
  const shell=read('app/partner-app/page.tsx');
  assert.match(shell,/usePathname/);
  assert.match(shell,/pathname\.startsWith\("\/v2\/partner"\)/);
  assert.match(shell,/partnerJobWorkspaceHref\(job,\{v2:inV2Partner\}\)/);
});

test('V2 provider workspace wrappers exist for every cross-vertical provider surface',()=>{
  const routes=[
    'host/page.tsx','host/proof/page.tsx',
    'sitter/page.tsx','sitter/proof/page.tsx',
    'walker/page.tsx','walker/proof/page.tsx','walker/recovery/page.tsx',
    'driver/page.tsx','driver/proof/page.tsx','driver/recovery/page.tsx',
    'trainer/page.tsx',
  ];
  for(const route of routes)assert.ok(fs.existsSync(path.join(root,'app/v2/partner',route)),route);
});

test('V2 provider workspaces keep customer/proof/back links in the V2 namespace',()=>{
  const sources=[
    'app/host/page.tsx','app/host/proof/page.tsx','app/sitter/sitting-workspace.tsx','app/sitter/proof/page.tsx',
    'app/walker/page.tsx','app/walker/proof/page.tsx','app/walker/recovery/page.tsx',
    'app/driver/canonical-driver-page.tsx','app/driver/proof/page.tsx','app/driver/recovery/page.tsx','app/trainer/page.tsx',
  ].map(read).join('\n');
  assert.match(sources,/\/v2\/partner\/host/);
  assert.match(sources,/\/v2\/partner\/sitter/);
  assert.match(sources,/\/v2\/partner\/walker/);
  assert.match(sources,/\/v2\/partner\/driver/);
  assert.match(sources,/\/v2\/partner\/trainer/);
  assert.match(sources,/\/v2\/boarding/);
  assert.match(sources,/\/v2\/sitting/);
  assert.match(sources,/\/v2\/walking/);
  assert.match(sources,/\/v2\/taxi/);
  assert.match(sources,/\/v2\/training/);
});
