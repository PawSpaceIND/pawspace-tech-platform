import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__TASK2_GUEST_RECON_DB__','__TASK2_GUEST_RECON_ENV__');
const deps=await import('../lib/v2/grooming-selection.ts');
const source=readFileSync('app/v2/grooming/page.tsx','utf8'),start=source.indexOf('  const selectedPets = useMemo('),end=source.indexOf('  const packageBundle =',start),expression=source.slice(start,end),effectStart=source.indexOf('    if (selectedPackage && selectedPackage.code !== selectedPackageCode)'),effect=source.slice(effectStart,source.indexOf('\n  },',effectStart));
test('Cat Premium survives first saved Dog and then Cat selection; incompatible pets never silently select another package',()=>{
 const pets=[{id:'DOG',species:'dog',name:'Dog',dateOfBirth:'2020-01-01'},{id:'CAT',species:'cat',name:'Cat',dateOfBirth:'2020-01-01'}];
 const catalogue={packages:[{code:'dog-basic',audience:'dog',bundles:[{petCount:1}]},{code:'cat-basic',audience:'cat',bundles:[{petCount:1}]},{code:'cat-premium',audience:'cat',bundles:[{petCount:1}]}]};
 let selectedPackageCode='cat-premium';const results=[];
 for(const petId of ['DOG','CAT']){const context={coverage:null,account:{pets},selectedPetIds:[petId],catalogue,date:'2030-01-01',guestPackageCode:'cat-premium',selectedPackageCode,useMemo:fn=>fn(),useEffect:()=>{},groomingBundleForCount:(p,n)=>p.bundles.find(b=>b.petCount===n),...deps,setSelectedPackageCode:code=>{selectedPackageCode=code;}};
  results.push(runInNewContext(expression+'\n'+effect+'\n({active:selectedPackage?.code});',context).active);
  assert.equal(selectedPackageCode,'cat-premium');
 }
 assert.deepEqual(results,[undefined,'cat-premium']);
});
test('completed/recovered booking clears draft outside unchanged mutation handlers',()=>{assert.match(source,/if\(!booking&&!recoveryBookingId\)return;setGuestPackageCode\(""\);try\{window.sessionStorage.removeItem\("pawspace_v2_grooming_guest_package"\)/);});
