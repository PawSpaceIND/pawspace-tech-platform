import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAY_PAYMENT_CARE_DB__','__STAY_PAYMENT_CARE_ENV__');
const React=await import('react');
const {renderToStaticMarkup}=await import('react-dom/server');
const {default:Gate}=await import('../app/mobile-app/stay-care-payment-gate.tsx');
const {default:Payment,completeVerifiedPayment}=await import('../app/mobile-app/booking-payment-page.tsx');
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
function findPayment(element){
 if(!React.isValidElement(element))return null;
 if(element.type===Payment)return element;
 for(const child of React.Children.toArray(element.props.children)){const found=findPayment(child);if(found)return found;}
 return null;
}
for(const mode of ['boarding','sitting'])test(`${mode}: empty care reaches the existing payment component and verified payment completes the same booking`,async(t)=>{
 let completed=0;
 const onVerified=()=>{completed++;};
 const payment={bookingId:'synthetic-stay-payment',serviceName:mode,total:1200,dueNow:1200,mode:'prepaid'};
 const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
 globalThis.fetch=async(url,init)=>{
  assert.equal(url,'/api/customer-checkout');assert.deepEqual(JSON.parse(init.body),{action:'status',bookingId:payment.bookingId});
  return Response.json({data:{bookingId:payment.bookingId,environment:'sandbox',confirmation:{bookingId:payment.bookingId,ready:true,paymentStatus:'captured',carePlan:null}}});
 };
 const element=Gate({mode,payment,carePlan:{},onVerified,routeScope:'v2'});
 const child=findPayment(element);
 assert.ok(child,'missing care must not replace payment with a care-save retry gate');
 assert.equal(child.props.bookingId,payment.bookingId);
 assert.equal(child.props.totalAmount,1200);assert.equal(child.props.amountDueNow,1200);
 assert.equal(child.props.returnAfterVerified,false,'remain in the flow so its post-payment Care Card opens');
 assert.equal(child.props.onVerified,onVerified);
 await completeVerifiedPayment(child.props);
 assert.equal(completed,1);
 const markup=renderToStaticMarkup(element);
 assert.match(markup,/Complete payment first, then add your Care Card/);
 assert.match(markup,/before service starts/);
 assert.doesNotMatch(markup,/Save care instructions before payment|Retry saving care instructions/);
});
test('payment with an unready canonical projection cannot open post-payment care',async(t)=>{
 const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});let completed=0;
 globalThis.fetch=async()=>Response.json({data:{bookingId:'synthetic-unready',environment:'sandbox',confirmation:{bookingId:'synthetic-unready',ready:false}}});
 await assert.rejects(completeVerifiedPayment({bookingId:'synthetic-unready',returnAfterVerified:false,onVerified:()=>{completed++;}}),/still synchronizing/);
 assert.equal(completed,0);
});
test('Boarding unpriced host requests remain excluded from the governed payment amount',()=>{
 const payment={bookingId:'synthetic-host-request',serviceName:'Boarding',total:1200,dueNow:600,mode:'split_50_50'};
 const element=Gate({mode:'boarding',payment,carePlan:{},onVerified:()=>{},hostRequests:['Basic grooming']});
 const child=findPayment(element);assert.equal(child.props.totalAmount,1200);assert.equal(child.props.amountDueNow,600);
 const markup=renderToStaticMarkup(element);assert.match(markup,/Basic grooming/);assert.match(markup,/not included|not part|excluded/i);
});
test('customer flow moves mandatory care and introductions after verified payment without changing server start guards',()=>{
 const flow=read('app/mobile-app/stay-flow.tsx'),gate=read('app/mobile-app/stay-care-payment-gate.tsx');
 assert.doesNotMatch(flow,/if\(missingStayCareFields\(mode,careDraft\)\.length\)/);
 assert.match(flow,/onVerified=\{\(\)=>\{setCareSaveError\(""\);setView\("care"\);setPendingPayment\(null\);setConfirmed\(true\);\}\}/);
 assert.doesNotMatch(flow.split('function LiveStay')[0],/<StayMeetingRequest/,'no introduction request before payment');
 assert.match(flow.split('function LiveStay')[1],/<StayMeetingRequest/);
 assert.doesNotMatch(flow,/Host to quote food separately|Create stay request & review payment/);
 assert.doesNotMatch(gate,/saveCustomerBoardingCare|saveSittingCustomerPlan|useEffect/,'payment cannot depend on an initial care mutation');
 assert.match(read('lib/boarding-stay-lifecycle.ts'),/care_plan_required/);
 assert.match(read('lib/sitting-lifecycle.ts'),/sitting_care_plan_required/);
});
