import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
let bundle = '', css = '';
// Component fault-injection tests, NOT payment-provider or deployed end-to-end certification.
// The actual application components run in Chromium; only their network responses are controlled.
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Gate from './app/mobile-app/stay-care-payment-gate';
    import Payment from './app/mobile-app/booking-payment-page';
    window.auditFinishCalls=0;
    window.renderAudit=(kind)=>createRoot(document.getElementById('root')).render(kind==='care'
      ? <Gate mode="boarding" carePlan={{vet:'Synthetic vet',emergencyContact:'Synthetic caretaker',feeding:'Owner instructions'}} payment={{bookingId:'TEST-CARE-1',serviceName:'Boarding',total:699,dueNow:699,mode:'prepaid'}} onVerified={()=>{}}/>
      : <Payment bookingId="TEST-PAY-1" serviceName="Grooming" totalAmount={1241} amountDueNow={1241} mode="prepaid" autoStart onVerified={async()=>{window.auditFinishCalls++;if(window.auditFinishCalls===1)throw new Error('Synthetic confirmation refresh outage');}}/>);
  ` }, bundle: true, write: false, outdir: '.audit-evidence/component-bundle', jsx: 'automatic', format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' });
  bundle = result.outputFiles.find(file=>file.path.endsWith('.js'))!.text; css = result.outputFiles.find(file=>file.path.endsWith('.css'))?.text || '';
});
test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!['localhost','127.0.0.1'].includes(new URL(baseURL || 'http://localhost').hostname), 'isolated fault-injection browser tests only');
  await page.route('**/__audit/paid-components', r => r.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'}));
  await page.goto('/__audit/paid-components'); await page.addScriptTag({content:bundle}); if(css)await page.addStyleTag({content:css});
});
test('a failed care write blocks checkout and retry uses only the same booking',async({page})=>{
  let saves=0, checkoutCalls=0;const submitted:unknown[]=[];
  await page.route('**/api/boarding-stays?*',r=>r.fulfill({json:{data:[{id:'STAY-TEST-1',booking_id:'TEST-CARE-1',status:'awaiting_host_acceptance'}]}}));
  await page.route('**/api/boarding-stays',r=>{
    saves++;submitted.push(r.request().postDataJSON());
    return r.fulfill(saves===1?{status:500,json:{error:'Injected care persistence outage'}}:{json:{data:{stayId:'STAY-TEST-1',bookingId:'TEST-CARE-1',status:'care_plan_ready'}}});
  });
  await page.route('**/api/customer-checkout',r=>{checkoutCalls++;return r.fulfill({status:500,json:{error:'Payment must not start during care retry'}});});
  await page.evaluate(()=>(window as unknown as {renderAudit:(s:string)=>void}).renderAudit('care'));
  await expect(page.getByRole('alert')).toContainText('Injected care persistence outage');
  await expect(page.getByRole('heading',{name:'Review payment'})).toHaveCount(0);
  await page.getByRole('button',{name:'Retry saving care instructions',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Review payment'})).toBeVisible();
  expect(saves).toBe(2);expect(submitted[0]).toEqual(submitted[1]);expect(checkoutCalls).toBe(0);
});
test('after verified payment, failed UI finalization retries confirmation without another Checkout',async({page})=>{
  const calls:string[]=[];
  await page.evaluate(()=>{
    (window as unknown as {Razorpay:unknown}).Razorpay=class {
      options:{handler:(receipt:Record<string,string>)=>void};
      constructor(options:{handler:(receipt:Record<string,string>)=>void}){this.options=options;}
      on(){} open(){this.options.handler({razorpay_order_id:'order_component',razorpay_payment_id:'pay_component',razorpay_signature:'a'.repeat(64)});}
    };
  });
  await page.route('**/api/customer-checkout',r=>{
    const input=r.request().postDataJSON();calls.push(input.action);
    const locks={PAWSPACE_PAYMENT_ENV:'sandbox',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'};
    const data=input.action==='start'?{connected:true,bookingId:'TEST-PAY-1',environment:'sandbox',orderId:'order_component',keyId:'rzp_test_component',amountPaise:124100,currency:'INR',locks}
      :{bookingId:'TEST-PAY-1',orderId:'order_component',environment:'sandbox',receiptVerified:true,status:'captured'};
    return r.fulfill({json:{data}});
  });
  await page.evaluate(()=>(window as unknown as {renderAudit:(s:string)=>void}).renderAudit('payment'));
  await expect(page.getByRole('alert')).toContainText('Synthetic confirmation refresh outage');
  await page.getByRole('button',{name:'Retry booking confirmation',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {auditFinishCalls:number}).auditFinishCalls)).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(calls).toEqual(['start','confirm']);
});
