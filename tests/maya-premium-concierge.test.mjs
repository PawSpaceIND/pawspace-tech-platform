import test from 'node:test';
import assert from 'node:assert/strict';
import {detectMayaConciergeService,mayaServiceMode,mayaCrossSellCandidates,premiumConciergePrompt} from '../lib/maya-premium-concierge.ts';

test('Maya concierge recognizes every PawSpace service family',()=>{
 const cases=[
  ['I need grooming for Coco','grooming'],
  ['Can I book puppy training?','dog_training'],
  ['Need daycare tomorrow','boarding'],
  ['I need a sitter at home','pet_sitting'],
  ['Book a walker','dog_walking'],
  ['Need pet taxi pickup','pet_taxi'],
  ['Do you have fresh food?','food'],
  ['My cat passed away and I need cremation','funeral_memorial'],
  ['I need pet relocation to Chennai','relocation'],
 ];
 for(const [message,expected] of cases)assert.equal(detectMayaConciergeService(message),expected,message);
});

test('current bookability is explicit and enquiry-only services cannot be presented as instant booking',()=>{
 assert.equal(mayaServiceMode('grooming'),'bookable');
 assert.equal(mayaServiceMode('dog_training'),'bookable');
 assert.equal(mayaServiceMode('boarding'),'bookable');
 assert.equal(mayaServiceMode('pet_sitting'),'bookable');
 assert.equal(mayaServiceMode('relocation'),'enquiry');
 assert.equal(mayaServiceMode('funeral_memorial'),'specialist');
});

test('cross-sell is suppressed for grief and relocation',()=>{
 assert.deepEqual(mayaCrossSellCandidates('funeral_memorial'),[]);
 assert.deepEqual(mayaCrossSellCandidates('relocation'),[]);
 assert.ok(mayaCrossSellCandidates('grooming').includes('dog_training'));
});

test('premium prompt is needs-led, species-safe, personalized and callback aware',()=>{
 const p=premiumConciergePrompt();
 assert.match(p,/recommend the smallest number of relevant options/i);
 assert.match(p,/address pets by their saved names/i);
 assert.match(p,/Never call every pet a dog/i);
 assert.match(p,/supports cats too/i);
 assert.match(p,/Do not repeat fixed fillers such as "Sure, give me a second"/i);
 assert.match(p,/Funeral\/Memorial conversations are empathy-first/i);
 assert.match(p,/Relocation is enquiry-only/i);
 assert.match(p,/schedule it through the governed callback path/i);
 assert.match(p,/Before ending a normal successful call/i);
});

test('service history can preserve an established intent across a short follow-up',()=>{
 assert.equal(detectMayaConciergeService('Tomorrow at 1 PM',['I need grooming for Coco']),'grooming');
});
