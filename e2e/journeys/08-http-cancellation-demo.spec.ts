import {expect,test} from '@playwright/test';
import {runGroomingDemo} from '../helpers/correlated-grooming';
test('connected cancellation: captured booking double tap, one refund case and consistent admin state',async({baseURL})=>{
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const result=await runGroomingDemo(baseURL!,`${Date.now()}-cancel-demo`,Number(process.env.E2E_DEMO_DAY_OFFSET||13),'cancel');
  console.log(JSON.stringify(result));
  await test.info().attach('cancellation-demo',{body:JSON.stringify(result,null,2),contentType:'application/json'});
});
