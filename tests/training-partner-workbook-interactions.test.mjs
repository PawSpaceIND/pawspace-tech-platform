import test from 'node:test';
import assert from 'node:assert/strict';
import {trainerUi} from './helpers/trainer-ui-interactions.mjs';
const attendance={mode:'parent',safeAreaConfirmed:true,parentOrCaretakerConfirmed:true};
const row=(id='S1',extra={})=>({id,booking_id:'B'+id,programme_id:'P'+id,provider_id:'TRAINER',status:'arrived',providerModel:'commission',plan_name:'Programme '+id,customer_name:'Customer '+id,sequence_no:1,total_sessions:4,completed_sessions:0,requirements:[],progress:{focus:6},homework:{text:'Practise recall daily'},attendance,events:[],scheduled_start:'2099-01-01T05:30:00.000Z',...extra});
const proof=(purpose,extra={})=>({id:purpose,sessionId:'S1',purpose,access_status:'ready',retention_status:'active',review_status:'approved',proofReady:true,objectStored:true,...extra});
const work=extra=>trainerUi({rows:[row()],path:'/trainer/session',query:'bookingId=BS1&sessionId=S1',...extra});

test('clicked job details belong directly to that job and link to its exact separate execution page',async()=>{
 const app=trainerUi({rows:[row(),row('S2')]});await app.settle();
 const second=app.nodes('button').find(n=>n.props['aria-controls']==='job-detail-S2');await second.props.onClick();await app.settle();
 const card=app.nodes('div').find(n=>n.props.className==='jobCard'&&app.textOf(n).includes('Programme S2'));
 assert.equal(card.children[0].type,'button');assert.equal(card.children[1].props.id,'job-detail-S2');assert.equal(app.nodes('div').some(n=>n.props.id==='job-detail-S1'),false);
 const link=app.nodes('a').find(n=>app.textOf(n)==='Open session work');assert.equal(link.props.href,'/trainer/session?bookingId=BS2&sessionId=S2');assert.equal(app.button('Save attendance & safety'),undefined);assert.equal(app.input('Before photo'),undefined);
});
test('focused classic and v2 views expose only the requested owned session; foreign or missing request has no fallback',async()=>{
 for(const path of ['/trainer/session','/v2/partner/trainer/session']){const app=work({rows:[row(),row('S2')],path});await app.settle();assert.match(app.text(),/Programme S1/);assert.doesNotMatch(app.text(),/Programme S2/);assert.equal(app.button('₹ Earnings'),undefined);assert.equal(app.nodes('a').find(n=>app.textOf(n)==='Back to your jobs').props.href,path.startsWith('/v2')?'/v2/partner/trainer':'/trainer');}
 for(const query of ['','sessionId=FOREIGN','bookingId=FOREIGN&sessionId=S1']){const app=work({query});await app.settle();assert.match(app.text(),/Session unavailable/);assert.equal(app.button('Start session'),undefined);assert.equal(app.input('Before photo'),undefined);}
});
test('arrived attendance save enables only before capture; captured quarantined proof then enables Start',async()=>{
 const app=work({rows:[row('S1',{attendance:{}})]});await app.settle();assert.equal(app.input('Before photo').props.disabled,true);assert.equal(app.input('After photo'),undefined);assert.equal(app.input('Training video'),undefined);assert.equal(app.button('Start session').props.disabled,true);
 const checkboxes=app.nodes('input').filter(n=>n.props.type==='checkbox');for(const n of checkboxes)n.props.onChange({target:{checked:true}});await app.settle();await app.click('Save attendance & safety');
 assert.deepEqual(app.calls.find(c=>c.action==='save_report'),{sessionId:'S1',action:'save_report',report:{attendance}});assert.equal(app.input('Before photo').props.disabled,false);assert.equal(app.button('Start session').props.disabled,true);
 app.input('Before photo').props.onChange({target:{files:[{name:'before.jpg'}]},currentTarget:{value:'before.jpg'}});await app.settle();assert.equal(app.calls.find(c=>c.action==='upload').purpose,'before_service');assert.equal(app.button('Start session').props.disabled,false);await app.click('Start session');assert.equal(app.calls.find(c=>c.action==='start').sessionId,'S1');assert.equal(app.input('Before photo'),undefined);assert.equal(app.input('After photo').props.disabled,true);
});
test('after capture appears after handover and stays disabled until the handover is saved',async()=>{
 const app=work({rows:[row('S1',{status:'in_session'})],assets:[proof('before_service')]});await app.settle();assert.equal(app.input('Before photo'),undefined);assert.equal(app.input('After photo').props.disabled,true);await app.change('Handover minutes','8');await app.change('Confirm handover completed',true);await app.click('Confirm completed handover');assert.equal(app.calls.find(c=>c.action==='owner_handover').ownerHandoverMinutes,8);assert.equal(app.input('After photo').props.disabled,false);assert.ok(app.text().indexOf('OWNER HANDOVER')<app.text().indexOf('After photo'));assert.ok(app.input('Training video'));
});
test('saved handover minutes can be edited twice with reconfirmation, and completion removes the editor',async()=>{
 const app=work({rows:[row('S1',{status:'in_session',ownerHandover:{durationMinutes:10,completedAt:100}})],assets:[proof('before_service'),proof('after_service')]});await app.settle();assert.equal(app.input('Handover minutes').props.value,'10');assert.equal(app.button('Update handover').props.disabled,true);
 for(const minutes of ['20','12']){await app.change('Confirm handover completed',true);await app.change('Handover minutes',minutes);assert.equal(app.button('Update handover').props.disabled,true);await app.change('Confirm handover completed',true);await app.click('Update handover');assert.equal(app.input('Handover minutes').props.value,minutes);}
 assert.deepEqual(app.calls.filter(c=>c.action==='owner_handover').map(c=>[c.sessionId,c.ownerHandoverMinutes,c.ownerHandoverCompleted]),[['S1',20,true],['S1',12,true]]);await app.click('Complete & consume one session');assert.equal(app.calls.find(c=>c.action==='complete').sessionId,'S1');assert.equal(app.input('Handover minutes'),undefined);assert.equal(app.button('Update handover'),undefined);
});
test('invalid handover values cannot submit; optional duration does not invent a minimum',async()=>{
 const app=work({rows:[row('S1',{status:'in_session'})]});await app.settle();for(const value of ['-1','1.5','NaN']){await app.change('Handover minutes',value);await app.change('Confirm handover completed',true);assert.equal(app.button('Confirm completed handover').props.disabled,true);}await app.change('Handover minutes','');await app.change('Confirm handover completed',true);await app.click('Confirm completed handover');assert.equal(Object.hasOwn(app.calls.find(c=>c.action==='owner_handover'),'ownerHandoverMinutes'),false);
});
test('photo status action reloads independent review status without uploading or approving',async()=>{
 const app=work({assets:[proof('before_service',{access_status:'quarantined',review_status:'pending',proofReady:false})]});await app.settle();assert.match(app.text(),/reloads updates from the independent scan and approval review/);assert.doesNotMatch(app.text(),/Refresh photo approval/);assert.match(app.text(),/Awaiting approval/);app.data.assets[0]={...app.data.assets[0],access_status:'ready',review_status:'approved',proofReady:true};const reads=app.calls.length;await app.click('Check photo status');assert.ok(app.calls.slice(reads).every(c=>c.action==='loadEvidence'));assert.match(app.text(),/Before photo: Approved/);assert.equal(app.calls.some(c=>c.action==='upload'||c.action==='approve'),false);
});
test('full-time list controls retain direct travel without Accept; invalid capture readiness remains closed',async()=>{
 const app=trainerUi({rows:[row('S1',{status:'scheduled',providerModel:'full_time'})]});await app.settle();assert.equal(app.button('Accept'),undefined);assert.equal(app.button('On the way').props.disabled,false);await app.click('On the way');assert.equal(app.calls.find(c=>c.action==='on_the_way').sessionId,'S1');for(const access_status of ['pending_upload','revoked']){const app=work({assets:[proof('before_service',{access_status,proofReady:false})]});await app.settle();assert.equal(app.button('Start session').props.disabled,true);}
});
