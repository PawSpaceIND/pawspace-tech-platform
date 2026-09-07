import {spawnSync} from "node:child_process";
const required={PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",NODE_ENV:"test",APP_ENV:"staging"};
for(const [key,value] of Object.entries(required))if(process.env[key]!==value)throw new Error(`${key} must equal ${value}`);
const nodeArgs=["--experimental-strip-types","--test","--test-concurrency=1","tests/performance-load-remediation.test.mjs","tests/schema-query-plan.test.mjs","tests/uat-scheduling-d1-contention.test.mjs"];
const local=spawnSync(process.execPath,nodeArgs,{stdio:"inherit",env:process.env});
if(local.status!==0)process.exit(local.status??1);
if(process.env.PERFORMANCE_LOAD_HOSTED==="true"){
  for(const key of["STAGING_URL","PAWSPACE_UAT_ACCESS_CODE","RAZORPAY_WEBHOOK_SECRET_SANDBOX"])if(!process.env[key])throw new Error(`${key} is required for hosted performance certification`);
  const hosted=spawnSync(process.execPath,["scripts/ops/staging-performance-gate.mjs"],{stdio:"inherit",env:process.env});
  if(hosted.status!==0)process.exit(hosted.status??1);
}else console.log("Hosted load phase skipped; set PERFORMANCE_LOAD_HOSTED=true inside isolated staging certification.");
