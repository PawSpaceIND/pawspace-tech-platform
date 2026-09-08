import {expect,test} from '@playwright/test';

test('CX operator recovers a failed message with an auditable reason',async({page,request})=>{
 const headers={'oai-authenticated-user-email':'e2e.admin@pawspace.test'};
 await page.setExtraHTTPHeaders(headers);
 const enqueue=await request.post('/api/communications',{headers,data:{action:'enqueue',customerId:'E2E-CUS-UI-001',cityId:'blr',channel:'chat',purpose:'transactional',bookingId:'E2E-BK-UI-001',idempotencyKey:`recovery-ui-${Date.now()}`,templateKey:'recovery_demo',payload:{title:'Recovery demo'}}});
 expect(enqueue.ok(),await enqueue.text()).toBeTruthy();const messageId=(await enqueue.json()).data.messageId;
 for(let i=0;i<5;i++){const failed=await request.post('/api/communications',{headers,data:{action:'fail_attempt',messageId,reason:'not_configured'}});expect(failed.ok(),await failed.text()).toBeTruthy();}
 await page.goto('/team/customer-experience');
 const recovery=page.getByRole('region',{name:'Delivery recovery'});
 await recovery.getByRole('button',{name:'Review failed messages',exact:true}).click();
 await recovery.locator('div').filter({hasText:messageId}).getByRole('button',{name:'Review recovery',exact:true}).click();
 await recovery.getByLabel('What was corrected?',{exact:true}).fill('Validated sandbox routing before the next retry');
 await recovery.getByRole('button',{name:'Requeue message',exact:true}).click();
 await expect(recovery.getByRole('status')).toHaveText('Message requeued. Delivery will be verified separately.');
 const view=await request.get('/api/communications',{headers});expect(view.ok()).toBeTruthy();const body=await view.json();
 expect(body.data.deadLetters.some((row:{message_id:string})=>row.message_id===messageId)).toBe(false);
 expect(body.data.outbox.find((row:{message_id:string})=>row.message_id===messageId).status).toBe('queued');
});
