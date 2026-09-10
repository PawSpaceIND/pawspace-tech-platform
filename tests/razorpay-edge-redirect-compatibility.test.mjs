import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RAZORPAY_EDGE_REDIRECT_DB__", "__RAZORPAY_EDGE_REDIRECT_ENV__");
const { createPaymentOrderPaise, createPaymentRefund, createSandboxPaymentLink } = await import("../lib/razorpay-client.ts");
const { fetchRazorpaySettlementReconDate } = await import("../lib/razorpay-settlement-reconciliation.ts");

const env={
  PAWSPACE_PAYMENT_ENV:"sandbox",
  PAWSPACE_PAYMENT_LIVE_APPROVED:"false",
  RAZORPAY_KEY_ID_SANDBOX:"rzp_test_edgecompat",
  RAZORPAY_KEY_SECRET_SANDBOX:"edge-test-secret",
};

test("Razorpay Worker-runtime requests use a Cloudflare-compatible non-following redirect mode",async()=>{
  const original=globalThis.fetch,redirects=[];
  globalThis.fetch=async(url,init={})=>{
    redirects.push(init.redirect);
    if(init.redirect==="error")throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    const path=new URL(String(url)).pathname;
    if(path==="/v1/orders")return Response.json({id:"order_edgecompat",amount:100,currency:"INR",status:"created"});
    if(path==="/v1/payments/pay_edgecompat/refund")return Response.json({id:"rfnd_edgecompat",amount:100,currency:"INR",status:"processed"});
    if(path==="/v1/payment_links")return Response.json({id:"plink_edgecompat",short_url:"https://rzp.io/i/edgecompat",expire_by:Math.floor(Date.now()/1000)+3600});
    if(path==="/v1/settlements/recon/combined")return Response.json({items:[]});
    throw new Error(`Unexpected Razorpay test URL: ${path}`);
  };
  try{
    const order=await createPaymentOrderPaise(env,{bookingId:"BK-EDGE-1",paymentId:"PAY-EDGE-1",amountPaise:100,currency:"INR"});
    assert.equal(order.connected,true,order.connected?undefined:order.reason);
    const refund=await createPaymentRefund(env,{bookingId:"BK-EDGE-1",paymentId:"PAY-EDGE-1",gatewayPaymentId:"pay_edgecompat",refundCaseId:"REF-EDGE-1",amount:1,currency:"INR"});
    assert.equal(refund.connected,true,refund.connected?undefined:refund.reason);
    const link=await createSandboxPaymentLink(env,{bookingId:"BK-EDGE-1",paymentId:"PAY-EDGE-1",referenceId:"REF-EDGE-LINK",customerId:"CUS-EDGE",amount:1,currency:"INR",expiresAt:Date.now()+3600000});
    assert.equal(link.connected,true,link.connected?undefined:link.reason);
    const recon=await fetchRazorpaySettlementReconDate(env,"2026-09-10");
    assert.equal(recon.connected,true,recon.connected?undefined:recon.reason);
    assert.deepEqual(redirects,["manual","manual","manual","manual"]);
  }finally{globalThis.fetch=original;}
});
