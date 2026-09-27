/*
 * ONE payout hold for every provider payout, in every vertical. [Owner decision 6, 26 Sept 2026]
 *
 * A commission provider becomes payable a fixed number of calendar days after the service completion
 * event. The owner set it to 7 days for grooming, boarding, sitting, walking, training, taxi, funeral,
 * relocation and food vendors alike. It used to be hard-coded as 5 days in six places, 24 hours for
 * grooming readiness and 0 days for funeral, relocation and food; every one of those now reads this.
 *
 * The setting is effective-dated and append-only, so a change never silently moves the due date of a
 * payout that was already running under the previous hold: the hold that applies to a job is the one
 * in force when the service was completed. Every change carries who made it and why.
 *
 * [Owner decision, 27 Sept 2026] For testing, staging can drop the hold to 0 days so a UAT payout is
 * releasable immediately. This is gated behind the same five-part UAT sandbox check every other UAT-only
 * relaxation in this codebase uses (uatPayoutBeneficiaryGate): PAWSPACE_SCHEDULING_ENV=uat, RazorpayX
 * sandbox, live not approved, an rzp_test_ key, and not the production deployment. Without that gate the
 * floor stays 1 day everywhere, production included.
 */
import{uatPayoutBeneficiaryGate}from"./uat-payout-beneficiaries";
type Db=D1Database;
type Row=Record<string,unknown>;
type Env=Record<string,unknown>|null|undefined;
export const DEFAULT_PROVIDER_PAYOUT_HOLD_DAYS=7;
export const PROVIDER_PAYOUT_HOLD_LIMITS={minDays:1,maxDays:60} as const;
export const PROVIDER_PAYOUT_HOLD_TEST_MIN_DAYS=0;
export const PROVIDER_PAYOUT_HOLD_COUNTED_FROM="service_completion" as const;
const DAY_MS=86_400_000;
const text=(value:unknown)=>String(value??"").trim();
const validDays=(value:unknown,allowZero:boolean)=>{const days=Number(value),min=allowZero?PROVIDER_PAYOUT_HOLD_TEST_MIN_DAYS:PROVIDER_PAYOUT_HOLD_LIMITS.minDays;return Number.isInteger(days)&&days>=min&&days<=PROVIDER_PAYOUT_HOLD_LIMITS.maxDays;};
const ready=new WeakSet<Db>();

export async function ensureProviderPayoutHoldTables(db:Db){
 if(ready.has(db))return;
 // One-time migration: a table created before 27 Sept 2026 has hold_days>=1 baked into its CHECK constraint, which
 // SQLite/D1 cannot loosen in place. Rebuild it with hold_days>=0 so a gated staging/test override can be recorded;
 // production behaviour is unchanged because validDays() still enforces >=1 there regardless of what the column allows.
 const existing=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='finance_payout_hold_settings'").first<Row>();
 if(existing&&/hold_days\s*>=\s*1\b/.test(text(existing.sql))){
  await db.batch([
   db.prepare("DROP TRIGGER IF EXISTS trg_finance_payout_hold_no_update"),
   db.prepare("DROP TRIGGER IF EXISTS trg_finance_payout_hold_no_delete"),
   db.prepare("ALTER TABLE finance_payout_hold_settings RENAME TO finance_payout_hold_settings_pre_floor0"),
   db.prepare("CREATE TABLE finance_payout_hold_settings (id TEXT PRIMARY KEY,hold_days INTEGER NOT NULL CHECK(hold_days>=0 AND hold_days<=60),counted_from TEXT NOT NULL DEFAULT 'service_completion' CHECK(counted_from='service_completion'),effective_from INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
   db.prepare("INSERT INTO finance_payout_hold_settings SELECT * FROM finance_payout_hold_settings_pre_floor0"),
   db.prepare("DROP TABLE finance_payout_hold_settings_pre_floor0"),
   db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_payout_hold_effective ON finance_payout_hold_settings(effective_from,created_at)"),
   db.prepare("CREATE TRIGGER trg_finance_payout_hold_no_update BEFORE UPDATE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END"),
   db.prepare("CREATE TRIGGER trg_finance_payout_hold_no_delete BEFORE DELETE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END"),
  ]);
  ready.add(db);return;
 }
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_payout_hold_settings (id TEXT PRIMARY KEY,hold_days INTEGER NOT NULL CHECK(hold_days>=0 AND hold_days<=60),counted_from TEXT NOT NULL DEFAULT 'service_completion' CHECK(counted_from='service_completion'),effective_from INTEGER NOT NULL,reason TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_payout_hold_effective ON finance_payout_hold_settings(effective_from,created_at)"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_finance_payout_hold_no_update BEFORE UPDATE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_finance_payout_hold_no_delete BEFORE DELETE ON finance_payout_hold_settings BEGIN SELECT RAISE(ABORT,'payout_hold_settings_append_only'); END"),
 ]);
 ready.add(db);
}

