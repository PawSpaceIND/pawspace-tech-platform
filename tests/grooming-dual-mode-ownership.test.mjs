import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { transitionOwnership, issueWorkTicket, assertWorkBoundary, advanceTerms,
  assertFreshConfirmation, canonicalSendKey, assertSendCanBeClaimed,
  generateOwnedReply, effectiveOwnership } from '../lib/grooming-dual-mode-ownership.ts';

const ai = {kind:'ai',id:'atlas'}, employee = {kind:'employee',id:'cx-1'};
const controls = {revision:'controls-1',goalMode:'execute_within_envelope',verticalEnabled:true,
  customerAiAllowed:true,staffAiAllowed:true,modelEnabled:true,handoffPaused:false,whatsappMode:'ai_assistant'};
// This is a local adapter contract proof, not the production canonical booking implementation.
function world(phase='lead') {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ownership (thread_id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE commands (id TEXT PRIMARY KEY, result TEXT NOT NULL);
    CREATE TABLE sends (key TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, thread_id TEXT UNIQUE NOT NULL);
    CREATE TABLE canonical_orders (id TEXT PRIMARY KEY, booking_id TEXT UNIQUE NOT NULL);`);
  let currentControls = {...controls};
  const state = {threadId:'thread-1',leadId:'lead-1',customerId:'customer-1',serviceCode:'grooming',
    version:0,mode:'atlas_led',employeeId:null,phase,bookingId:phase==='lead'||phase==='quoted'?null:'booking-1',
    orderId:phase==='pending_payment'||phase==='booked'?'order-1':null,termsVersion:1,confirmedTermsVersion:1};
  db.prepare('INSERT INTO ownership VALUES (?,?,?)').run(state.threadId,0,JSON.stringify(state));
  if(state.bookingId)db.prepare('INSERT INTO canonical_bookings VALUES (?,?)').run(state.bookingId,state.threadId);
  if(state.orderId)db.prepare('INSERT INTO canonical_orders VALUES (?,?)').run(state.orderId,state.bookingId);
  const readState=()=>JSON.parse(db.prepare('SELECT state FROM ownership').get().state);
  const save=(next,version)=>{
    const result=db.prepare('UPDATE ownership SET state=?,version=? WHERE thread_id=? AND version=?')
      .run(JSON.stringify(next),next.version,next.threadId,version);
    if(result.changes!==1)throw new Error('CAS lost');
  };
  const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}
    catch(error){db.exec('ROLLBACK');throw error;}};
  const change=(expected,mode,id)=>transaction(()=>{const next=transitionOwnership(readState(),expected,mode,id);save(next,expected);return next;});
  const port={read:async()=>({state:readState(),controls:currentControls}),
    commit:async(ticket,boundary,id)=>transaction(()=>{
      const state=readState();assertWorkBoundary(state,currentControls,ticket,boundary);
      const old=db.prepare('SELECT result FROM commands WHERE id=?').get(id);if(old)return JSON.parse(old.result);
      let next=state;
      if(boundary==='discretionary_send') {
        const key=canonicalSendKey(state,id), old=db.prepare('SELECT * FROM sends WHERE key=?').get(key);
        assertSendCanBeClaimed(old??null);
        db.prepare('INSERT INTO sends VALUES (?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status').run(key,'claimed');
      } else {
        assertFreshConfirmation(state,state.termsVersion);
        db.prepare('INSERT OR IGNORE INTO canonical_bookings VALUES (?,?)').run('booking-1',state.threadId);
        db.prepare('INSERT OR IGNORE INTO canonical_orders VALUES (?,?)').run('order-1','booking-1');
        next={...state,phase:'pending_payment',bookingId:'booking-1',orderId:'order-1'};save(next,state.version);
      }
      db.prepare('INSERT INTO commands VALUES (?,?)').run(id,JSON.stringify(next));return next;
    })};
  return {db,readState,change,port,save,transaction,
    ticket:(actor=ai,boundary='tool_commit')=>issueWorkTicket(readState(),currentControls,actor,boundary),
    setControls:value=>{currentControls=value;}};
}

for(const phase of ['lead','quoted','reserved','pending_payment'])test(`AI -> employee -> AI at ${phase} rejects stale work and preserves canonical identity`,async()=>{
  const w=world(phase), initial=w.readState(),old=w.ticket();
  w.change(0,'employee_led',employee.id);
  await assert.rejects(()=>w.port.commit(old,'tool_commit','reserve'),/Stale ownership/);
  const staff=w.ticket(employee);await w.port.commit(staff,'tool_commit','reserve');
  w.change(1,'atlas_led',null);
  await assert.rejects(()=>w.port.commit(old,'discretionary_send','reply'),/Stale ownership/);
  const resumed=w.ticket();await w.port.commit(resumed,'tool_commit','reserve');
  const final=w.readState();assert.equal(final.threadId,initial.threadId);assert.equal(final.leadId,initial.leadId);
  assert.equal(final.bookingId,'booking-1');assert.equal(final.orderId,'order-1');assert.equal(final.version,2);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM ownership').get().n,1);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,1);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM canonical_orders').get().n,1);w.db.close();
});

test('concurrent takeover has one CAS winner; stale commit cannot mutate or claim a send',async()=>{
  const w=world(),old=w.ticket();
  const results=await Promise.allSettled([Promise.resolve().then(()=>w.change(0,'employee_led','cx-1')),
    Promise.resolve().then(()=>w.change(0,'employee_led','cx-2'))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(()=>w.port.commit(old,'tool_commit','reserve'),/Stale ownership/);
  await assert.rejects(()=>w.port.commit(old,'discretionary_send','reply'),/Stale ownership/);
  for(const table of ['commands','sends','canonical_bookings','canonical_orders'])
    assert.equal(w.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);w.db.close();
});

test('takeover during generation discards completed reply even after AI resumes',async()=>{
  const w=world(),ticket=w.ticket(ai,'generation');let resolve,started;
  const begun=new Promise(r=>{started=r;});
  const generated=generateOwnedReply(w.port,ticket,()=>{started();return new Promise(r=>{resolve=r;});});
  await begun;w.change(0,'employee_led',employee.id);w.change(1,'atlas_led',null);resolve('stale reply');
  await assert.rejects(()=>generated,/Stale ownership/);assert.equal(w.db.prepare('SELECT COUNT(*) n FROM sends').get().n,0);w.db.close();
});

test('changed controls invalidate work, including an off/on cycle',async()=>{
  const w=world(),ticket=w.ticket();w.setControls({...controls,revision:'controls-3'});
  await assert.rejects(()=>w.port.commit(ticket,'tool_commit','reserve'),/Stale ownership/);w.db.close();
});

test('employee continuation works with models, rollout and vertical execution off',async()=>{
  const w=world();w.change(0,'employee_led',employee.id);
  w.setControls({...controls,revision:'off',modelEnabled:false,customerAiAllowed:false,verticalEnabled:false,
    goalMode:'recommend',handoffPaused:true,whatsappMode:'human_only'});
  assert.equal(effectiveOwnership(w.readState(),(await w.port.read()).controls).aiAllowed,false);
  await w.port.commit(w.ticket(employee),'tool_commit','reserve');
  await w.port.commit(w.ticket(employee,'discretionary_send'),'discretionary_send','reply');
  assert.throws(()=>w.ticket({...employee,id:'other'}),/not the effective owner/);w.db.close();
});

test('existing stricter AI guards cannot be overridden by atlas-led mode',()=>{
  const w=world(),state=w.readState();
  for(const override of [{verticalEnabled:false},{customerAiAllowed:false},{modelEnabled:false},
    {handoffPaused:true},{whatsappMode:'human_only'},{whatsappMode:'chatbot_only'}])
    assert.throws(()=>issueWorkTicket(state,{...controls,...override},ai,'generation'),/Existing AI controls/);
  for(const goalMode of ['recommend','approval_required']) {
    issueWorkTicket(state,{...controls,goalMode},ai,'generation');
    for(const boundary of ['tool_commit','discretionary_send'])
      assert.throws(()=>issueWorkTicket(state,{...controls,goalMode},ai,boundary),/Existing AI controls/);
  }w.db.close();
});

test('changed terms after reservation require fresh confirmation and invalidate prior work',async()=>{
  const w=world('reserved'),old=w.ticket(),state=w.readState(),next=advanceTerms(state);w.save(next,state.version);
  assert.equal(next.bookingId,state.bookingId);assert.equal(next.confirmedTermsVersion,null);
  await assert.rejects(()=>w.port.commit(old,'tool_commit','pay'),/Stale ownership/);
  await assert.rejects(()=>w.port.commit(w.ticket(),'tool_commit','pay'),/fresh customer confirmation/);
  w.save({...next,confirmedTermsVersion:next.termsVersion},next.version);
  await w.port.commit(w.ticket(),'tool_commit','pay');w.db.close();
});

test('canonical send intent deduplicates across ownership; uncertain external outcome blocks retry',async()=>{
  const w=world(),key=canonicalSendKey(w.readState(),'reply');
  await Promise.all([w.port.commit(w.ticket(),'discretionary_send','reply'),w.port.commit(w.ticket(),'discretionary_send','reply')]);
  w.db.prepare("UPDATE sends SET status='uncertain' WHERE key=?").run(key);
  w.change(0,'employee_led',employee.id);assert.equal(canonicalSendKey(w.readState(),'reply'),key);
  await w.port.commit(w.ticket(employee,'discretionary_send'),'discretionary_send','reply');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM sends').get().n,1);
  for(const status of ['claimed','sent','uncertain'])assert.throws(()=>assertSendCanBeClaimed({key,status}),/reconciled/);
  assertSendCanBeClaimed({key,status:'not_sent'});assertSendCanBeClaimed(null);w.db.close();
});

test('payment reconciliation remains canonical while employee owns a pending payment',()=>{
  const w=world('pending_payment');w.change(0,'employee_led',employee.id);
  // Callbacks do not invoke an AI discretionary gate. Production callback is unchanged.
  const current=w.readState();w.save({...current,phase:'booked'},current.version);
  assert.equal(w.readState().mode,'employee_led');assert.equal(w.readState().orderId,'order-1');w.db.close();
});

 test('employee-led assistance stays internal and cannot grant Atlas customer send rights',async()=>{
  const w=world();w.change(0,'employee_led',employee.id);
  w.setControls({...controls,revision:'staff-only',customerAiAllowed:false,handoffPaused:true,
    whatsappMode:'human_only',goalMode:'recommend'});
  const ticket=w.ticket(employee,'generation');
  assert.equal(await generateOwnedReply(w.port,ticket,async()=> 'Internal draft'),'Internal draft');
  assert.throws(()=>w.ticket(ai,'discretionary_send'),/Existing AI controls/);
  w.setControls({...controls,revision:'models-off',modelEnabled:false});
  assert.throws(()=>w.ticket(employee,'generation'),/assistance is disabled/);w.db.close();
});
