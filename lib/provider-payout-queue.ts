/*
 * ONE payout queue for commission providers. [Owner decision 6, 26 Sept 2026]
 *
 * A commission provider becomes payable the payout hold (lib/provider-payout-hold.ts, 7 calendar days)
 * after the service completion event, in every vertical. A scheduled job puts each due booking into
 * this queue exactly once, at status awaiting_release, and ONE Finance click releases it. That click
 * replaces the old confirm + level 1 + escrow release + level 2 chain for these payouts.
 *
 * What is paid is read from the finance journal, never recomputed here: the 2110-Provider Payable
 * credited for the booking at completion (already net of any TCS the completion journal withheld),
 * minus the provider's pro-rata share of any refund, minus TDS where the existing TDS rules require it
 * (lib/tds-governance.ts thresholds and rates), minus any recovery still owed from an earlier payout.
 * Every movement is posted to the journal as a balanced entry, so 2110 for a booking always equals what
 * is still owed to the provider for it; reconcileProviderPayable() checks exactly that.
 *
 * One payout authority per booking:
 *  - provider_payout_queue_items is keyed by booking_id, so the job can run any number of times and a
 *    booking is queued once;
 *  - the legacy provider_order_commissions sync no longer picks up bookings this queue owns, and a
 *    legacy row nobody has acted on yet is marked moved_to_payout_queue when the booking is queued here;
 *    a legacy row a person has already confirmed keeps its older approval steps and is never queued here;
 *  - provider_order_payouts.booking_id is UNIQUE, so no path can create a second payout record;
 *  - the boarding, sitting, walking and taxi settlement ledgers never created payouts; they now show
 *    the payout status this queue writes back to them.
 *
 * Live money is not released here. The release runs only in the sandbox payment environment
 * (runtimePaymentPolicy, unchanged) and produces the sandbox payout record that the RazorpayX TEST
 * dispatch sends. Live payouts stay behind the existing live-payout approvals.
 */
import{ACCT,ensureFinanceJournalTable,periodOf,postJournal,prepareJournalPosting,round,type JournalLine}from"./finance-accounts";
import{ensureProviderCommissionTables}from"./provider-commission-governance";
import{assertActiveVerifiedPayoutBeneficiary,ensurePayoutBeneficiarySnapshotSchema,preauthorizeVerifiedPayoutBeneficiary}from"./payout-beneficiary-verification";
import{REFUND_TABLES}from"./settlement-parity";
import{runtimePaymentPolicy}from"./escrow-custody-schema";
import{TDS_RATES,TDS_THRESHOLDS_FY}from"./tds-governance";
import{providerPayoutHoldDays,providerPayoutHoldSetting}from"./provider-payout-hold";

type Db=D1Database;
type Row=Record<string,unknown>;
export const PAYOUT_ACCOUNTS={providerPayable:"2110-Provider Payable",payoutsInTransit:"2115-Provider Payouts in Transit",tdsPayable:"2150-TDS Payable",recoveriesReceivable:"1310-Provider Recoveries Receivable",refunds:ACCT.REFUNDS} as const;
export const PAYOUT_JOURNAL_SOURCES={completion:"service_completion",refundAdjustment:"provider_payout_adjustment",release:"provider_payout_release",recovery:"provider_payout_recovery"} as const;
export type ProviderPayoutBlock="not_due"|"booking_not_completed"|"no_commission_provider"|"refunded_in_full"|"refund_open"|"dispute_open"|"no_beneficiary"|"older_approval_flow"|"below_minimum";
export const PAYOUT_BLOCK_LABELS:Record<ProviderPayoutBlock,string>={not_due:"Not due yet",booking_not_completed:"Booking is not completed",no_commission_provider:"No commission provider to pay on this booking",refunded_in_full:"Refunded in full, nothing to pay",refund_open:"A refund request is still open",dispute_open:"A customer dispute or complaint is open",no_beneficiary:"No verified bank account for this provider",older_approval_flow:"Being paid through the older approval steps",below_minimum:"Less than Rs 1 to pay, too small for a bank payout"};
export const PAYOUT_STATUS_LABELS:Record<string,string>={awaiting_release:"Ready to release",released:"Released",cancelled:"Cancelled"};
/** What happened to the sandbox payout record after release, in words (lib/razorpayx-payout-runtime.ts states). */
export const SANDBOX_PAYOUT_LABELS:Record<string,string>={queued_sandbox:"waiting for Send TEST payout",retry_pending_sandbox:"waiting to be sent again",provider_queued_sandbox:"sent to RazorpayX TEST, queued there",provider_pending_sandbox:"sent to RazorpayX TEST, pending there",provider_processing_sandbox:"sent to RazorpayX TEST, processing",payout_processed_sandbox:"paid in RazorpayX TEST",payout_reversed_sandbox:"reversed by the bank in RazorpayX TEST",failed_sandbox:"failed in RazorpayX TEST, needs a look"};
const DAY_MS=86_400_000;
/** The smallest amount a bank payout can carry (RazorpayX: 100 paise). */
const MIN_PAYOUT=1;
const LEGACY_UNTOUCHED=["configuration_required","pending_confirmation","moved_to_payout_queue"];
const VERTICAL_LEDGERS=["boarding_host_settlement_ledger","sitting_sitter_settlement_ledger","walking_walker_settlement_ledger","taxi_driver_settlement_ledger"] as const;
const text=(value:unknown)=>String(value??"").trim();
const money=(value:unknown)=>round(Math.max(0,Number(value||0)));
const changes=(result:unknown)=>Number((result as {meta?:{changes?:number}}|undefined)?.meta?.changes||0);
const isoDay=(at:number)=>new Date(at).toISOString().slice(0,10);
const dateLabel=(at:number)=>new Date(at).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
/*
 * Reads here fail CLOSED. A table that has not been created yet (a vertical nobody has used on this
 * database) is genuinely empty; any other failure throws, because a refund or dispute read that quietly
 * came back empty would release money that should have been held. The sweep records the error per booking.
 */
const missingTable=(error:unknown)=>/no such table/i.test(error instanceof Error?error.message:String(error));
async function one(db:Db,sql:string,binds:unknown[]=[]){try{return await db.prepare(sql).bind(...binds).first<Row>();}catch(error){if(missingTable(error))return null;throw error;}}
async function many(db:Db,sql:string,binds:unknown[]=[]):Promise<Row[]>{try{return (await db.prepare(sql).bind(...binds).all<Row>()).results||[];}catch(error){if(missingTable(error))return[];throw error;}}
async function messageOf(error:unknown){if(error instanceof Response)return(await error.clone().text().catch(()=>""))||`HTTP ${error.status}`;return error instanceof Error?error.message:String(error);}

