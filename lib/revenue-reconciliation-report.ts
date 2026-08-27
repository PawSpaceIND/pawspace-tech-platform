/**
 * Recognised revenue and collected revenue, published side by side and reconciled. [PTJA-W2-08-F03]
 *
 * WHAT WAS MEASURED. For one CLOSED and locked month, two governed finance surfaces published two
 * different revenue figures for the same period with nothing reconciling them:
 *
 *   monthlyCloseView('2026-07')  -> revenue {bookings:15000, bookingCount:2}, and a checklist item
 *                                   `revenue_reconciled` reading ok:TRUE at value 15000
 *   generatePnlReport('2026-07') -> totalTurnoverAmount 5000, dataSource 'platform_live'
 *
 * The close returns a frozen snapshot; the P&L recomputes live. A late refund cancelled a Rs 10,000
 * booking inside the locked period, so the two drifted permanently apart - and neither surface reported
 * the refund at all. A reader could not tell which figure was authoritative, while the close asserted
 * that revenue was reconciled.
 *
 * THE APPROVED ANSWER IS NOT TO PICK A WINNER. Both stay authoritative, for different questions:
 * recognised revenue is the P&L figure, collected revenue is the cash-flow and collection figure, and
 * they are never forced to match. What was missing was a report that states both, says what each is FOR,
 * and explains the whole of the difference between them.
 *
 * THE RECOGNITION RULE, as approved: service revenue is recognised when the service is COMPLETED and
 * financially approved - a conjunction, because recognising on delivery alone books revenue for money
 * the business may never see, and recognising on payment alone books revenue for work not yet done.
 * Advance payments stay customer advances until delivery. Refunds and cancellations adjust rather than
 * disappear.
 *
 * THE BRIDGE. recognised - collected is not a number on its own; every component of it is named, and the
 * components are asserted to add up to the gap. "We are 10,000 apart" without saying why is the same
 * problem in a nicer format.
 */
import{round}from"./finance-accounts";
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

export const REVENUE_RECOGNITION_DOMAIN="revenue_recognition_policy";

export type RevenueRecognitionConfig={
  /** Booking statuses that count as the service having been delivered. */
  deliveredStatuses:string[];
  /** Payment statuses that count as financially approved. */
  approvedPaymentStatuses:string[];
  /** Statuses excluded from every revenue figure. */
  excludedStatuses:string[];
  /** The two figures are reported side by side. Nothing may switch this off. */
  forceRecognisedToMatchCollected:false;
};

export const APPROVED_REVENUE_RECOGNITION:RevenueRecognitionConfig={
  deliveredStatuses:["completed"],
  approvedPaymentStatuses:["captured","paid","settled"],
  excludedStatuses:["cancelled","draft"],
  forceRecognisedToMatchCollected:false,
};

registerServicePolicyDomain<RevenueRecognitionConfig&Record<string,unknown>>({
  domain:REVENUE_RECOGNITION_DOMAIN,
  label:"Revenue recognition and reporting",
  managePermission:"settings.manage",
  defaults:APPROVED_REVENUE_RECOGNITION as RevenueRecognitionConfig&Record<string,unknown>,
  problem(config){
    for(const key of["deliveredStatuses","approvedPaymentStatuses","excludedStatuses"]){
      const value=config[key];
      if(!Array.isArray(value)||!value.length)return `${key} must be a non-empty list`;
    }
    const delivered=(config.deliveredStatuses as string[]).map(String);
    const excluded=(config.excludedStatuses as string[]).map(String);
    const overlap=delivered.filter(status=>excluded.includes(status));
    if(overlap.length)return `A status cannot be both delivered and excluded: ${overlap.join(", ")}`;
    // The whole point of the approved decision is that the two figures answer different questions.
    // A configuration that forced them together would re-create the defect with a switch.
    if(config.forceRecognisedToMatchCollected===true)return "Recognised and collected revenue must never be forced to match - they answer different questions";
    return null;
  },
});

export async function resolveRevenueRecognitionPolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<RevenueRecognitionConfig&Record<string,unknown>>(db,REVENUE_RECOGNITION_DOMAIN,scope,at);
}

/** A parenthesised, escaped literal list. The values come from validated configuration, never from a
 *  request, and the repository's in-list guard forbids building `?` placeholders from an array. */
const inList=(values:string[])=>`(${values.map(value=>`'${value.replace(/'/g,"''")}'`).join(",")})`;

export type RevenueReconciliation={
  period:string;
  recognisedRevenue:number;
  grossCollections:number;
  refunds:number;
  netCollections:number;
  deferredRevenue:number;
  outstandingReceivables:number;
  recognisedMinusCollected:number;
  pendingFinanceVerification:number;
  forcedToMatch:false;
  authority:{recognisedRevenue:string;collections:string};
  reconciliation:{basis:string;components:Array<{label:string;amount:number;explanation:string}>};
};

