import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const baseline=JSON.parse(readFileSync('tests/fixtures/task2-uat-ui-repair-baseline.json','utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=p=>readFileSync(p,'utf8');
test('stay repair preserves booking, identity, guest draft and theme wiring byte for byte',()=>{
 for(const [p,expected] of Object.entries(baseline.unchanged))assert.equal(hash(read(p)),expected,p);
});
test('stay repair only appends scoped hero visibility and in-flow navigation rules',()=>{
 const p='app/v2/stay-experience.module.css',now=read(p);const marker='/* Stay discovery has a dedicated hero;';const addition=now.slice(now.indexOf(marker));let original=now;for(const pair of baseline.repairs[p].reversals)original=original.replace(pair.after,pair.before);assert.equal(hash(original),baseline.repairs[p].oldHash);
 assert.match(addition,/\.page \.art img\s*\{ display:block !important;/);
 assert.match(addition,/\.page \.dock\s*\{ position:static; left:auto; bottom:auto; transform:none;/);
 assert.match(addition,/@media\(max-width:760px\)\s*\{ \.page \.dock \{ width:100%;/);
 assert.match(addition,/:global\(body\):has\(\.page\) :global\(\.paw-appearance-trigger\).*position:relative !important; inset:auto !important;/);
 assert.doesNotMatch(addition,/display:none|pointer-events|visibility:hidden|opacity:0/);
});