const ready=new WeakSet<Db>();
export async function ensureProviderPayoutQueueTables(db:Db){
 if(ready.has(db))return;
 await ensureProviderCommissionTables(db);await ensurePayoutBeneficiarySnapshotSchema(db);await ensureFinanceJournalTable(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_queue_items (booking_id TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT '',completed_at INTEGER NOT NULL,hold_days INTEGER NOT NULL,due_at INTEGER NOT NULL,order_amount REAL NOT NULL,payable_amount REAL NOT NULL CHECK(payable_amount>=0),refunded_amount REAL NOT NULL DEFAULT 0,refund_adjustment REAL NOT NULL DEFAULT 0 CHECK(refund_adjustment>=0),gross_amount REAL NOT NULL CHECK(gross_amount>=0),tds_section TEXT,tds_base REAL NOT NULL DEFAULT 0,tds_amount REAL NOT NULL DEFAULT 0 CHECK(tds_amount>=0),recovery_deduction REAL NOT NULL DEFAULT 0 CHECK(recovery_deduction>=0),amount REAL NOT NULL CHECK(amount>=0),status TEXT NOT NULL CHECK(status IN ('awaiting_release','released','cancelled')),blocked_reason TEXT,blocked_detail TEXT,cancel_reason TEXT,recovered_amount REAL NOT NULL DEFAULT 0,recovery_seq INTEGER NOT NULL DEFAULT 0,payout_id TEXT UNIQUE,environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),released_by TEXT,released_at INTEGER,release_reason TEXT,journal_group TEXT,checked_at INTEGER NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_payout_queue_status ON provider_payout_queue_items(status,checked_at,due_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_payout_queue_provider ON provider_payout_queue_items(provider_id,status,completed_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_candidates (booking_id TEXT PRIMARY KEY,provider_id TEXT,service_code TEXT,payable_amount REAL NOT NULL,amount_preview REAL NOT NULL,completed_at INTEGER,due_at INTEGER,reason TEXT NOT NULL,detail TEXT,checked_at INTEGER NOT NULL,next_check_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_recoveries (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,booking_id TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>0),recovered_amount REAL NOT NULL DEFAULT 0 CHECK(recovered_amount>=0 AND recovered_amount<=amount+0.005),status TEXT NOT NULL CHECK(status IN ('open','recovered')),reason TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,journal_group TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_payout_recoveries_open ON provider_payout_recoveries(provider_id,status,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_recovery_applications (recovery_id TEXT NOT NULL,booking_id TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>0),created_at INTEGER NOT NULL,PRIMARY KEY(recovery_id,booking_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payout_queue_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_payout_queue_events ON provider_payout_queue_events(booking_id,created_at)"),
  // Every sweep reads the journal by source (completion payables, refund adjustments, releases). Without this
  // index each of those reads scans the whole finance journal, several times per five-minute cron run.
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_journal_source ON finance_journal_entries(source_type,account_code,source_id)"),
 ]);
 ready.add(db);
}
const eventStatement=(db:Db,bookingId:string,eventType:string,actor:string,detail:unknown,at:number)=>db.prepare("INSERT INTO provider_payout_queue_events (id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),bookingId,eventType,actor,JSON.stringify(detail??{}),at);

/** The provider's share after refunds: the payable scaled to what the customer finally paid. */
export function proRataProviderPayout(payable:number,orderAmount:number,refunded:number){const p=money(payable),order=money(orderAmount),r=money(refunded);if(p<=0)return 0;if(order<=0)return r>0?0:p;const factor=Math.min(1,Math.max(0,(order-r)/order));return round(p*factor);}

/*
 * Refunds recorded against a booking. The vertical refund ledgers and credit notes are the same set
 * lib/settlement-parity.ts counts; booking_refund_cases counts once money is actually going back
 * (processing/processed/completed, the P&L rule); gateway reconciliation is the bank truth. They are
 * different views of the same money, so the largest one is taken rather than their sum.
 */
// Which refund ledgers exist is re-read every time (one query), because vertical tables are created
// lazily and a table that appears later must never be missed; only each table's column shape is cached.
const refundLedgerShapes=new WeakMap<Db,Map<string,string|null>>();
async function refundLedgerSelects(db:Db){
 const present=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%refund_ledger'")).map(row=>text(row.name)).filter(name=>(REFUND_TABLES as readonly string[]).includes(name));
 let shapes=refundLedgerShapes.get(db);if(!shapes){shapes=new Map();refundLedgerShapes.set(db,shapes);}
 const selects:string[]=[];
 for(const table of present){if(!shapes.has(table)){const names=new Set((await many(db,`PRAGMA table_info(${table})`)).map(row=>text(row.name)));shapes.set(table,names.has("booking_id")&&names.has("amount")?`(SELECT COALESCE(SUM(amount),0) FROM ${table} WHERE booking_id=?${names.has("status")?" AND lower(status) NOT IN ('rejected','failed','void','cancelled')":""})`:null);}const select=shapes.get(table);if(select)selects.push(select);}
 return selects;
}
/* A refund recorded BEFORE completion was already netted by completion: the payable was computed on the amount the customer
 * finally paid (provider_payout_computations.refunded_before_completion). Only refunds beyond it scale the payable down, and
 * they scale it against that same net amount - never the same refund twice. */
async function refundedBeforeCompletion(db:Db,bookingId:string){const row=await db.prepare("SELECT refunded_before_completion FROM provider_payout_computations WHERE booking_id=?").bind(bookingId).first<Row>().catch(()=>null);return money(row?.refunded_before_completion);}
export async function refundedForProviderPayout(db:Db,bookingId:string){
 const prior=await refundedBeforeCompletion(db,bookingId);
 return money(Math.max(0,await refundedInTotal(db,bookingId)-prior));
}
async function refundedInTotal(db:Db,bookingId:string){
 const selects=await refundLedgerSelects(db);
 const ledgers=selects.length?Number((await one(db,`SELECT ${selects.join("+")} amount`,selects.map(()=>bookingId)))?.amount||0):0;
 const notes=Number((await one(db,"SELECT COALESCE(SUM(a.amount+a.tax_amount),0) amount FROM finance_adjustment_documents a JOIN finance_invoices i ON i.id=a.invoice_id WHERE i.source_type='booking' AND i.source_id=? AND a.kind='credit_note' AND a.status='issued'",[bookingId]))?.amount||0);
 const cases=Number((await one(db,"SELECT COALESCE(SUM(amount),0) amount FROM booking_refund_cases WHERE booking_id=? AND status IN ('processing','processed','completed')",[bookingId]))?.amount||0);
 const gateway=Number((await one(db,"SELECT COALESCE(SUM(r.refunded_amount),0) amount FROM booking_payments p JOIN payment_reconciliation_records r ON r.payment_id=p.id WHERE p.booking_id=?",[bookingId]))?.amount||0);
 return money(Math.max(ledgers+notes,cases,gateway));
}

async function openDispute(db:Db,bookingId:string){
 if(await one(db,"SELECT id FROM dispute_freezes WHERE booking_id=? AND status IN ('OPEN','RESOLVING') LIMIT 1",[bookingId]))return"An escrow dispute is open for this booking";
 const kase=await one(db,"SELECT case_type,title FROM unified_cases WHERE booking_id=? AND case_type IN ('customer_complaint','payment','safety_incident') AND status NOT IN ('resolved','closed') ORDER BY created_at DESC LIMIT 1",[bookingId]);
 if(kase)return`Open ${text(kase.case_type).replaceAll("_"," ")} case: ${text(kase.title)}`;
 // A customer who disputes a COMPLETED job does it through the cancellation-case flow: a completed booking
 // cannot be cancelled, so the request opens a service_dispute case (lib/cancellation-case-governance.ts)
 // that Operations and then Finance decide. Until that case is closed the money must not leave.
 const service=await one(db,"SELECT id,case_type,status FROM booking_cancellation_cases WHERE booking_id=? AND status<>'closed' ORDER BY created_at DESC LIMIT 1",[bookingId]);
 return service?(text(service.case_type)==="service_dispute"?`The customer has disputed this completed service; case ${text(service.id)} is still ${text(service.status).replaceAll("_"," ")}`:`A cancellation case for this booking is still ${text(service.status).replaceAll("_"," ")} (${text(service.id)})`):null;
}
async function openRefundRequest(db:Db,bookingId:string){
 const request=await one(db,"SELECT status,amount FROM booking_refund_cases WHERE booking_id=? AND status IN ('requested','approved') ORDER BY created_at DESC LIMIT 1",[bookingId]);
 if(request)return`Refund of Rs ${money(request.amount).toFixed(2)} is ${text(request.status)} and not yet processed`;
 const kase=await one(db,"SELECT title FROM unified_cases WHERE booking_id=? AND case_type='refund' AND status NOT IN ('resolved','closed') LIMIT 1",[bookingId]);
 return kase?`Open refund case: ${text(kase.title)}`:null;
}
async function legacyAuthority(db:Db,bookingId:string){
 const legacy=await one(db,"SELECT status FROM provider_order_commissions WHERE booking_id=?",[bookingId]);
 if(legacy&&!LEGACY_UNTOUCHED.includes(text(legacy.status)))return`Older approval steps are already in progress (${text(legacy.status).replaceAll("_"," ")})`;
 const payout=await one(db,"SELECT id,status FROM provider_order_payouts WHERE booking_id=?",[bookingId]);
 return payout?`A payout record already exists (${text(payout.id)})`:null;
}

/** Who is paid: the vehicle owner for a fleet taxi trip, otherwise the booking's commission provider. */
async function payeeFor(db:Db,booking:Row){
 const bookingId=text(booking.id);
 // Read directly, with the owner rule lib/taxi-finance-governance.ts uses: taxiFleetForBooking would run the
 // taxi fleet DDL and its seed inserts on every scheduled check of a taxi booking.
 if(text(booking.service_code)==="pet_taxi"){const fleet=await one(db,"SELECT r.vehicle_id,COALESCE(r.owner_provider_id,v.owner_provider_id) owner_provider_id FROM taxi_fleet_reservations r JOIN taxi_fleet_vehicles v ON v.id=r.vehicle_id WHERE r.booking_id=? ORDER BY r.created_at DESC LIMIT 1",[bookingId]);if(fleet){const owner=text(fleet.owner_provider_id)||text(fleet.vehicle_id);return owner?{providerId:owner,model:"vehicle_owner"}:null;}}
 const work=await one(db,"SELECT provider_id,provider_model FROM provider_work_orders WHERE booking_id=?",[bookingId]);
 if(!work||text(work.provider_model)!=="commission"||!text(work.provider_id))return null;
 return{providerId:text(work.provider_id),model:"commission"};
}

/** The service completion event. Training counts from the end of the programme, walking from the last walk. */
async function completionEventAt(db:Db,booking:Row,fallback:number){
 const bookingId=text(booking.id),service=text(booking.service_code);
 const lifecycle=await one(db,"SELECT MAX(occurred_at) at FROM booking_lifecycle_events WHERE booking_id=? AND event_type IN ('service_completed','booking_completed','completed')",[bookingId]);
 if(Number(lifecycle?.at)>0)return Number(lifecycle?.at);
 const vertical=service==="dog_training"||service==="training"?await one(db,"SELECT MAX(COALESCE(completed_at,updated_at)) at FROM training_sessions WHERE booking_id=? AND status='completed'",[bookingId]):service==="dog_walking"||service==="walking"?await one(db,"SELECT MAX(updated_at) at FROM walking_sessions WHERE booking_id=? AND status='completed'",[bookingId]):service==="pet_taxi"?await one(db,"SELECT updated_at at FROM taxi_trips WHERE booking_id=? AND status='completed'",[bookingId]):null;
 if(Number(vertical?.at)>0)return Number(vertical?.at);
 return Number(fallback)>0?Number(fallback):Number(booking.updated_at||Date.now());
}

function fyWindow(at:number){const ist=new Date(at+330*60_000),year=ist.getUTCFullYear(),month=ist.getUTCMonth()+1,start=month>=4?year:year-1;return{start:Date.UTC(start,3,1)-330*60_000,end:Date.UTC(start+1,3,1)-330*60_000};}
/*
 * TDS on a commission payout, under the rules lib/tds-governance.ts already applies to the month:
 * section 194H at 2 percent once the provider's commission for the financial year reaches Rs 20,000,
 * at which point the whole not-yet-taxed amount for the year is taxed. Only payouts already released
 * count towards the year, so the figure shown on a queued payout is the one a release would deduct now.
 */
export async function providerPayoutTds(db:Db,input:{providerId:string;bookingId:string;grossAmount:number;completedAt:number}){
 const gross=money(input.grossAmount),section="194H" as const,rate=TDS_RATES.commission194H,threshold=TDS_THRESHOLDS_FY.commission194H,{start,end}=fyWindow(Number(input.completedAt));
 const prior=await one(db,"SELECT COALESCE(SUM(gross_amount),0) gross,COALESCE(SUM(tds_base),0) taxed FROM provider_payout_queue_items WHERE provider_id=? AND booking_id<>? AND status='released' AND completed_at>=? AND completed_at<?",[input.providerId,input.bookingId,start,end]);
 const cumulative=round(Number(prior?.gross||0)+gross);if(gross<=0||cumulative<threshold)return{section,rate,base:0,amount:0,financialYearToDate:cumulative};
 const base=round(cumulative-Number(prior?.taxed||0)),full=round(base*rate),amount=Math.min(full,gross);
 return{section,rate,base:amount<full?round(amount/rate):base,amount,financialYearToDate:cumulative};
}
async function openRecoveries(db:Db,providerId:string){return(await many(db,"SELECT id,booking_id,amount,recovered_amount FROM provider_payout_recoveries WHERE provider_id=? AND status='open' ORDER BY created_at,id",[providerId])).map(row=>({id:text(row.id),bookingId:text(row.booking_id),remaining:round(Number(row.amount)-Number(row.recovered_amount||0))})).filter(row=>row.remaining>0.004);}
async function payoutFigures(db:Db,item:Row,gross:number){
 const providerId=text(item.provider_id),bookingId=text(item.booking_id);
 const tds=await providerPayoutTds(db,{providerId,bookingId,grossAmount:gross,completedAt:Number(item.completed_at)});
 let room=round(gross-tds.amount);const recoveries:Array<{id:string;amount:number}>=[];
 for(const recovery of await openRecoveries(db,providerId)){if(recovery.bookingId===bookingId||room<=0)continue;let take=round(Math.min(room,recovery.remaining));const left=round(room-take);if(left>0&&left<MIN_PAYOUT)take=room>=MIN_PAYOUT?round(room-MIN_PAYOUT):0;if(take<=0)continue;recoveries.push({id:recovery.id,amount:take});room=round(room-take);}
 const recovery=round(recoveries.reduce((sum,r)=>sum+r.amount,0));
 return{gross,tds,recoveries,recovery,net:round(gross-tds.amount-recovery)};
}

export type ProviderPayoutAssessment={bookingId:string;providerId:string|null;serviceCode:string;orderAmount:number;payable:number;refunded:number;grossAmount:number;completedAt:number|null;holdDays:number|null;dueAt:number|null;block:ProviderPayoutBlock|null;detail:string|null};
/** Everything the job needs to decide whether a booking with a provider payable can be queued now. */
export async function assessProviderPayout(db:Db,input:{bookingId:string;payable:number;postedAt?:number;asOf?:number}):Promise<ProviderPayoutAssessment>{
 const asOf=input.asOf??Date.now(),bookingId=text(input.bookingId),payable=money(input.payable);
 const booking=await one(db,"SELECT id,status,service_code,total_amount,updated_at FROM canonical_bookings WHERE id=?",[bookingId]);
 const base={bookingId,providerId:null as string|null,serviceCode:text(booking?.service_code),orderAmount:money(money(booking?.total_amount)-await refundedBeforeCompletion(db,bookingId))||payable,payable,refunded:0,grossAmount:payable,completedAt:null as number|null,holdDays:null as number|null,dueAt:null as number|null};
 if(!booking||text(booking.status)!=="completed")return{...base,block:"booking_not_completed",detail:booking?`Booking status is ${text(booking.status)||"unknown"}`:"Booking not found"};
 const payee=await payeeFor(db,booking);
 const completedAt=await completionEventAt(db,booking,Number(input.postedAt||0)),holdDays=await providerPayoutHoldDays(db,completedAt),dueAt=completedAt+holdDays*DAY_MS;
 const refunded=await refundedForProviderPayout(db,bookingId),grossAmount=proRataProviderPayout(payable,base.orderAmount,refunded);
 const known={...base,providerId:payee?.providerId??null,refunded,grossAmount,completedAt,holdDays,dueAt};
 if(!payee)return{...known,block:"no_commission_provider",detail:"Only commission providers and taxi vehicle owners are paid through this queue"};
 const legacy=await legacyAuthority(db,bookingId);if(legacy)return{...known,block:"older_approval_flow",detail:legacy};
 if(grossAmount<=0.004)return{...known,block:"refunded_in_full",detail:`Refunds of Rs ${refunded.toFixed(2)} cover the whole booking`};
 if(asOf<dueAt)return{...known,block:"not_due",detail:`Due on ${dateLabel(dueAt)} (${holdDays} days after the service was completed)`};
 const dispute=await openDispute(db,bookingId);if(dispute)return{...known,block:"dispute_open",detail:dispute};
 const refund=await openRefundRequest(db,bookingId);if(refund)return{...known,block:"refund_open",detail:refund};
 try{await assertActiveVerifiedPayoutBeneficiary(db,payee.providerId,asOf);}catch(error){return{...known,block:"no_beneficiary",detail:await messageOf(error)};}
 return{...known,block:null,detail:null};
}

/** Brings posted refund adjustments for a booking to its target, one balanced delta at a time. */
async function postRefundAdjustment(db:Db,item:Row,target:number,at:number){
 const bookingId=text(item.booking_id),posted=await one(db,"SELECT ROUND(COALESCE(SUM(debit-credit),0),2) amount,COUNT(*) n FROM finance_journal_entries WHERE source_type=? AND source_id=? AND account_code=?",[PAYOUT_JOURNAL_SOURCES.refundAdjustment,bookingId,PAYOUT_ACCOUNTS.providerPayable]);
 const delta=round(target-Number(posted?.amount||0));if(Math.abs(delta)<0.01)return null;
 const entryDate=isoDay(at),lines:JournalLine[]=delta>0?[{accountCode:PAYOUT_ACCOUNTS.providerPayable,debit:delta},{accountCode:PAYOUT_ACCOUNTS.refunds,credit:delta}]:[{accountCode:PAYOUT_ACCOUNTS.refunds,debit:-delta},{accountCode:PAYOUT_ACCOUNTS.providerPayable,credit:-delta}];
 return postJournal(db,{groupKey:`PAYOUT-REFUND-${bookingId}-${Number(posted?.n||0)+1}`,entryDate,periodCode:periodOf(entryDate),sourceType:PAYOUT_JOURNAL_SOURCES.refundAdjustment,sourceId:bookingId,narration:delta>0?`Provider share of refund on ${bookingId}: payout reduced by Rs ${delta.toFixed(2)}`:`Refund reversed on ${bookingId}: provider payout restored by Rs ${(-delta).toFixed(2)}`,lines,metadata:{bookingId,serviceCode:text(item.service_code)||null,transactionAt:at,verificationStatus:"posted"}});
}
async function bridgeVerticalLedgers(db:Db,bookingId:string,payoutStatus:string,reference:string|null,at:number){for(const table of VERTICAL_LEDGERS)await db.prepare(`UPDATE ${table} SET payout_status=?,payout_reference=COALESCE(?,payout_reference),updated_at=? WHERE booking_id=? AND payout_status<>'not_applicable'`).bind(payoutStatus,reference,at,bookingId).run().catch((error:unknown)=>{if(!missingTable(error))throw error;});}

/** The 2110-Provider Payable the completion journal credited for a booking (null when it cannot be read). */
async function completionPayable(db:Db,bookingId:string){const row=await one(db,"SELECT COUNT(*) n,ROUND(COALESCE(SUM(credit-debit),0),2) amount FROM finance_journal_entries WHERE source_type=? AND source_id=? AND account_code=? AND posted=1",[PAYOUT_JOURNAL_SOURCES.completion,bookingId,PAYOUT_ACCOUNTS.providerPayable]);return row&&Number(row.n)>0?money(row.amount):null;}

/** Re-reads the payable, refunds, disputes and the bank account for a queued payout; cancels it when nothing is owed. */
async function refreshQueuedItem(db:Db,item:Row,asOf:number,actor:string){
 const bookingId=text(item.booking_id),payable=(await completionPayable(db,bookingId))??money(item.payable_amount),refunded=await refundedForProviderPayout(db,bookingId),gross=proRataProviderPayout(payable,Number(item.order_amount),refunded),adjustment=round(payable-gross);
 if(gross<=0.004){
  const reason=payable>0?"refunded_in_full":"provider_payable_reversed";
  const cancelled=await db.batch([db.prepare("UPDATE provider_payout_queue_items SET status='cancelled',cancel_reason=?,payable_amount=?,refunded_amount=?,refund_adjustment=?,gross_amount=0,tds_amount=0,tds_base=0,recovery_deduction=0,amount=0,blocked_reason=NULL,blocked_detail=NULL,checked_at=?,updated_at=? WHERE booking_id=? AND status='awaiting_release'").bind(reason,payable,refunded,adjustment,asOf,asOf,bookingId),eventStatement(db,bookingId,`payout_cancelled_${reason}`,actor,{refunded,payable},asOf)]);
  if(changes(cancelled[0])===1){await postRefundAdjustment(db,item,adjustment,asOf);await bridgeVerticalLedgers(db,bookingId,"cancelled_refunded",null,asOf);}
  return{item:await one(db,"SELECT * FROM provider_payout_queue_items WHERE booking_id=?",[bookingId]),outcome:"cancelled" as const};
 }
 const figures=await payoutFigures(db,item,gross),dispute=await openDispute(db,bookingId),refund=dispute?null:await openRefundRequest(db,bookingId);let block:ProviderPayoutBlock|null=dispute?"dispute_open":refund?"refund_open":null,detail=dispute||refund;
 if(!block){try{await assertActiveVerifiedPayoutBeneficiary(db,text(item.provider_id),asOf);}catch(error){block="no_beneficiary";detail=await messageOf(error);}}
 if(!block&&figures.net>0&&figures.net<MIN_PAYOUT){block="below_minimum";detail=`Rs ${figures.net.toFixed(2)} after deductions; a bank payout must be at least Rs ${MIN_PAYOUT}`;}
 const changed=Math.abs(gross-Number(item.gross_amount))>=0.01;
 const updated=await db.prepare("UPDATE provider_payout_queue_items SET payable_amount=?,refunded_amount=?,refund_adjustment=?,gross_amount=?,tds_section=?,tds_base=?,tds_amount=?,recovery_deduction=?,amount=?,blocked_reason=?,blocked_detail=?,checked_at=?,updated_at=? WHERE booking_id=? AND status='awaiting_release'").bind(payable,refunded,adjustment,gross,figures.tds.section,figures.tds.base,figures.tds.amount,figures.recovery,figures.net,block,detail,asOf,asOf,bookingId).run();
 if(changes(updated)===1){await postRefundAdjustment(db,item,adjustment,asOf);if(changed)await db.batch([eventStatement(db,bookingId,"payout_amount_changed",actor,{payable,refunded,grossBefore:Number(item.gross_amount),grossAfter:gross},asOf)]);}
 return{item:await one(db,"SELECT * FROM provider_payout_queue_items WHERE booking_id=?",[bookingId]),outcome:changed?"changed" as const:"unchanged" as const};
}

/*
 * A full refund cancels the queued payout, but a refund can still fail at the gateway or be rejected after
 * it was counted (booking_refund_cases 'processing' -> 'failed', a vertical ledger row -> 'rejected'). Then
 * the provider is owed again: the payout is reopened and the 2110 taken off at cancellation is restored by
 * the same balanced refund-adjustment delta. Reads fail closed, so a refund that cannot be read keeps it shut.
 */
async function reopenIfRefundReversed(db:Db,item:Row,asOf:number,actor:string){
 const bookingId=text(item.booking_id),payable=(await completionPayable(db,bookingId))??money(item.payable_amount),refunded=await refundedForProviderPayout(db,bookingId),gross=proRataProviderPayout(payable,Number(item.order_amount),refunded);
 if(gross<=0.004){await db.prepare("UPDATE provider_payout_queue_items SET checked_at=? WHERE booking_id=? AND status='cancelled'").bind(asOf,bookingId).run();return false;}
 const reopened=await db.prepare("UPDATE provider_payout_queue_items SET status='awaiting_release',cancel_reason=NULL,checked_at=?,updated_at=? WHERE booking_id=? AND status='cancelled' AND cancel_reason='refunded_in_full'").bind(asOf,asOf,bookingId).run();
 if(changes(reopened)!==1)return false;
 await db.batch([eventStatement(db,bookingId,"payout_reopened_refund_reversed",actor,{refunded,payable,gross},asOf)]);
 await refreshQueuedItem(db,{...item,status:"awaiting_release"},asOf,actor);
 await bridgeVerticalLedgers(db,bookingId,"queued_for_release",text(item.id)||null,asOf);
 return true;
}

/** After release: a later refund becomes a recovery taken from the provider's next payout. */
async function recoverAfterRelease(db:Db,item:Row,asOf:number,actor:string){
 const bookingId=text(item.booking_id),refunded=await refundedForProviderPayout(db,bookingId),target=proRataProviderPayout(Number(item.payable_amount),Number(item.order_amount),refunded),owed=round(Number(item.gross_amount)-target-Number(item.recovered_amount||0));
 if(owed<0.01){if(refunded!==Number(item.refunded_amount))await db.prepare("UPDATE provider_payout_queue_items SET refunded_amount=?,checked_at=? WHERE booking_id=?").bind(refunded,asOf,bookingId).run();else await db.prepare("UPDATE provider_payout_queue_items SET checked_at=? WHERE booking_id=?").bind(asOf,bookingId).run();return null;}
 const seq=Number(item.recovery_seq||0)+1,id=`PREC-${bookingId}-${seq}`;
 const results=await db.batch([db.prepare("UPDATE provider_payout_queue_items SET recovered_amount=ROUND(recovered_amount+?,2),recovery_seq=?,refunded_amount=?,checked_at=?,updated_at=? WHERE booking_id=? AND status='released' AND recovery_seq=?").bind(owed,seq,refunded,asOf,asOf,bookingId,seq-1),db.prepare("INSERT INTO provider_payout_recoveries (id,provider_id,booking_id,amount,recovered_amount,status,reason,idempotency_key,created_at,updated_at) SELECT ?,?,?,?,0,'open',?,?,?,? WHERE EXISTS(SELECT 1 FROM provider_payout_queue_items WHERE booking_id=? AND recovery_seq=?)").bind(id,text(item.provider_id),bookingId,owed,`Customer refund after the payout was released: Rs ${refunded.toFixed(2)} refunded in total`,`recovery:${bookingId}:${seq}`,asOf,asOf,bookingId,seq),eventStatement(db,bookingId,"payout_recovery_recorded",actor,{recoveryId:id,amount:owed,refunded},asOf)]);
 if(changes(results[0])!==1)return null;
 await postRecoveryJournal(db,id,asOf);
 return{recoveryId:id,amount:owed};
}
async function postRecoveryJournal(db:Db,recoveryId:string,at:number){
 const recovery=await one(db,"SELECT * FROM provider_payout_recoveries WHERE id=?",[recoveryId]);if(!recovery||text(recovery.journal_group))return;
 const amount=money(recovery.amount),bookingId=text(recovery.booking_id),entryDate=isoDay(at);
 const posted=await postJournal(db,{groupKey:`PAYOUT-RECOVERY-${recoveryId}`,entryDate,periodCode:periodOf(entryDate),sourceType:PAYOUT_JOURNAL_SOURCES.recovery,sourceId:bookingId,narration:`Refund after payout on ${bookingId}: Rs ${amount.toFixed(2)} to recover from the provider's next payout`,lines:[{accountCode:PAYOUT_ACCOUNTS.recoveriesReceivable,debit:amount},{accountCode:PAYOUT_ACCOUNTS.refunds,credit:amount}],metadata:{bookingId,transactionAt:at,verificationStatus:"posted",settlementId:recoveryId}});
 await db.prepare("UPDATE provider_payout_recoveries SET journal_group=?,updated_at=? WHERE id=? AND journal_group IS NULL").bind(posted.journalGroup,at,recoveryId).run();
}
async function postReleaseJournal(db:Db,item:Row,at:number){
 if(text(item.journal_group)||text(item.status)!=="released")return;
 const bookingId=text(item.booking_id),entryDate=isoDay(Number(item.released_at||at));
 const posted=await postJournal(db,{groupKey:`PAYOUT-RELEASE-${bookingId}`,entryDate,periodCode:periodOf(entryDate),sourceType:PAYOUT_JOURNAL_SOURCES.release,sourceId:bookingId,narration:`Provider payout released for ${bookingId} (${text(item.payout_id)})`,lines:releaseLines(item),metadata:{bookingId,serviceCode:text(item.service_code)||null,settlementId:text(item.payout_id)||null,transactionAt:Number(item.released_at||at),verificationStatus:"posted"}});
 await db.prepare("UPDATE provider_payout_queue_items SET journal_group=? WHERE booking_id=? AND journal_group IS NULL").bind(posted.journalGroup,bookingId).run();
}
function releaseLines(item:Row):JournalLine[]{return[{accountCode:PAYOUT_ACCOUNTS.providerPayable,debit:money(item.gross_amount)},{accountCode:PAYOUT_ACCOUNTS.payoutsInTransit,credit:money(item.amount)},{accountCode:PAYOUT_ACCOUNTS.tdsPayable,credit:money(item.tds_amount)},{accountCode:PAYOUT_ACCOUNTS.recoveriesReceivable,credit:money(item.recovery_deduction)}];}

async function queueAssessed(db:Db,a:ProviderPayoutAssessment,actor:string,asOf:number){
 const id=`PPQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`,draft={booking_id:a.bookingId,provider_id:a.providerId,completed_at:a.completedAt,service_code:a.serviceCode,payable_amount:a.payable,order_amount:a.orderAmount};
 const figures=await payoutFigures(db,draft,a.grossAmount),adjustment=round(a.payable-a.grossAmount),small=figures.net>0&&figures.net<MIN_PAYOUT;
 const results=await db.batch([
  db.prepare("INSERT OR IGNORE INTO provider_payout_queue_items (booking_id,id,provider_id,service_code,completed_at,hold_days,due_at,order_amount,payable_amount,refunded_amount,refund_adjustment,gross_amount,tds_section,tds_base,tds_amount,recovery_deduction,amount,status,blocked_reason,blocked_detail,checked_at,created_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_release',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM provider_order_commissions c WHERE c.booking_id=? AND c.status NOT IN ('configuration_required','pending_confirmation','moved_to_payout_queue')) AND NOT EXISTS(SELECT 1 FROM provider_order_payouts p WHERE p.booking_id=?)").bind(a.bookingId,id,a.providerId,a.serviceCode,a.completedAt,a.holdDays,a.dueAt,a.orderAmount,a.payable,a.refunded,adjustment,a.grossAmount,figures.tds.section,figures.tds.base,figures.tds.amount,figures.recovery,figures.net,small?"below_minimum":null,small?`Rs ${figures.net.toFixed(2)} after deductions; a bank payout must be at least Rs ${MIN_PAYOUT}`:null,asOf,actor,asOf,asOf,a.bookingId,a.bookingId),
  db.prepare("UPDATE provider_order_commissions SET status='moved_to_payout_queue',updated_at=? WHERE booking_id=? AND status IN ('configuration_required','pending_confirmation') AND EXISTS(SELECT 1 FROM provider_payout_queue_items WHERE booking_id=? AND id=?)").bind(asOf,a.bookingId,a.bookingId,id),
  db.prepare("INSERT INTO provider_payout_queue_events (id,booking_id,event_type,actor_id,detail_json,created_at) SELECT ?,?,'payout_queued',?,?,? WHERE EXISTS(SELECT 1 FROM provider_payout_queue_items WHERE booking_id=? AND id=?)").bind(crypto.randomUUID(),a.bookingId,actor,JSON.stringify({payable:a.payable,refunded:a.refunded,gross:a.grossAmount,tds:figures.tds.amount,recovery:figures.recovery,net:figures.net,completedAt:a.completedAt,dueAt:a.dueAt,holdDays:a.holdDays}),asOf,a.bookingId,id),
  db.prepare("DELETE FROM provider_payout_candidates WHERE booking_id=? AND EXISTS(SELECT 1 FROM provider_payout_queue_items WHERE booking_id=?)").bind(a.bookingId,a.bookingId),
 ]);
 if(changes(results[0])!==1)return false;
 if(adjustment>=0.01)await postRefundAdjustment(db,{...draft},adjustment,asOf);
 await bridgeVerticalLedgers(db,a.bookingId,"queued_for_release",id,asOf);
 return true;
}
const SETTLED_BLOCKS:ProviderPayoutBlock[]=["booking_not_completed","no_commission_provider","older_approval_flow","refunded_in_full"];
async function rememberCandidate(db:Db,a:ProviderPayoutAssessment,asOf:number){const next=a.block==="not_due"&&a.dueAt?a.dueAt:asOf+(a.block&&SETTLED_BLOCKS.includes(a.block)?24:1)*60*60_000;await db.prepare("INSERT INTO provider_payout_candidates (booking_id,provider_id,service_code,payable_amount,amount_preview,completed_at,due_at,reason,detail,checked_at,next_check_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET provider_id=excluded.provider_id,service_code=excluded.service_code,payable_amount=excluded.payable_amount,amount_preview=excluded.amount_preview,completed_at=excluded.completed_at,due_at=excluded.due_at,reason=excluded.reason,detail=excluded.detail,checked_at=excluded.checked_at,next_check_at=excluded.next_check_at").bind(a.bookingId,a.providerId,a.serviceCode,a.payable,a.grossAmount,a.completedAt,a.dueAt,a.block,a.detail,asOf,next).run();}

/*
 * The scheduled job. Idempotent and bounded: each run looks at a handful of bookings (5 by default) so
 * it stays inside the Worker's per-invocation D1 query budget alongside the other sweeps. Measured on
 * the harness: about 20-35 queries per booking touched, so a cron run is roughly 300 and Finance's forced
 * "check now" (limit 10) stays under 1,000 even when every phase is full. A
 * booking that is not due is not looked at again until its due date; a blocked booking and a queued
 * payout are re-checked hourly; a released payout is watched for later refunds for 90 days.
 */
export async function runProviderPayoutQueueSweep(db:Db,input:{asOf?:number;actorId?:string;limit?:number;force?:boolean}={}){
 await ensureProviderPayoutQueueTables(db);
 const asOf=input.asOf??Date.now(),actor=text(input.actorId)||"system:provider-payout-queue",limit=Math.max(1,Math.min(50,Number(input.limit||5))),recheckBefore=input.force?asOf:asOf-60*60_000,summary={examined:0,queued:0,blocked:{} as Record<string,number>,refreshed:0,reduced:0,cancelled:0,reopened:0,recoveries:0,repaired:0,errors:[] as string[]};
 const listed=async(sql:string,binds:unknown[])=>(await db.prepare(sql).bind(...binds).all<Row>()).results||[];
 for(const item of await listed("SELECT * FROM provider_payout_queue_items WHERE status='awaiting_release' AND checked_at<=? ORDER BY checked_at,due_at LIMIT ?",[recheckBefore,limit])){try{const r=await refreshQueuedItem(db,item,asOf,actor);summary.refreshed++;if(r.outcome==="cancelled")summary.cancelled++;else if(r.outcome==="changed")summary.reduced++;}catch(error){summary.errors.push(`${text(item.booking_id)}: ${await messageOf(error)}`);}}
 for(const item of await listed("SELECT * FROM provider_payout_queue_items WHERE status='released' AND (journal_group IS NULL OR (checked_at<=? AND released_at>=?)) ORDER BY checked_at,released_at LIMIT ?",[recheckBefore,asOf-90*DAY_MS,limit])){try{await postReleaseJournal(db,item,asOf);if(await recoverAfterRelease(db,item,asOf,actor))summary.recoveries++;}catch(error){summary.errors.push(`${text(item.booking_id)}: ${await messageOf(error)}`);}}
 // Cancelled for a full refund: checked daily for 90 days in case the refund failed or was rejected.
 for(const item of await listed("SELECT * FROM provider_payout_queue_items WHERE status='cancelled' AND cancel_reason='refunded_in_full' AND checked_at<=? AND updated_at>=? ORDER BY checked_at LIMIT ?",[input.force?asOf:asOf-DAY_MS,asOf-90*DAY_MS,limit])){try{if(await reopenIfRefundReversed(db,item,asOf,actor))summary.reopened++;}catch(error){summary.errors.push(`${text(item.booking_id)}: ${await messageOf(error)}`);}}
 for(const recovery of await listed("SELECT id FROM provider_payout_recoveries WHERE journal_group IS NULL LIMIT ?",[limit])){try{await postRecoveryJournal(db,text(recovery.id),asOf);summary.repaired++;}catch(error){summary.errors.push(`${text(recovery.id)}: ${await messageOf(error)}`);}}
 // Bookings never looked at come first, then the ones checked longest ago, so a backlog of blocked
 // bookings can never starve a newly due one.
 const candidates=await listed(`SELECT j.source_id booking_id,ROUND(SUM(j.credit-j.debit),2) payable,MAX(j.created_at) posted_at,MAX(c.checked_at) checked_at FROM finance_journal_entries j LEFT JOIN provider_payout_candidates c ON c.booking_id=j.source_id WHERE j.source_type='service_completion' AND j.account_code=? AND j.posted=1 AND NOT EXISTS(SELECT 1 FROM provider_payout_queue_items q WHERE q.booking_id=j.source_id)${input.force?"":" AND (c.booking_id IS NULL OR c.next_check_at<=?)"} GROUP BY j.source_id HAVING SUM(j.credit-j.debit)>0.004 ORDER BY COALESCE(MAX(c.checked_at),0),posted_at,j.source_id LIMIT ?`,input.force?[PAYOUT_ACCOUNTS.providerPayable,limit]:[PAYOUT_ACCOUNTS.providerPayable,asOf,limit]);
 for(const candidate of candidates){summary.examined++;try{const a=await assessProviderPayout(db,{bookingId:text(candidate.booking_id),payable:Number(candidate.payable),postedAt:Number(candidate.posted_at),asOf});if(a.block){summary.blocked[a.block]=(summary.blocked[a.block]||0)+1;await rememberCandidate(db,a,asOf);continue;}if(await queueAssessed(db,a,actor,asOf))summary.queued++;}catch(error){summary.errors.push(`${text(candidate.booking_id)}: ${await messageOf(error)}`);}}
 return summary;
}

/** ONE Finance click. Releases each booking's queued payout into a sandbox payout record. */
export async function releaseProviderPayouts(db:Db,input:{bookingIds:string[];actor:string;reason?:string|null;asOf?:number}){
 const actor=text(input.actor),reason=text(input.reason)||null,ids=[...new Set((input.bookingIds||[]).map(text).filter(Boolean))];
 if(!actor)throw new Response("The person releasing the payout must be known",{status:400});
 if(!ids.length)throw new Response("Choose at least one payout to release",{status:400});
 if(ids.length>100)throw new Response("Release at most 100 payouts at a time",{status:400});
 try{await runtimePaymentPolicy();}catch(error){throw new Response(`Live provider payouts still need the live-payout approvals. This button only releases sandbox payouts. (${await messageOf(error)})`,{status:409});}
 await ensureProviderPayoutQueueTables(db);
 const released:Array<Record<string,unknown>>=[],refused:Array<{bookingId:string;error:string}>=[];
 for(const bookingId of ids){try{released.push(await releaseOne(db,{bookingId,actor,reason,asOf:input.asOf??Date.now()}));}catch(error){refused.push({bookingId,error:await messageOf(error)});}}
 return{released,refused,environment:"sandbox" as const,liveMoney:false};
}
async function releaseOne(db:Db,input:{bookingId:string;actor:string;reason:string|null;asOf:number}){
 const{bookingId,actor,reason,asOf}=input;let item=await one(db,"SELECT * FROM provider_payout_queue_items WHERE booking_id=?",[bookingId]);
 if(!item)throw new Response("This booking has no payout waiting in the queue",{status:404});
 if(text(item.status)==="released")return{bookingId,status:"released",payoutId:text(item.payout_id),amount:money(item.amount),duplicatePrevented:true,environment:"sandbox",liveMoney:false};
 if(text(item.status)==="cancelled")throw new Response(text(item.cancel_reason)==="refunded_in_full"?"This payout was cancelled because the customer was refunded in full":"This payout was cancelled because nothing is owed to the provider in the books",{status:409});
 const refreshed=await refreshQueuedItem(db,item,asOf,actor);item=refreshed.item;
 if(!item||text(item.status)==="cancelled")throw new Response(text(item?.cancel_reason)==="refunded_in_full"?"This payout was cancelled because the customer was refunded in full":"This payout was cancelled because nothing is owed to the provider in the books",{status:409});
 if(asOf<Number(item.due_at))throw new Response(`Not due yet. This payout can be released from ${dateLabel(Number(item.due_at))}`,{status:409});
 const blocked=text(item.blocked_reason) as ProviderPayoutBlock|"";if(blocked&&blocked!=="no_beneficiary")throw new Response(`${PAYOUT_BLOCK_LABELS[blocked]}: ${text(item.blocked_detail)}`,{status:409});
 const providerId=text(item.provider_id);let beneficiary;
 try{beneficiary=await preauthorizeVerifiedPayoutBeneficiary(db,{providerId,scopeType:"booking",scopeId:bookingId,asOf});}catch(error){throw new Response(`${PAYOUT_BLOCK_LABELS.no_beneficiary}: ${await messageOf(error)}`,{status:409});}
 const figures=await payoutFigures(db,item,money(item.gross_amount)),payoutId=`RPX-${crypto.randomUUID().slice(0,12).toUpperCase()}`,entryDate=isoDay(asOf);
 if(figures.net>0&&figures.net<MIN_PAYOUT)throw new Response(`${PAYOUT_BLOCK_LABELS.below_minimum}: Rs ${figures.net.toFixed(2)} after deductions`,{status:409});
 // Refuse before anything is written if the books cannot take the entry (for example a locked month).
 await prepareJournalPosting(db,{groupKey:`PAYOUT-RELEASE-${bookingId}`,entryDate,periodCode:periodOf(entryDate),sourceType:PAYOUT_JOURNAL_SOURCES.release,sourceId:bookingId,narration:"release check",lines:releaseLines({gross_amount:figures.gross,amount:figures.net,tds_amount:figures.tds.amount,recovery_deduction:figures.recovery})});
 // The release only lands on the row exactly as this click assessed it: a refund or dispute that the scheduled
 // check records in the meantime changes gross_amount or blocked_reason, and the click is refused instead.
 const claimed="EXISTS(SELECT 1 FROM provider_payout_queue_items WHERE booking_id=? AND payout_id=? AND status='released')";
 const statements=[
  db.prepare("UPDATE provider_payout_queue_items SET status='released',payout_id=?,released_by=?,released_at=?,release_reason=?,gross_amount=?,tds_section=?,tds_base=?,tds_amount=?,recovery_deduction=?,amount=?,blocked_reason=NULL,blocked_detail=NULL,checked_at=?,updated_at=? WHERE booking_id=? AND status='awaiting_release' AND due_at<=? AND ABS(gross_amount-?)<0.005 AND COALESCE(blocked_reason,'') IN ('','no_beneficiary')").bind(payoutId,actor,asOf,reason,figures.gross,figures.tds.section,figures.tds.base,figures.tds.amount,figures.recovery,figures.net,asOf,asOf,bookingId,asOf,figures.gross),
  ...(figures.net>=MIN_PAYOUT?[db.prepare(`INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,currency,rail,environment,status,due_at,razorpayx_contact_id,razorpayx_fund_account_id,idempotency_key,created_by,created_at,updated_at) SELECT ?,?,?,?,'INR','razorpayx','sandbox','queued_sandbox',?,?,?,?,?,?,? WHERE ${claimed}`).bind(payoutId,bookingId,providerId,figures.net,Number(item.due_at),beneficiary.razorpayxContactId,beneficiary.razorpayxFundAccountId,`payout-queue-${bookingId}`,actor,asOf,asOf,bookingId,payoutId)]:[]),
  ...figures.recoveries.flatMap(r=>[db.prepare(`INSERT INTO provider_payout_recovery_applications (recovery_id,booking_id,amount,created_at) SELECT ?,?,?,? WHERE ${claimed}`).bind(r.id,bookingId,r.amount,asOf,bookingId,payoutId),db.prepare(`UPDATE provider_payout_recoveries SET recovered_amount=ROUND(recovered_amount+?,2),status=CASE WHEN recovered_amount+?>=amount-0.004 THEN 'recovered' ELSE 'open' END,updated_at=? WHERE id=? AND ${claimed}`).bind(r.amount,r.amount,asOf,r.id,bookingId,payoutId)]),
  db.prepare(`INSERT INTO provider_payout_queue_events (id,booking_id,event_type,actor_id,detail_json,created_at) SELECT ?,?,'payout_released',?,?,? WHERE ${claimed}`).bind(crypto.randomUUID(),bookingId,actor,JSON.stringify({payoutId,gross:figures.gross,tds:figures.tds,recoveries:figures.recoveries,net:figures.net,reason,environment:"sandbox",liveMoney:false}),asOf,bookingId,payoutId),
 ];
 // Two releases for the same provider can both see one open recovery. The recovery table's CHECK refuses the
 // second deduction, which rolls back that whole release instead of short-paying the provider.
 let results:D1Result[];try{results=await db.batch(statements);}catch(error){if(/CHECK constraint failed[^\n]*recovered_amount/i.test(error instanceof Error?error.message:String(error)))throw new Response("An earlier overpayment by this provider was just taken off another payout; refresh and release again",{status:409});throw error;}
 if(changes(results[0])!==1){const current=await one(db,"SELECT * FROM provider_payout_queue_items WHERE booking_id=?",[bookingId]);if(current&&text(current.status)==="released")return{bookingId,status:"released",payoutId:text(current.payout_id),amount:money(current.amount),duplicatePrevented:true,environment:"sandbox",liveMoney:false};throw new Response("This payout changed while it was being released; refresh and try again",{status:409});}
 // The payout is released from here on. A bookkeeping step that fails now must not report the click as
 // refused: it is named in the result, and the scheduled check posts any missing release journal.
 let followUp:string|null=null;
 try{const saved=await one(db,"SELECT * FROM provider_payout_queue_items WHERE booking_id=?",[bookingId]);if(saved)await postReleaseJournal(db,saved,asOf);await bridgeVerticalLedgers(db,bookingId,"released_sandbox",payoutId,asOf);}catch(error){followUp=`Released, but the books were not updated yet; the next payout check retries: ${await messageOf(error)}`;}
 return{bookingId,status:"released",payoutId,followUp,payoutRecordCreated:figures.net>=MIN_PAYOUT,providerId,grossAmount:figures.gross,tds:figures.tds.amount,recoveryDeducted:figures.recovery,amount:figures.net,duplicatePrevented:false,environment:"sandbox",liveMoney:false};
}

/** Nothing reconciled 2110-Provider Payable against payouts before; this does, booking by booking. */
export async function reconcileProviderPayable(db:Db,input:{limit?:number}={}){
 await ensureProviderPayoutQueueTables(db);
 const rows=await many(db,`SELECT q.booking_id,q.status,q.gross_amount,ROUND(COALESCE((SELECT SUM(j.credit-j.debit) FROM finance_journal_entries j WHERE j.source_id=q.booking_id AND j.account_code=? AND j.posted=1 AND j.source_type IN (?,?,?)),0),2) ledger FROM provider_payout_queue_items q ORDER BY q.updated_at DESC LIMIT ?`,[PAYOUT_ACCOUNTS.providerPayable,PAYOUT_JOURNAL_SOURCES.completion,PAYOUT_JOURNAL_SOURCES.refundAdjustment,PAYOUT_JOURNAL_SOURCES.release,Math.max(1,Math.min(1000,Number(input.limit||250)))]);
 const mismatches=rows.map(row=>{const expected=text(row.status)==="awaiting_release"?money(row.gross_amount):0,ledger=round(Number(row.ledger||0));return{bookingId:text(row.booking_id),status:text(row.status),expected,ledger,difference:round(ledger-expected)};}).filter(row=>Math.abs(row.difference)>0.01);
 return{checked:rows.length,ok:mismatches.length===0,mismatches};
}

export async function getProviderPayoutQueueDashboard(db:Db,input:{asOf?:number;limit?:number}={}){
 await ensureProviderPayoutQueueTables(db);
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(500,Number(input.limit||250)));
 const[hold,items,candidates,recoveries,reconciliation]=await Promise.all([providerPayoutHoldSetting(db,asOf),many(db,"SELECT q.*,p.status payout_status,p.provider_reference FROM provider_payout_queue_items q LEFT JOIN provider_order_payouts p ON p.id=q.payout_id ORDER BY CASE q.status WHEN 'awaiting_release' THEN 0 WHEN 'released' THEN 1 ELSE 2 END,q.due_at DESC LIMIT ?",[limit]),many(db,"SELECT * FROM provider_payout_candidates ORDER BY COALESCE(due_at,checked_at) LIMIT ?",[limit]),many(db,"SELECT * FROM provider_payout_recoveries WHERE status='open' ORDER BY created_at DESC LIMIT ?",[limit]),reconcileProviderPayable(db,{limit})]);
 const queue=items.map(row=>{const status=text(row.status),block=text(row.blocked_reason) as ProviderPayoutBlock|"",payoutStatus=text(row.payout_status);const labelled:Row&{statusLabel:string;blockedLabel:string|null;releasable:boolean}={...row,statusLabel:status==="released"?(payoutStatus?`Released, ${SANDBOX_PAYOUT_LABELS[payoutStatus]||payoutStatus.replaceAll("_"," ")}`:"Released, nothing left to send after recovery"):status==="cancelled"?(text(row.cancel_reason)==="refunded_in_full"?"Cancelled, refunded in full":"Cancelled, nothing is owed in the books"):block?`Waiting: ${PAYOUT_BLOCK_LABELS[block]}`:PAYOUT_STATUS_LABELS[status]||status,blockedLabel:block?PAYOUT_BLOCK_LABELS[block]:null,releasable:status==="awaiting_release"&&Number(row.due_at)<=asOf&&!block&&!(Number(row.amount)>0&&Number(row.amount)<MIN_PAYOUT)};return labelled;});
 const upcoming=candidates.map(row=>{const block=text(row.reason) as ProviderPayoutBlock;return{...row,reasonLabel:PAYOUT_BLOCK_LABELS[block]||text(row.reason)};});
 const awaiting=queue.filter(row=>text(row.status)==="awaiting_release");
 return{holdDays:hold.holdDays,hold,queue,upcoming,recoveries,reconciliation,totals:{awaitingRelease:awaiting.length,awaitingAmount:round(awaiting.reduce((sum,row)=>sum+Number(row.amount||0),0)),releasable:queue.filter(row=>row.releasable).length,openRecoveryAmount:round(recoveries.reduce((sum,row)=>sum+Number(row.amount||0)-Number(row.recovered_amount||0),0))},policy:{holdDays:hold.holdDays,countedFrom:"service_completion",calendarDays:true,autoQueued:true,releaseClicks:1,paymentSource:"2110-Provider Payable in the finance journal",environment:"sandbox",livePayout:false,liveMoneyGate:"existing live-payout approvals"}};
}
