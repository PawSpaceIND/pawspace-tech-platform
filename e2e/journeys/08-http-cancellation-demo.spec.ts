import {expect,test} from '@playwright/test';
import {runGroomingDemo} from '../helpers/correlated-grooming';
import {runCancellationRefundRecovery} from '../helpers/cancellation-refund-recovery';

test('connected cancellation: failed refund recovers, reconciles and stays replay-safe',async({baseURL})=>{
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const cancellation=await runGroomingDemo(baseURL!,`${Date.now()}-cancel-demo`,Number(process.env.E2E_DEMO_DAY_OFFSET||13),'cancel');
  const recovery=await runCancellationRefundRecovery(baseURL!,cancellation);
  const result={cancellation,recovery};
  console.log(JSON.stringify(result));
  await test.info().attach('cancellation-demo',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});
