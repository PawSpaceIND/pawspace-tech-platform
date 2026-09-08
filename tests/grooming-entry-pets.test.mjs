import test from 'node:test';
import assert from 'node:assert/strict';
import { groomingEntryPets } from '../lib/grooming-entry-pets.ts';

test('a saved single pet is selected without another selection tap', () => {
  assert.deepEqual(groomingEntryPets([{id:'cat-1',species:'cat'}]), {type:'cat',selectedPetIds:['cat-1']});
});
test('explicit puppy and kitten packages survive pet hydration', () => {
  const pets=[{id:'cat-1',species:'cat'},{id:'dog-1',species:'dog'}];
  assert.deepEqual(groomingEntryPets(pets,'puppy'),{type:'puppy',selectedPetIds:['dog-1']});
  assert.deepEqual(groomingEntryPets(pets,'kitten'),{type:'kitten',selectedPetIds:['cat-1']});
});
test('a package never silently selects the wrong species', () => {
  assert.deepEqual(groomingEntryPets([{id:'dog-1',species:'dog'}],'cat'),{type:'cat',selectedPetIds:[]});
  assert.deepEqual(groomingEntryPets([],'puppy'),{type:'puppy',selectedPetIds:[]});
});
test('unsupported pets are not selected for grooming', () => {
  assert.deepEqual(groomingEntryPets([{id:'bird-1',species:'bird'}]),{type:'dog',selectedPetIds:[]});
});
