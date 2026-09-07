import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{readFileSync}from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__ESCROW_DB__","__ESCROW_ENV__");

function d1(sqlite){
 const statement=(sql,args=[])=>({bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})});
 return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out;},exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0};}};
}
function world({captured=1000,env={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false"}}={}){
 const sqlite=new DatabaseSync(":memory:");sqlite.exec(`
 CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,currency TEXT,status TEXT);
 CREATE TABLE payment_reconciliation_records(payment_id TEXT PRIMARY KEY,captured_amount REAL,refunded_amount REAL);
 CREATE TABLE provider_order_commissions(booking_id TEXT PRIMARY KEY,commission_amount REAL,commission_source TEXT,override_reason TEXT,status TEXT,updated_at INTEGER);
 `);
 sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-E1','BK-E1','CUS-E1',1000,'INR','captured')").run();
 sqlite.prepare("INSERT INTO payment_reconciliation_records VALUES ('PAY-E1',?,0)").run(captured);
 sqlite.prepare("INSERT INTO provider_order_commissions VALUES ('BK-E1',200,'provider_default',NULL,'awaiting_approval_2',?)").run(Date.now());
 const db=d1(sqlite);globalThis.__ESCROW_DB__=db;globalThis.__ESCROW_ENV__=env;return{sqlite,db};
}
const mod=await import("../lib/escrow-custody-engine.ts");

test("EXECUTED: captured provider share enters balanced sandbox custody",async()=>{
 const{sqlite,db}=world();const result=await mod.reserveEscrowForProviderPayout(db,{bookingId:"BK-E1",providerId:"PRV-E1",amount:200,actorId:"finance@pawspace.in"});
 assert.equal(result.state,"CUSTODY_HELD");assert.equal(result.environment,"sandbox");assert.equal(result.liveApproved,false);
 const account=sqlite.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id='BK-E1'").get();assert.equal(account.custody_amount,200);assert.equal(account.held_amount,200);assert.equal(account.environment,"sandbox");assert.equal(account.live_approved,0);
 const journal=sqlite.prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_type='escrow_custody_reserve' ORDER BY id").all();
 assert.equal(journal.length,2);assert.equal(journal.reduce((n,row)=>n+Number(row.debit||0),0),journal.reduce((n,row)=>n+Number(row.credit||0),0));
 assert.ok(journal.some(row=>row.account_code==="2230-Customer Collections"&&Number(row.debit)===200));assert.ok(journal.some(row=>row.account_code==="2240-Escrow Custody Liability"&&Number(row.credit)===200));
});

test("EXECUTED: custody refuses money that was not captured",async()=>{
 const{sqlite,db}=world({captured:100});await assert.rejects(()=>mod.reserveEscrowForProviderPayout(db,{bookingId:"BK-E1",providerId:"PRV-E1",amount:200,actorId:"finance@pawspace.in"}),/escrow_capture_insufficient/);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM escrow_custodial_accounts").get().n,0);
});

test("EXECUTED: dispute freeze blocks provider release until arbitration",async()=>{
 const{db}=world();await mod.reserveEscrowForProviderPayout(db,{bookingId:"BK-E1",providerId:"PRV-E1",amount:200,actorId:"finance@pawspace.in"});
 await mod.freezeEscrowForDispute(db,{bookingId:"BK-E1",disputeReference:"DSP-REAL-1",reason:"Customer disputed service outcome",actorId:"ops@pawspace.in"});
 await assert.rejects(()=>mod.releaseUndisputedEscrowToProvider(db,{bookingId:"BK-E1",reason:"dispute window elapsed",actorId:"finance@pawspace.in"}),/escrow_release_blocked:DISPUTE_FROZEN/);
 await assert.rejects(()=>mod.requireEscrowProviderReleaseForPayout(db,{bookingId:"BK-E1",maximumAmount:200}),/escrow_not_released_for_provider:DISPUTE_FROZEN/);
});

test("EXECUTED: arbitration partial split conserves custody and gates payout to provider share",async()=>{
 const{sqlite,db}=world();await mod.reserveEscrowForProviderPayout(db,{bookingId:"BK-E1",providerId:"PRV-E1",amount:200,actorId:"finance@pawspace.in"});
 await mod.freezeEscrowForDispute(db,{bookingId:"BK-E1",disputeReference:"DSP-SPLIT-1",reason:"Customer supplied partial-service evidence",actorId:"ops@pawspace.in"});
 const resolved=await mod.arbitrateEscrow(db,{bookingId:"BK-E1",decision:"PARTIAL_SPLIT",providerAmount:120,customerAmount:80,reason:"Evidence supports a sixty forty allocation",actorId:"arbitrator@pawspace.in"});
 assert.equal(resolved.providerAmount+resolved.customerAmount,200);assert.equal(resolved.state,"PARTIAL_SPLIT");
 const account=sqlite.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id='BK-E1'").get();assert.equal(account.held_amount,0);assert.equal(account.released_provider_amount,120);assert.equal(account.refunded_customer_amount,80);
 const order=sqlite.prepare("SELECT commission_amount,commission_source FROM provider_order_commissions WHERE booking_id='BK-E1'").get();assert.equal(order.commission_amount,120);assert.equal(order.commission_source,"escrow_arbitration");
 const gate=await mod.requireEscrowProviderReleaseForPayout(db,{bookingId:"BK-E1",maximumAmount:120});assert.equal(gate.providerAmount,120);
 const releaseJournal=sqlite.prepare("SELECT debit,credit FROM finance_journal_entries WHERE source_type='escrow_release'").all();assert.equal(releaseJournal.reduce((n,row)=>n+Number(row.debit||0),0),releaseJournal.reduce((n,row)=>n+Number(row.credit||0),0));
});

test("EXECUTED: live payment configuration fails closed before custody writes",async()=>{
 const{sqlite,db}=world({env:{PAWSPACE_PAYMENT_ENV:"live",PAWSPACE_PAYMENT_LIVE_APPROVED:"true"}});await assert.rejects(()=>mod.reserveEscrowForProviderPayout(db,{bookingId:"BK-E1",providerId:"PRV-E1",amount:200,actorId:"finance@pawspace.in"}),/escrow_payment_isolation_violation/);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='escrow_custodial_accounts'").get().n,0);
});

test("provider finance production boundary cannot queue payout before escrow release",()=>{
 const source=readFileSync(new URL("../app/api/partner-finance/route.ts",import.meta.url),"utf8");
 const level2=source.indexOf('body.action==="approve_order_commission_level_2"');const gate=source.indexOf("requireEscrowProviderReleaseForPayout",level2);const payout=source.indexOf("approveOrderCommission",gate);
 assert.ok(level2>=0&&gate>level2&&payout>gate,"level 2 payout approval must execute the escrow release gate first");
 assert.match(source,/escrow_freeze_dispute/);assert.match(source,/escrow_arbitrate/);assert.match(source,/escrow_release_undisputed/);
});
