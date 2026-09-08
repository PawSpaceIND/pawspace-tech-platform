import {spawnSync} from "node:child_process";

function requireSandbox(){
 const payment=String(process.env.PAWSPACE_PAYMENT_ENV||"");
 const live=String(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED||"false").toLowerCase();
 if(payment!=="sandbox")throw new Error("capacity closure requires PAWSPACE_PAYMENT_ENV=sandbox");
 if(live!=="false")throw new Error("capacity closure requires PAWSPACE_PAYMENT_LIVE_APPROVED=false");
}

requireSandbox();
const suites=[
 "tests/provider-availability-write-ownership.test.mjs",
 "tests/boarding-reservation-authority.test.mjs",
 "tests/ptja-w1-f27-roster-authority.test.mjs",
 "tests/ops-intelligence.test.mjs",
 "tests/scheduling-reservation-leases.test.mjs",
 "tests/uat-scheduling-reservation-ownership-runtime.test.mjs",
];
const result=spawnSync(process.execPath,["--experimental-strip-types","--test","--test-concurrency=1",...suites],{stdio:"inherit",env:{...process.env,PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE:"on",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",FORBID_PRODUCTION:"true",NODE_ENV:"test",APP_ENV:"staging",PAWSPACE_LOCAL_PREVIEW:"on"}});
if(result.error)throw result.error;
process.exit(result.status??1);
