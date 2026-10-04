import {preservedTrainingIntegratedBytes} from './helpers/combined-local-reviewed-delta.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reverseCoinsGatewayCorrection,reverseReviewedThreeChat} from './helpers/atlas-handoff-deadline-review.mjs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__COIN_SIGNIN_DB__','__COIN_SIGNIN_ENV__');
const gateway=await import('../lib/api-gateway.ts');
let network=0;globalThis.fetch=async()=>{network++;throw Error('network prohibited');};
const db={prepare(){throw Error('database reads/writes prohibited in anonymous tests');},batch(){throw Error('database writes prohibited');}};
const env={DB:db,PAWSPACE_UAT_LOGIN:'on',PAWSPACE_UAT_SIGNING_KEY:'synthetic-unit-test-signing-key-not-hosted'};
const origin='https://pawspace-staging.karthik-fce.workers.dev';
const request=(path='/api/v2/test-coins',method='GET',body)=>new Request(origin+path,{method,...(body?{headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}:{})});
async function refusal(req,e=env){const r=await gateway.authorizeApiRequest(req,e);assert.ok(r instanceof Response);assert.equal(r.status,401);return {r,body:await r.json()};}
for(const method of ['GET','POST'])test(`anonymous exact coins ${method} retains refusal and customer recovery`,async()=>{const req=request(undefined,method,method==='POST'?{action:'redeem',customerId:'CUS-FOREIGN'}:undefined);const{r,body}=await refusal(req);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(body.code,'customer_sign_in_required');assert.equal(body.signInUrl,'/mobile-app');assert.match(body.error,/TEST coins/);if(method==='POST')assert.equal((await req.json()).customerId,'CUS-FOREIGN');});
test('coins customer recovery also works outside UAT login',async()=>{const{body}=await refusal(request(),{DB:db});assert.equal(body.code,'customer_sign_in_required');assert.equal(body.signInUrl,'/mobile-app');});
test('staff admin lookalike and unsupported methods retain staging refusal',async()=>{for(const req of [request('/api/team-overview'),request('/api/statutory-compliance'),request('/api/subscription-billing-admin','POST',{action:'save_plan'}),request('/api/v2/test-coins-admin'),request('/api/v2/test-coins','DELETE')]){const{body}=await refusal(req);assert.equal(body.code,'sign_in_required');assert.equal(body.signInUrl,'/staging-login');}});
test('coin permissions remain customer scoped and unsupported methods default deny',async()=>{for(const method of ['GET','POST'])assert.equal(await gateway.requiredPermission(request(undefined,method)), 'scheduling.book');for(const method of ['PUT','DELETE'])assert.equal(await gateway.requiredPermission(request(undefined,method)), 'dashboard.view');assert.equal(await gateway.requiredPermission(request('/api/statutory-compliance')),'finance.view');assert.equal(network,0);
 const file='lib/api-gateway.ts',source=preservedTrainingIntegratedBytes(file,readFileSync(new URL('../'+file,import.meta.url),'utf8'));
 const receipt=JSON.parse(readFileSync(new URL('./fixtures/customer-coins-gateway-preservation.json',import.meta.url),'utf8'));
 const hash=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(hash(source),receipt.afterSha256);
 const before=reverseCoinsGatewayCorrection(source,file);
 assert.equal(hash(before),receipt.beforeSha256);
 assert.equal(reverseCoinsGatewayCorrection(before,file),before);
 // Immutable module/chat gateway baseline already pinned by the historical preservation suite.
 assert.equal(hash(reverseReviewedThreeChat(source,file)),'59b0e3516406d01581311db3e3f7042b441e065d62d16fcddc6c6604b2abfa27');
 for(const[,after]of receipt.replacements){
  assert.throws(()=>reverseCoinsGatewayCorrection(source.replace(after,''),file));
  assert.throws(()=>reverseCoinsGatewayCorrection(source+after,file));
 }
 const mutated=source+'\n// unrelated gateway mutation\n';
 assert.notEqual(hash(reverseCoinsGatewayCorrection(mutated,file)),receipt.beforeSha256);
 assert.notEqual(hash(reverseReviewedThreeChat(mutated,file)),'59b0e3516406d01581311db3e3f7042b441e065d62d16fcddc6c6604b2abfa27');
});
test('cross-origin coin POST still fails before authentication',async()=>{const req=new Request(origin+'/api/v2/test-coins',{method:'POST',headers:{origin:'https://foreign.test','content-type':'application/json'},body:JSON.stringify({action:'sync'})});const r=await gateway.authorizeApiRequest(req,env);assert.equal(r.status,403);});
