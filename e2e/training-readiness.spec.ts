import {test,expect} from '@playwright/test';
// Actual React page/handlers; all API identities/receipts are isolated fixtures, never hosted UAT.
test('trainer leaves scores unassessed, retains drafts and completes only after explicit assessment',async({page},info)=>{
 const state={progress:{} as Record<string,number|null>,status:'in_session',completions:0};
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const session=()=>({id:'TS-READINESS',programme_id:'TP-READINESS',booking_id:'B-READINESS',sequence_no:1,provider_id:'TRAINER-READINESS',scheduled_start:'2026-10-02T05:30:00Z',scheduled_end:'2026-10-02T06:30:00Z',status:state.status,customer_id:'CUSTOMER-READINESS',customer_name:'Synthetic customer',plan_code:'starter',plan_name:'Readiness assessment fixture',total_sessions:1,completed_sessions:state.completions,no_show_sessions:0,cancelled_sessions:0,programme_status:'in_progress',petIds:['PET'],requirements:[],attendance:{mode:'parent',parentOrCaretakerConfirmed:true,safeAreaConfirmed:true},homework:{text:'Practise calmly for ten minutes each day'},progress:state.progress,evidenceRefs:['media://asset/before','media://asset/after'],ownerHandover:{durationMinutes:15,completedAt:1},events:[]});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;let data:unknown={};
  if(path==='/api/identity-session')data={subjectType:'provider',subjectId:'TRAINER-READINESS'};
  if(path==='/api/provider-public-profile')data={displayName:'Synthetic trainer'};
  if(path==='/api/training-session-media')data={assets:['before_service','after_service'].map(purpose=>({id:purpose,ref:`media://asset/${purpose}`,purpose,proofReady:true,scan_status:'clean',access_status:'ready',review_status:'approved',retention_status:'active',objectStored:true}))};
  if(path==='/api/training-sessions'){
   if(route.request().method()==='POST'){
    const body=route.request().postDataJSON();expect(body.sessionId).toBe('TS-READINESS');
    if(body.action==='save_report')state.progress=body.report.progress;
    else if(body.action==='complete'){expect(body.report.progress).toEqual({focus:8,recall:null,impulse:null,parent:null});state.completions++;state.status='completed';}
    else throw new Error(`Unexpected mutation ${body.action}`);
    data={status:state.status};
   }else data=[session()];
  }
  await route.fulfill({json:{data}});
 });
 await page.goto('/v2/partner/trainer');
 await expect(page.getByRole('heading',{name:'Your canonical training sessions'})).toBeVisible();
 await expect(page.getByLabel('Focus score')).toHaveValue('');
 await expect(page.getByLabel('Recall score')).toHaveValue('');
 const complete=page.getByRole('button',{name:'Complete & consume one session'});await expect(complete).toBeDisabled();
 await page.getByRole('button',{name:'Save report',exact:true}).click();
 await expect.poll(()=>state.progress).toEqual({focus:null,recall:null,impulse:null,parent:null});
 await page.reload();await expect(page.getByLabel('Focus score')).toHaveValue('');await expect(complete).toBeDisabled();
 await page.getByLabel('Focus score').selectOption('8');await expect(complete).toBeEnabled();
 await page.screenshot({path:info.outputPath('explicit-assessment.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await complete.click();await expect(page.getByRole('heading',{name:'Session completed canonically'})).toBeVisible();
 expect(state.completions).toBe(1);expect(errors).toEqual([]);
});
