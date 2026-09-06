import { writeFileSync } from "node:fs";

const base=String(process.env.STAGING_URL||"").replace(/\/$/,"");
const allowlist=String(process.env.PAWSPACE_SMS_TEST_NUMBERS||"").split(",").map(value=>value.replace(/\D/g,"").replace(/^91(?=[6-9]\d{9}$)/,"")).filter(value=>/^[6-9]\d{9}$/.test(value));
if(!base)throw new Error("STAGING_URL is required");
if(!allowlist.length)throw new Error("approved SMS test number is not configured");
const candidates=["9999999998","9999999997","9999999996","9888888888"];
const unapproved=candidates.find(value=>!allowlist.includes(value));
if(!unapproved)throw new Error("no synthetic unapproved number is available for the certification probe");
const response=await fetch(`${base}/api/customer-otp`,{method:"POST",headers:{"content-type":"application/json",origin:base},body:JSON.stringify({action:"request",phone:unapproved}),signal:AbortSignal.timeout(15000)});
let body=null;try{body=await response.json();}catch{}
const serialized=JSON.stringify(body??{});
if(response.status!==403)throw new Error(`live customer OTP guard did not refuse an unapproved number (status ${response.status})`);
if(serialized.includes("sandboxCode"))throw new Error("live customer OTP response exposed sandboxCode");
if(body?.data?.liveSmsDelivered===true)throw new Error("unapproved live customer OTP probe claimed an SMS delivery");
const evidence={ok:true,status:response.status,unapprovedNumberRefused:true,sandboxCodeExposed:false,smsClaimed:false};
const out=String(process.env.EVIDENCE_PATH||"staging-live-customer-otp-certification.json");
writeFileSync(out,JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
