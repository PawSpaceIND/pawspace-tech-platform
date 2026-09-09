import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

test('beta Golden Path: real Grooming APIs, wallet, sandbox order contract, capture and balanced ledgers', async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'boundary', description: 'Actual route handlers and transactional SQLite D1; loopback Razorpay contract server and signed simulated callback. NOT hosted checkout, native device, or real provider delivery.' });
  const result = await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject) => {
    const child=spawn(process.execPath,['--experimental-strip-types','scripts/e2e/beta-golden-path.mjs'],{
      cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',APP_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'},
      stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),150_000);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
  });
  await writeFile(testInfo.outputPath('beta-contract-run.txt'),result.stdout+'\n'+result.stderr);
  await testInfo.attach('isolated-contract-log',{path:testInfo.outputPath('beta-contract-run.txt'),contentType:'text/plain'});
  expect(result.code,result.stdout+'\n'+result.stderr).toBe(0);
  const line=result.stdout.split('\n').find(value=>value.startsWith('BETA_GOLDEN_RESULT='));
  expect(line,'Executable scenario must produce persisted-state evidence').toBeTruthy();
  const evidence=JSON.parse(line!.slice('BETA_GOLDEN_RESULT='.length));
  expect(evidence.mode).toBe('isolated_api_contract');
  expect(evidence.externalProviderContacted).toBe(false);
  expect(evidence.bookingPersisted).toBe(true);
  expect(evidence.gatewayCashPaise+evidence.appliedCreditPaise).toBe(evidence.bookingGrossPaise);
  expect(evidence.paymentCaptured).toBe(true);
  expect(evidence.captureJournalBalanced).toBe(true);
  expect(evidence.refundJournalBalanced).toBe(true);
});
