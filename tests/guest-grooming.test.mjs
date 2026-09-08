import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {upsertCustomerPet} from '../lib/customer-account-client.ts';

test('pet writes preserve a caller retry key rather than minting a new mutation',async()=>{
 const previous=globalThis.fetch; const bodies=[];
 globalThis.fetch=async(_url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({data:{entityId:'pet-test'}});};
 try{
   const input={customerId:'test-only',idempotencyKey:'guest-stable-test',pet:{name:'Test pet',species:'dog',vaccinationStatus:'not_provided'}};
   await upsertCustomerPet(input);await upsertCustomerPet(input);
   assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);
   assert.equal(bodies[0].action,'upsert_pet');
 }finally{globalThis.fetch=previous;}
});
test('guest grooming has no fake identity and gates booking mutations behind verification',()=>{
 const source=readFileSync('app/mobile-app/grooming-flow.tsx','utf8');
 assert.match(source,/if\(!customer\)\{setVerifying\(true\);return;\}/);
 assert.match(source,/if\(!customer\|\|petsState!==null\)/);
 assert.match(source,/useState\(signedInCustomer\?1:2\)/);
 assert.match(source,/await guestPetIdentity\(identity.customerId,pet.id\)/);
 assert.match(source,/Retry saving pets/);
 assert.match(source,/Verification does not place the booking/);
 const manager=readFileSync('app/mobile-app/pet-manager.tsx','utf8');
 assert.match(manager,/if \(!customer\) \{\s+const draft:/);
 assert.match(manager,/setForm\(null\); setSaving\(false\);\s+return;/);
});
