import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectAssistedPets} from '../lib/assisted-pet-selection.ts';
const pets=Array.from({length:14},(_,i)=>({sourceId:'source-'+i,canonicalId:'PET-'+i,name:'Test '+i,species:i===13?'cat':'dog'}));
test('four selected pets are passed, not the entire 14-pet family',()=>{
 const keys=['PET-0','PET-2','PET-4','PET-6'];const result=selectAssistedPets(pets,keys);
 assert.deepEqual(result.map(p=>p.canonicalId),keys);assert.equal(pets.length,14);
});
test('empty, duplicated, unowned, oversized and mixed-species selections are refused',()=>{
 for(const keys of [[],['PET-0','PET-0'],['FOREIGN'],['PET-0','PET-1','PET-2','PET-3','PET-4'],['PET-0','PET-13']])assert.throws(()=>selectAssistedPets(pets,keys));
 assert.equal(selectAssistedPets(pets,['PET-13'])[0].species,'cat');
});
test('assisted UI source contract: explicit authority and selected pets only',async()=>{
 const page=await readFile(new URL('../app/assisted-booking/page.tsx',import.meta.url),'utf8');
 assert.match(page,/consentCaptured,setConsentCaptured\]=useState\(false\)/);
 assert.match(page,/consentReference,setConsentReference\]=useState\(""\)/);
 assert.match(page,/pets:chosenPets/);assert.doesNotMatch(page,/pets:customer.pets,cityId/);
 assert.match(page,/consentReference.trim\(\).length<5/);
});