/** Hold in whole calendar days for a service completed at `at`: the owner's 7 days until Finance sets another. */
export async function providerPayoutHoldDays(db:Db,at=Date.now()){await ensureProviderPayoutHoldTables(db);const row=await db.prepare("SELECT hold_days FROM finance_payout_hold_settings WHERE effective_from<=? ORDER BY effective_from DESC,created_at DESC LIMIT 1").bind(Number(at)).first<Row>();
 // Reading back a stored row trusts it as-is (write time already enforced whichever floor applied then, 0 or 1);
 // this is only a corruption guard against a row outside the column's own 0-60 range.
 const stored=Number(row?.hold_days);return row&&Number.isInteger(stored)&&stored>=0&&stored<=PROVIDER_PAYOUT_HOLD_LIMITS.maxDays?stored:DEFAULT_PROVIDER_PAYOUT_HOLD_DAYS;}

/** The moment a provider becomes payable: the completion event plus the hold in force at that moment. */
export async function providerPayoutDueAt(db:Db,completedAt:number){const at=Number(completedAt);if(!Number.isFinite(at)||at<=0)throw new Error("A service completion time is required to work out the payout date");return at+(await providerPayoutHoldDays(db,at))*DAY_MS;}

export async function setProviderPayoutHoldDays(db:Db,input:{days:number;reason:string;actor:string;effectiveFrom?:number},env?:Env){await ensureProviderPayoutHoldTables(db);const allowZero=Boolean(env)&&uatPayoutBeneficiaryGate(env);if(!validDays(input.days,allowZero))throw new Response(`The payout hold must be a whole number of days from ${allowZero?PROVIDER_PAYOUT_HOLD_TEST_MIN_DAYS:PROVIDER_PAYOUT_HOLD_LIMITS.minDays} to ${PROVIDER_PAYOUT_HOLD_LIMITS.maxDays}`,{status:400});const reason=text(input.reason),actor=text(input.actor);if(reason.length<8)throw new Response("Give a reason of at least 8 characters for changing the payout hold",{status:400});if(!actor)throw new Response("The person changing the payout hold must be known",{status:400});const now=Date.now(),effectiveFrom=Number.isFinite(Number(input.effectiveFrom))&&Number(input.effectiveFrom)>0?Number(input.effectiveFrom):now;
 // Never back-dated: a past start would silently move the due date of jobs already completed under the old hold.
 if(effectiveFrom<now-5*60_000)throw new Response("A payout hold change can start now or later, not in the past",{status:400});const id=`PHOLD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO finance_payout_hold_settings (id,hold_days,counted_from,effective_from,reason,created_by,created_at) VALUES (?,?,'service_completion',?,?,?,?)").bind(id,Number(input.days),effectiveFrom,reason,actor,now).run();return{id,holdDays:Number(input.days),countedFrom:PROVIDER_PAYOUT_HOLD_COUNTED_FROM,effectiveFrom,reason,changedBy:actor};}

export async function providerPayoutHoldSetting(db:Db,at=Date.now()){await ensureProviderPayoutHoldTables(db);const holdDays=await providerPayoutHoldDays(db,at);const history=(await db.prepare("SELECT id,hold_days,effective_from,reason,created_by,created_at FROM finance_payout_hold_settings ORDER BY effective_from DESC,created_at DESC LIMIT 20").all<Row>()).results||[];return{holdDays,countedFrom:PROVIDER_PAYOUT_HOLD_COUNTED_FROM,calendarDays:true,defaultDays:DEFAULT_PROVIDER_PAYOUT_HOLD_DAYS,limits:PROVIDER_PAYOUT_HOLD_LIMITS,history};}