/**
 * The monthly revenue pack: both figures, every line the approved policy names, and a bridge whose
 * components add up to the difference.
 */
export async function monthlyRevenueReconciliation(db:Db,input:{period:string;serviceCode?:string|null;cityId?:string|null}):Promise<RevenueReconciliation>{
  const period=String(input.period||"").trim();
  if(!/^\d{4}-\d{2}$/.test(period))throw new Error("A period (YYYY-MM) is required");
  const{ensureCollectionLedgerTables,collectionsTotal}=await import("./collection-ledger");
  await ensureCollectionLedgerTables(db);
  const policy=await resolveRevenueRecognitionPolicy(db,{serviceCode:input.serviceCode,cityId:input.cityId});
  const config=policy.config;

  // Literal status lists rather than bound placeholders: the repository's in-list guard forbids building
  // `?` placeholders from an array, and these values come from validated configuration, never from a
  // request. Each is escaped on the way in.
  const delivered=inList(config.deliveredStatuses.map(String));
  const approved=inList(config.approvedPaymentStatuses.map(String));
  const excluded=inList(config.excludedStatuses.map(String));

  const bookingsTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_bookings'").first<Row>();
  const monthStart=`${period}-01`,monthEnd=`${period}-32`;

  let recognised=0,receivables=0,deferred=0;
  if(bookingsTable){
    // Recognised: delivered AND financially approved. A conjunction, per the approved rule.
    const recognisedRow=await db.prepare(
      `SELECT COALESCE(SUM(b.total_amount),0) total FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id
       WHERE b.status IN ${delivered} AND p.status IN ${approved} AND b.status NOT IN ${excluded}
         AND substr(b.scheduled_start,1,7)=?`).bind(period).first<Row>();
    recognised=round(Number(recognisedRow?.total||0));

    // Delivered but not yet paid: work done, money not in. A receivable, not revenue.
    const receivableRow=await db.prepare(
      `SELECT COALESCE(SUM(b.total_amount),0) total FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id
       WHERE b.status IN ${delivered} AND p.status NOT IN ${approved} AND b.status NOT IN ${excluded}
         AND substr(b.scheduled_start,1,7)=?`).bind(period).first<Row>();
    receivables=round(Number(receivableRow?.total||0));

    // Paid but not yet delivered: a customer advance, held as deferred revenue until the service happens.
    const deferredRow=await db.prepare(
      `SELECT COALESCE(SUM(p.amount),0) total FROM canonical_bookings b JOIN booking_payments p ON p.booking_id=b.id
       WHERE b.status NOT IN ${delivered} AND p.status IN ${approved} AND b.status NOT IN ${excluded}
         AND substr(b.scheduled_start,1,7)=?`).bind(period).first<Row>();
    deferred=round(Number(deferredRow?.total||0));
  }

  const collections=await collectionsTotal(db,period);
  const grossCollections=collections.verified;
  const refunds=collections.refunds;
  const netCollections=round(grossCollections-refunds);
  const gap=round(recognised-grossCollections);

  /*
   * The bridge. Deferred revenue is money collected for work not yet done, so it pushes collections
   * ABOVE recognition; receivables are work done without money, so they push recognition above
   * collections. Anything left over is stated as its own line rather than absorbed silently - a residual
   * nobody can name is exactly the kind of unexplained difference this report exists to end.
   */
  const components=[
    {label:"Deferred revenue (collected, not yet delivered)",amount:round(-deferred),
     explanation:"Money taken for services that have not happened yet. It is a collection today and revenue when the service is delivered."},
    {label:"Outstanding receivables (delivered, not yet collected)",amount:round(receivables),
     explanation:"Services delivered whose payment has not been approved yet. Revenue today, cash later."},
  ];
  const named=round(components.reduce((sum,item)=>sum+item.amount,0));
  const residual=round(gap-named);
  if(Math.abs(residual)>=0.01){
    components.push({label:"Unexplained residual",amount:residual,
      explanation:"The part of the difference these components do not account for. A non-zero value here is a finance question, not a rounding artefact."});
  }

  return{
    period,recognisedRevenue:recognised,grossCollections,refunds,netCollections,
    deferredRevenue:deferred,outstandingReceivables:receivables,recognisedMinusCollected:gap,
    pendingFinanceVerification:collections.pendingVerification,
    forcedToMatch:false,
    authority:{
      recognisedRevenue:"Authoritative for the P&L and every revenue figure. Accrual basis: service delivered and financially approved.",
      collections:"Authoritative for cash flow and collections. Cash basis: money actually received, net of refunds.",
    },
    reconciliation:{basis:"recognised revenue minus gross collections",components},
  };
}
