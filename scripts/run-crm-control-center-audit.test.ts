import { spawnSync } from "node:child_process";
import process from "node:process";

function fail(message:string):never{
  console.error(`[crm-control-center-audit] ${message}`);
  process.exit(1);
}

if(process.env.PAWSPACE_PAYMENT_ENV!=="sandbox")fail("PAWSPACE_PAYMENT_ENV must be sandbox");
if(process.env.FORBID_PRODUCTION!=="true")fail("FORBID_PRODUCTION must be true");
if(String(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED??"false").toLowerCase()==="true")fail("live payment approval must be disabled");
if(String(process.env.PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED??"false").toLowerCase()==="true")fail("external marketing writes must be disabled");

const runs:[string,string[]][]=[
  [process.execPath,["--experimental-strip-types","--test","--test-concurrency=1","tests/crm-control-center-audit.test.mjs","tests/booking-command-center-authorization-boundary.test.mjs","tests/people-foundation.test.mjs"]],
  [process.platform==="win32"?"npm.cmd":"npm",["--prefix","backend","test"]],
];

for(const[command,args]of runs){
  const result=spawnSync(command,args,{stdio:"inherit",env:{...process.env,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED:"false",NODE_ENV:"test",APP_ENV:"staging"}});
  if(result.error)fail(result.error.message);
  if(result.status!==0)process.exit(result.status??1);
}

console.log("[crm-control-center-audit] PASS: CRM, Control Center and employee remediation gates are green under sandbox isolation");
