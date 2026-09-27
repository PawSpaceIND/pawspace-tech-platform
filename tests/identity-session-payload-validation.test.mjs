import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__G20_PAYLOAD_DB__');
const { POST } = await import('../app/api/identity-session/route.ts');
const origin='https://pawspace.test';
for(const payload of ['{','null','[]','1','"text"','{}','{"assertion":123}','{"assertion":"  "}']) {
 test(`identity exchange rejects malformed or missing assertion before database access: ${payload}`,async()=>{
  const response=await POST(new Request(origin+'/api/identity-session',{method:'POST',headers:{origin,'content-type':'application/json'},body:payload}));
  assert.equal(response.status,400);
  assert.equal((await response.json()).error,'Verified identity assertion is required');
  assert.equal(response.headers.has('set-cookie'),false);
 });
}
test('cross-origin refusal still precedes malformed-payload validation',async()=>{
 const response=await POST(new Request(origin+'/api/identity-session',{method:'POST',headers:{origin:'https://other.test','content-type':'application/json'},body:'null'}));
 assert.equal(response.status,403);
 assert.equal(response.headers.has('set-cookie'),false);
});
