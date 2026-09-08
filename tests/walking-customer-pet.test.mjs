import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__WALKING_CUSTOMER_PET_DB__');
const {walkingPetForSelection}=await import('../lib/walking-customer-pet.ts');
const pets=[{id:'dog-1',sourceId:'owned-1',name:'Milo',species:'dog',breed:'Indie',vaccinationStatus:'vaccinated'},{id:'dog-2',sourceId:'owned-2',name:'Luna',species:'dog',breed:'Beagle',vaccinationStatus:'vaccinated'},{id:'cat-1',name:'Kit',species:'cat'}];
test('walking selection preserves the second owned dog and its canonical identity',()=>{assert.deepEqual(walkingPetForSelection(pets,'dog-2'),{id:'dog-2',sourceId:'owned-2',name:'Luna',species:'dog',breed:'Beagle',vaccinationStatus:'vaccinated'});});
test('walking never substitutes the first dog for absent, foreign, removed or non-dog selections',()=>{for(const id of ['', 'foreign-dog','cat-1'])assert.equal(walkingPetForSelection(pets,id),null);assert.equal(walkingPetForSelection(pets.slice(1),'dog-1'),null);});
test('walking entry renders an explicit pet choice without a sample dog option',async()=>{const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{default:Page}=await import('../app/walking/page.tsx');const html=renderToStaticMarkup(React.createElement(Page));assert.match(html,/Choose your dog/);assert.doesNotMatch(html,/<option[^>]*>Bruno|BUILD BRUNO/);assert.match(html,/Loading your dogs/);});
