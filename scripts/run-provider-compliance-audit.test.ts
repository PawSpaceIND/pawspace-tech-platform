import {spawnSync} from "node:child_process";

function requireSandbox(){
 const payment=String(process.env.PAWSPACE_PAYMENT_ENV||"");
 const forbid=String(process.env.FORBID_PRODUCTION||"").toLowerCase();
 const live=String(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED||"false").toLowerCase();
 if(payment!=="sandbox")throw new Error("provider compliance audit requires PAWSPACE_PAYMENT_ENV=sandbox");
 if(forbid!=="true")throw new Error("provider compliance audit requires FORBID_PRODUCTION=true");
 if(live!=="false")throw new Error("provider compliance audit requires PAWSPACE_PAYMENT_LIVE_APPROVED=false");
}

requireSandbox();
const suites=[
 "tests/provider-canonical-lifecycle.test.ts",
 "tests/provider-lifecycle-d1.test.ts",
 "tests/provider-lifecycle-hardening.test.mjs",
 "tests/grooming-provider-journey-closure.test.mjs",
 "tests/walking-taxi-ops-hardening.test.mjs",
 "tests/stay-lifecycle-hardening.test.mjs",
 "tests/training-hardening.test.mjs",
 "tests/provider-commission-governance.test.mjs",
 "tests/partner-settlement-payout-governance.test.mjs",
 "tests/ptja-w3-terminal-booking-states.test.mjs",
];
const result=spawnSync(process.execPath,["--experimental-strip-types","--test","--test-concurrency=1",...suites],{stdio:"inherit",env:{...process.env,PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",FORBID_PRODUCTION:"true",NODE_ENV:"test",APP_ENV:"staging",PAWSPACE_LOCAL_PREVIEW:"on"}});
if(result.error)throw result.error;
process.exit(result.status??1);
