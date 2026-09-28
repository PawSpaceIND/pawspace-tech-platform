// Read-only candidate inventory for the two founder-supplied demo numbers.
// Suffix lookup is not full-phone ownership verification and cannot authorize a call.
// No login, contact cleanup, consent change, dialing, provider change or payment operation.
import assert from 'node:assert/strict';
const env=process.env;
assert.equal(env.VOICE_SALE_ACTION,'inspect-app-voice');
assert.equal(env.EXPECTED_DESTINATION_LAST4,'6690');
assert.equal(env.STAGING_D1_ID,'1b879a28-c8a9-40b0-830d-1ce439061a00');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
const headers={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
async function read(path,body){
 const r=await fetch(base+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const b=await r.json();if(!r.ok||b.success!==true)throw Error('Read-only preflight refused: '+r.status);return b.result;
}
const dbPath='/d1/database/'+encodeURIComponent(env.STAGING_D1_ID);
const database=await read(dbPath);assert.equal(database.name,'pawspace-staging');
const settings=await read('/workers/scripts/pawspace-staging/settings');
const bindings=settings.bindings||[],vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text??b.value]));
assert.equal(vars.PAWSPACE_DEPLOYMENT_ENV,'staging');assert.equal(vars.PAWSPACE_PAYMENT_ENV,'sandbox');
assert.notEqual(vars.PAWSPACE_PAYMENT_LIVE_APPROVED,'true');
assert.ok(bindings.some(b=>b.type==='d1'&&(b.id??b.database_id)===env.STAGING_D1_ID));
const allow=String(env.PAWSPACE_VOICE_UAT_ALLOWLIST||'').split(/[\s,;]+/).filter(Boolean).map(p=>p.replace(/\D/g,'').slice(-4));
const deployments=await read('/workers/scripts/pawspace-staging/deployments');
console.log('DEMO_DEPLOYMENT='+JSON.stringify({versions:deployments.deployments?.[0]?.versions,staging:true,sandbox:true}));
for(const last4 of ['7878','6690']){
 const result=await read(dbPath+'/query',{sql:"SELECT id,name,source FROM canonical_customers WHERE primary_phone LIKE ? OR secondary_phone LIKE ? LIMIT 21",params:['%'+last4,'%'+last4]});
 assert.ok(result.every(r=>r.success===true));
 const candidates=result.flatMap(r=>r.results||[]);assert.ok(candidates.length<=20,'Candidate set incomplete');
 console.log('DEMO_RECIPIENT_CANDIDATES='+JSON.stringify({last4,configuredAllowlistSuffix:allow.includes(last4),candidateCount:candidates.length,candidates,fullPhoneVerified:false,dialed:false,customerChanged:false}));
}
console.log('DEMO_INSPECTION_DONE='+JSON.stringify({readOnly:true,called:false,knowledgeActivated:false}));
