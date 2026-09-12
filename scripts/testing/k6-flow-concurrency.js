import http from "k6/http";
import crypto from "k6/crypto";
import{check,fail,sleep}from"k6";
import{Rate,Trend}from"k6/metrics";

const BASE=(__ENV.K6_BASE_URL||"").replace(/\/$/,"");
const BOOKING_PATH=__ENV.K6_BOOKING_PATH||"/api/canonical-bookings";
const WEBHOOK_PATH=__ENV.K6_RAZORPAY_WEBHOOK_PATH||"/api/razorpay-webhook";
const COOKIE=__ENV.K6_SESSION_COOKIE||"";
const WEBHOOK_SECRET=__ENV.K6_RAZORPAY_WEBHOOK_SECRET||"";
const BOOKING_TEMPLATE=__ENV.K6_BOOKING_PAYLOAD_JSON||"";
const bookingFailures=new Rate("booking_business_failures");
const webhookFailures=new Rate("webhook_business_failures");
const bookingLatency=new Trend("booking_flow_latency",true);
const webhookLatency=new Trend("razorpay_webhook_latency",true);

export const options={discardResponseBodies:false,scenarios:{bookings:{executor:"constant-arrival-rate",exec:"bookingFlow",rate:Number(__ENV.K6_BOOKING_RPS||20),timeUnit:"1s",duration:__ENV.K6_DURATION||"2m",preAllocatedVUs:Number(__ENV.K6_BOOKING_VUS||40),maxVUs:Number(__ENV.K6_MAX_VUS||200)},webhooks:{executor:"constant-arrival-rate",exec:"webhookFlow",rate:Number(__ENV.K6_WEBHOOK_RPS||50),timeUnit:"1s",duration:__ENV.K6_DURATION||"2m",preAllocatedVUs:Number(__ENV.K6_WEBHOOK_VUS||60),maxVUs:Number(__ENV.K6_MAX_VUS||200)}},thresholds:{http_req_failed:["rate<0.02"],booking_business_failures:["rate<0.01"],webhook_business_failures:["rate<0.01"],booking_flow_latency:["p(95)<1200","p(99)<2500"],razorpay_webhook_latency:["p(95)<800","p(99)<1800"]}};

export function setup(){if(!BASE)fail("K6_BASE_URL is required");if(!BOOKING_TEMPLATE)fail("K6_BOOKING_PAYLOAD_JSON is required; use a synthetic customer/slot fixture");if(!COOKIE)fail("K6_SESSION_COOKIE is required for the isolated UAT customer");if(!WEBHOOK_SECRET)fail("K6_RAZORPAY_WEBHOOK_SECRET is required for signed webhook load");return{};}
function unique(){return`${__VU}-${__ITER}-${Date.now()}`;}
function bookingPayload(){const payload=JSON.parse(BOOKING_TEMPLATE),tag=unique();payload.idempotencyKey=`k6-${tag}`;payload.scheduleGroupId=`k6-${tag}`;if(payload.customer?.id)payload.customer.id=`${payload.customer.id}-${tag}`;return JSON.stringify(payload);}
export function bookingFlow(){const started=Date.now(),res=http.post(`${BASE}${BOOKING_PATH}`,bookingPayload(),{headers:{"content-type":"application/json",cookie:COOKIE,origin:BASE},tags:{flow:"booking"}});bookingLatency.add(Date.now()-started);const ok=check(res,{"booking accepted or idempotent conflict":r=>[200,201,409].includes(r.status),"booking never 5xx":r=>r.status<500});bookingFailures.add(!ok);sleep(0.01);}
export function webhookFlow(){const tag=unique(),body=JSON.stringify({event:"payment.captured",created_at:Math.floor(Date.now()/1000),payload:{payment:{entity:{id:`pay_k6_${tag}`,order_id:`order_k6_${tag}`,amount:100,currency:"INR",status:"captured"}}}}),signature=crypto.hmac("sha256",WEBHOOK_SECRET,body,"hex"),started=Date.now();const res=http.post(`${BASE}${WEBHOOK_PATH}`,body,{headers:{"content-type":"application/json","x-razorpay-signature":signature,"x-razorpay-event-id":`evt_k6_${tag}`},tags:{flow:"razorpay_webhook"}});webhookLatency.add(Date.now()-started);const ok=check(res,{"webhook handled without 5xx":r=>r.status<500,"webhook bounded response":r=>String(r.body||"").length<65536});webhookFailures.add(!ok);sleep(0.01);}
