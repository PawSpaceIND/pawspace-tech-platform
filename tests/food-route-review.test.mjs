import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preservedReviewedFoodBytes} from './helpers/food-route-review.mjs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url));
const path='app/v2/food/page.tsx',bridge=read(path);
test('reviewed Food bridge reconciles exactly with immutable historical source hash',()=>{
 const before=preservedReviewedFoodBytes(path,bridge);
 assert.equal(createHash('sha256').update(before).digest('hex'),'15bb74478aa59bbdd8f74e35b9ff00e1025b9b051d26c68202c98192921fad49');
 assert.equal(preservedReviewedFoodBytes(path,before),before);
});
test('unreviewed route redirection or parameter change is refused',()=>{
 for(const [from,to]of [['../food-experience','../other-experience'],['<V2FoodExperience/>','<V2FoodExperience unsafe/>']])assert.throws(()=>preservedReviewedFoodBytes(path,bridge.toString().replace(from,to)));
});
test('Food handler, identity, stock and disabled-guard mutations are refused',()=>{
 for(const[from,to]of [['createCanonicalFoodOrder({','unsafeOrder({'],['loadV2CustomerSession()','fakeCustomerSession()'],['active.uat_available_units','999'],['!quoteCurrent||quoteLoading','false||quoteLoading']]){
  const source=read('app/v2/food-experience.tsx').toString();assert.ok(source.includes(from),from);
  assert.throws(()=>preservedReviewedFoodBytes(path,bridge,file=>file.endsWith('.tsx')?source.replace(from,to):read(file)),from);
 }
});
test('unreviewed Food CSS drift is refused',()=>{
 assert.throws(()=>preservedReviewedFoodBytes(path,bridge,file=>file.endsWith('.css')?Buffer.concat([read(file),Buffer.from('\nbutton{display:none}')]):read(file)));
});
test('legacy Food, clients, APIs, subscriptions and unrelated routes never get transformed',()=>{
 for(const file of ['app/food/canonical-food-page.tsx','lib/food-client.ts','lib/food-subscription-client.ts','app/api/food-commercial/route.ts','app/v2/grooming/page.tsx']){
  const bytes=read(file);assert.equal(preservedReviewedFoodBytes(file,bytes),bytes,file);
 }
});
