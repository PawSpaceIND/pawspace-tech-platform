import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__TRAINING_CONSULTATIVE_PRESENTATION__');
const {default:Choices}=await import('../app/training/training-family-choices.tsx');
const {recommendTrainingPlan}=await import('../lib/training-goals.ts');
const {trainingPriceForPets}=await import('../lib/training-pricing.ts');
const plans=Object.freeze([{package_code:'training-8-basic',name:'Governed obedience',base_price:12345,extra_pet_percent:50,sessions:8,validity_days:62,meet_and_greet:0,direct_minutes_per_pet:45,coaching_minutes_per_pet:15},{package_code:'training-2-starter',name:'Governed assessment',base_price:6789,sessions:2,validity_days:31,meet_and_greet:0,direct_minutes_per_pet:30,coaching_minutes_per_pet:15}].map(Object.freeze));
function render(recommendation,petCount=2){return renderToStaticMarkup(createElement(Choices,{plans,selectedCode:'training-8-basic',petCount,recommendation,renderChoice:plan=>createElement('button',{'data-code':plan.package_code},`${plan.name} ₹${trainingPriceForPets(plan.base_price,petCount,plan.extra_pet_percent)}`)}));}
test('matched goal exposes canonical plan and exact selected-dog commercial expression; alternatives remain accessible',()=>{
 const recommendation=recommendTrainingPlan({goals:['Recall'],packageCodes:plans.map(p=>p.package_code),dogs:[{ageYears:2}]});
 assert.equal(recommendation.packageCode,'training-8-basic');const html=render(recommendation);
 assert.match(html,/Why this plan: your selected focus is Recall/);assert.ok(html.includes(`Governed obedience ₹${trainingPriceForPets(12345,2,50)}`));assert.match(html,/60 minutes per dog each session/);assert.match(html,/Compare programmes and prices/);assert.match(html,/Governed assessment/);assert.ok(!html.includes('AI recommendation'));
});
test('unrecognised goals, zero dogs and missing catalogue recommendations do not invent a suggested plan',()=>{
 for(const [rec,count] of [[recommendTrainingPlan({goals:['Unknown'],packageCodes:plans.map(p=>p.package_code)}),2],[{basis:'goals',packageCode:'unknown',matchedGoals:['Recall']},2],[{basis:'goals',packageCode:'training-8-basic',matchedGoals:['Recall']},0]])assert.ok(!render(rec,count).includes('Suggested training programme'));
});
test('V2 checks and reserves the first appointment while saved dogs guide the programme',()=>{
 const source=readFileSync(new URL('../app/training/page.tsx',import.meta.url),'utf8');
 assert.ok(source.includes('schedulingMode:TRAINING_SCHEDULING_MODE'));
 assert.ok(source.includes('const providerSelection="auto" as const'));
 assert.ok(source.includes('trainingReservationForChoice(selection,{mode:providerSelection})'));
 assert.ok(source.includes('Later sessions are scheduled one at a time'));
 assert.ok(source.includes('dogs:selectedPets'));
 assert.ok(source.includes('recommendation={recommendation} petCount={petCount}'));
 assert.ok(source.includes('loadCustomerAccount().then(record=>'));
 const availability=readFileSync(new URL('../lib/training-availability-client.ts',import.meta.url),'utf8');
 assert.match(availability,/occurrences: rolling \|\| quote\.meetAndGreet \? 1 : quote\.sessions/);
});
