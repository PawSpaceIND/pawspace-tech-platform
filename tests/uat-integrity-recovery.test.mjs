import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { d1 } from './helpers/execution-harness.mjs';
import { ensurePartnerSettlementTables, createSandboxPayoutInstruction, approveSandboxPayoutInstruction } from '../lib/partner-settlement-governance.ts';
import { ensureSubscriptionWalletTables, mutateSubscriptionWallet } from '../lib/subscription-wallet.ts';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
installWorkersHooks('__UAT_INTEGRITY_DB__','__UAT_INTEGRITY_ENV__');
const { detectFinanceAnomalies, forecastCashFlow } = await import('../lib/finance-intelligence-governance.ts');

async function payoutWorld(t) {
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);await ensurePartnerSettlementTables(db);
 const now=Date.now();sqlite.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,earned_amount,payable_amount,status,policy_status,approved_by,created_at,updated_at) VALUES ('S','P','2026-09',1000,1000,'approved','approved','approver',?,?)").run(now,now);
 const payout=await createSandboxPayoutInstruction(db,{statementId:'S',idempotencyKey:'key',actor:'maker'});
 return {sqlite,db,id:payout.id};
}
for(const level of [1,2]) for(const boundary of ['metadata','status','event']) test(`payout level ${level} rolls back ${boundary} failure and can retry`,async t=>{
 const {sqlite,db,id}=await payoutWorld(t);
 if(level===2)await approveSandboxPayoutInstruction(db,{instructionId:id,level:1,actor:'checker1'});
 const table=boundary==='metadata'?'partner_payout_instruction_approvals':boundary==='status'?'partner_payout_instructions':'partner_settlement_events';
 const action=boundary==='event'?'INSERT':'UPDATE';
 sqlite.exec(`CREATE TRIGGER audit_failure BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
 await assert.rejects(approveSandboxPayoutInstruction(db,{instructionId:id,level,actor:`checker${level}`}),/injected failure/);
 const row=sqlite.prepare('SELECT p.status,a.level_1_by,a.level_2_by FROM partner_payout_instructions p JOIN partner_payout_instruction_approvals a ON a.instruction_id=p.id').get();
 assert.equal(row.status,level===1?'approval_required':'awaiting_approval_2');assert.equal(row[`level_${level}_by`],null);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM partner_settlement_events').get().n,level-1);
 sqlite.exec('DROP TRIGGER audit_failure');
 await approveSandboxPayoutInstruction(db,{instructionId:id,level,actor:`checker${level}`});
 if(level===1)await assert.rejects(approveSandboxPayoutInstruction(db,{instructionId:id,level:2,actor:' CHECKER1 '}),/must differ/);
});
test('payout concurrent first checkers produce one event and one recorded checker',async t=>{
 const {sqlite,db,id}=await payoutWorld(t);
 const results=await Promise.allSettled(['a','b'].map(actor=>approveSandboxPayoutInstruction(db,{instructionId:id,level:1,actor})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM partner_settlement_events').get().n,1);
 const row=sqlite.prepare('SELECT level_1_by FROM partner_payout_instruction_approvals').get();assert.ok(['a','b'].includes(row.level_1_by));
});
test('payout legacy partial approval without first checker cannot advance',async t=>{
 const {sqlite,db,id}=await payoutWorld(t);sqlite.exec("UPDATE partner_payout_instructions SET status='awaiting_approval_2'");
 await assert.rejects(approveSandboxPayoutInstruction(db,{instructionId:id,level:2,actor:'other'}),/recorded level 1/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM partner_settlement_events').get().n,0);
});
async function walletWorld(t){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);await ensureSubscriptionWalletTables(db);const now=Date.now();
 sqlite.exec("CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,status TEXT)");
 sqlite.prepare("INSERT INTO customer_grooming_subscriptions VALUES ('S','C','P','G',5,1,0,'active',?,?,'PURCHASE','v1',?,?)").run(now,now+86400000,now,now);
 sqlite.prepare("INSERT INTO booking_subscription_usage VALUES ('U','B','C','S',1,0,'reserved',?,?)").run(now,now);
 sqlite.exec("INSERT INTO canonical_bookings VALUES ('B','C','grooming','G','completed')");
 return{sqlite,db,input:{subscriptionId:'S',action:'consume',bookingId:'B',idempotencyKey:'consume',actorId:'customer'}};
}
for(const table of ['subscription_wallet_events','customer_grooming_subscriptions','booking_subscription_usage'])test(`subscription consume rolls back failure in ${table} and retries once`,async t=>{
 const {sqlite,db,input}=await walletWorld(t);const action=table==='subscription_wallet_events'?'INSERT':'UPDATE';
 sqlite.exec(`CREATE TRIGGER audit_failure BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
 await assert.rejects(mutateSubscriptionWallet(db,input),/injected failure/);
 assert.equal(sqlite.prepare('SELECT status FROM booking_subscription_usage').get().status,'reserved');
 const wallet=sqlite.prepare('SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions').get();assert.equal(wallet.sessions_reserved,1);assert.equal(wallet.sessions_consumed,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscription_wallet_events').get().n,0);
 sqlite.exec('DROP TRIGGER audit_failure');await mutateSubscriptionWallet(db,input);
 assert.equal((await mutateSubscriptionWallet(db,input)).duplicatePrevented,true);
 assert.equal(sqlite.prepare('SELECT sessions_consumed FROM customer_grooming_subscriptions').get().sessions_consumed,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscription_wallet_events').get().n,1);
});
test('concurrent consumption cannot double charge a subscription',async t=>{
 const {sqlite,db,input}=await walletWorld(t);
 const result=await Promise.allSettled(['a','b'].map(idempotencyKey=>mutateSubscriptionWallet(db,{...input,idempotencyKey})));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 const wallet=sqlite.prepare('SELECT sessions_reserved,sessions_consumed FROM customer_grooming_subscriptions').get();assert.equal(wallet.sessions_reserved,0);assert.equal(wallet.sessions_consumed,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM subscription_wallet_events').get().n,1);
});
test('finance read failure is unavailable, never a clean report or stable forecast',async()=>{
 const statement={bind(){return this},async all(){throw new Error('database unavailable')}};const db={prepare(){return statement}};
 await assert.rejects(detectFinanceAnomalies(db),/database unavailable/);await assert.rejects(forecastCashFlow(db),/database unavailable/);
});
test('D1 failed batch rolls back inside an outer transaction and concurrent batches stay isolated',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());const db=d1(sqlite);sqlite.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY); BEGIN; INSERT INTO sample VALUES(9)');
 const result=await Promise.allSettled([db.batch([db.prepare('INSERT INTO sample VALUES(1)'),db.prepare('INSERT INTO sample VALUES(1)')]),db.batch([db.prepare('INSERT INTO sample VALUES(2)')])]);
 assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');assert.deepEqual(sqlite.prepare('SELECT id FROM sample ORDER BY id').all().map(r=>r.id),[2,9]);sqlite.exec('ROLLBACK');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM sample').get().n,0);
});
