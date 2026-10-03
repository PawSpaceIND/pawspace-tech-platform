import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const baseline=JSON.parse(readFileSync('tests/fixtures/task2-uat-ui-repair-baseline.json','utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
function reverse(source,repair){for(const pair of repair.reversals){assert.equal(source.split(pair.after).length,2,'Reviewed replacement must occur exactly once');source=source.replace(pair.after,pair.before);}return source;}
for(const [path,repair] of Object.entries(baseline.repairs))test('Reviewed repair reverses exactly and rejects unrelated mutation: '+path,()=>{
 const source=readFileSync(path,'utf8');assert.equal(hash(source),repair.newHash);
 assert.equal(hash(reverse(source,repair)),repair.oldHash);
 assert.notEqual(hash(reverse(source+'\n/* unauthorized mutation probe */\n',repair)),repair.oldHash);
 const exact=repair.reversals[0].after,mid=Math.floor(exact.length/2);const broken=source.replace(exact,exact.slice(0,mid)+'/* replacement mutation */'+exact.slice(mid));assert.throws(()=>reverse(broken,repair));
});
