import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
const compiled=buildSync({entryPoints:['lib/guest-grooming-draft.ts'],bundle:true,write:false,platform:'node',format:'esm'}).outputFiles[0].text;
const {parseGuestGroomingDraft,guestPetIdentity}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const pet={id:'draft:12345678-1234-1234-1234-123456789012',name:'Buddy',species:'dog',profile:{breed:'Golden Retriever',ageBand:'2 years',weightBand:'20–45 kg',aggression:'Friendly',vaccinated:false}};
const draft={version:1,savedAt:100000,type:'dog',packId:'bath',plan:'single',date:'2026-09-10',slot:'9:00–11:00 AM',pets:[],selectedPetIds:[]};
test('draft rejects stale, malformed and wrong-version data',()=>{
 assert.equal(parseGuestGroomingDraft('{'),null);
 assert.equal(parseGuestGroomingDraft(JSON.stringify({...draft,version:2}),100001),null);
 assert.equal(parseGuestGroomingDraft(JSON.stringify(draft),100000+86400001),null);
 assert.equal(parseGuestGroomingDraft(JSON.stringify({...draft,pets:[{...pet,id:'real-owned-pet'}]}),100001),null);
});
test('draft never restores authority-bearing fields',()=>{
 const value=parseGuestGroomingDraft(JSON.stringify({...draft,customerId:'someone',payment:'captured',serviceLocation:{verified:true},quoteId:'quote',selectedPetIds:['foreign']}),100001);
 assert.ok(value);assert.deepEqual(value.selectedPetIds,[]);
 for(const key of ['customerId','payment','serviceLocation','quoteId'])assert.equal(key in value,false);
});
test('retry pet identity is stable and owner scoped',async()=>{
 const a=await guestPetIdentity('owner-a',pet.id);
 assert.equal(a,await guestPetIdentity('owner-a',pet.id));
 assert.notEqual(a,await guestPetIdentity('owner-b',pet.id));
 assert.match(a,/^guest-[0-9a-f]{64}$/);
});
test('valid pet drafts restore selection but not photos',()=>{
 const restored=parseGuestGroomingDraft(JSON.stringify({...draft,pets:[{...pet,profile:{...pet.profile,photo:'data:image/jpeg;base64,a'}}],selectedPetIds:[pet.id]}),100001);
 assert.ok(restored);assert.equal(restored.pets[0].name,'Buddy');assert.equal(restored.pets[0].profile.photo,undefined);
 assert.deepEqual(restored.selectedPetIds,[pet.id]);
});
