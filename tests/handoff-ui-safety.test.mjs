import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('handoff UI distinguishes unavailable queue from empty and disables stale actions',()=>{
 const source=readFileSync('app/team/ai/handoff/page.tsx','utf8');
 assert.doesNotMatch(source,/fetchQueue\(\)\.catch/);
 assert.match(source,/Queue unavailable/);
 assert.match(source,/setHandoff\(null\);setDetailLoading\(true\)/);
 assert.match(source,/!queueLoaded \|\| String\(current.status\)/);
 assert.match(source,/setRevision\(value=>value\+1\)/);
 assert.match(source,/allRows.push\(\{id:entry.threadId,customer_id:entry.customerId/);
 assert.doesNotMatch(source,/setError\(cause instanceof Error/);
 assert.match(source,/window.confirm/);
});
