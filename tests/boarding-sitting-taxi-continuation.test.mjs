import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__BST_CONTINUATION_DB__');
const {loadVerifiedBookingReference,validateRecoveredBooking}=await import('../lib/booking-reference-recovery.ts');
const {customerTrackingHeading}=await import('../lib/customer-tracking-heading.ts');
const projection={bookingId:'AUDIT-BOOKING',serviceCode:'boarding',packageName:'Day care',bookingStatus:'payment_pending',paymentStatus:'created',totalAmount:499,ready:false};
test('BST21: recovery reads only the owned status projection and does not claim unpaid is confirmed',async t=>{
 const old=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=old;});
 globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return Response.json({data:{bookingId:projection.bookingId,environment:'sandbox',confirmation:projection}});};
 const value=await loadVerifiedBookingReference(projection.bookingId,'boarding');assert.equal(value.bookingStatus,'payment_pending');assert.equal(value.ready,false);
 assert.deepEqual(calls,[{url:'/api/customer-checkout',body:{action:'status',bookingId:'AUDIT-BOOKING'}}]);
});
test('BST21: mismatched reference, wrong service and incomplete response cannot become saved-booking claims',()=>{
 for(const bad of [{...projection,bookingId:'OTHER'},{...projection,serviceCode:'pet_taxi'},{...projection,bookingStatus:''},{...projection,totalAmount:NaN},null])assert.throws(()=>validateRecoveredBooking(bad,'AUDIT-BOOKING','boarding'));
});
test('BST21: access denial stays a failure; it does not fall back to the query string',async t=>{
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>Response.json({error:'Booking not available'},{status:403});
 await assert.rejects(loadVerifiedBookingReference('AUDIT-BOOKING','boarding'),/not available/);
});
test('BST21: server render shows verification, no untrusted saved-booking claim or service action',async()=>{
 const {renderToStaticMarkup}=await import('react-dom/server');const {default:Recovery}=await import('../app/mobile-app/booking-reference-recovery.tsx');
 const html=renderToStaticMarkup(Recovery({bookingId:'INVENTED-REFERENCE',service:'taxi',routeScope:'v2'}));
 assert.match(html,/Checking your booking reference/);assert.doesNotMatch(html,/INVENTED-REFERENCE|is saved|\/manage\?/);
});

test('BST22: absent, stale and unavailable GPS cannot be described as an approaching driver',()=>{
 for(const state of ['not_started','not_sharing','stale','unavailable','ended']){
  const title=customerTrackingHeading({serviceCode:'pet_taxi',status:'on_the_way',state});assert.doesNotMatch(title,/approaching|trip is moving|driver is on the way/i);
 }
 assert.match(customerTrackingHeading({serviceCode:'pet_taxi',status:'in_progress',state:'live'}),/trip is in progress/);
 assert.match(customerTrackingHeading({serviceCode:'pet_taxi',status:'completed',state:'live'}),/ended/);
 assert.match(customerTrackingHeading({serviceCode:'pet_taxi',status:'arrived_dropoff',state:'live'}),/reached the drop-off/);
});
test('BST23: repeated management intent keeps its key while meaningful changes get different keys',async()=>{
 const {createIntentKeyStore,intentOf}=await import('../lib/use-intent-idempotency.ts');let minted=0;const store=createIntentKeyStore('boarding-change',()=>String(++minted));
 const intent=()=>intentOf(['B1','S1','extension'],{requestedEnd:'2026-10-08T05:30:00Z'});
 const first=store.keyFor(intent());assert.equal(store.keyFor(intent()),first);assert.equal(minted,1);
 assert.notEqual(store.keyFor(intentOf(['B1','S1','extension'],{requestedEnd:'2026-10-09T05:30:00Z'})),first);
 assert.notEqual(store.keyFor(intentOf(['B2','S2','extension'],{requestedEnd:'2026-10-08T05:30:00Z'})),first);
});
test('BST23: management handlers consume intent keys rather than minting new keys on each click',()=>{
 const source=readFileSync(new URL('../app/mobile-app/boarding-customer-stay-panel.tsx',import.meta.url),'utf8');
 for(const action of ['extension','cancel','date-change'])assert.ok(source.includes('intentOf([bookingId,stay.id,"'+action+'"]'),action);
 assert.doesNotMatch(source,/extension:\$\{crypto\.randomUUID\(\)\}|cancel:\$\{crypto\.randomUUID\(\)\}|date-change:\$\{crypto\.randomUUID\(\)\}/);
 assert.match(source,/changeLock\.current=true/);
});

test('recovery offers a separate booking: the reload drops only the saved booking reference',async()=>{
 const {withoutBookingReference}=await import('../lib/booking-reference-recovery.ts');
 assert.equal(withoutBookingReference('https://pawspace.test/v2/taxi?bookingId=PS-1&sourceBookingId=BKG-9#pay'),'/v2/taxi?sourceBookingId=BKG-9#pay');
 assert.equal(withoutBookingReference('https://pawspace.test/v2/boarding?bookingId=PS-2'),'/v2/boarding');
 const view=readFileSync(new URL('../app/mobile-app/booking-reference-recovery.tsx',import.meta.url),'utf8');
 assert.match(view,/window\.location\.assign\(withoutBookingReference\(window\.location\.href\)\)/);
 assert.equal((view.match(/\{startSeparate\}/g)||[]).length,2,'both the unverified and the verified recovery screens offer a separate booking');
});
