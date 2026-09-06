/**
 * Unit Economics - the per-service money ladder and health monitors, from canonical tables only.
 *
 * Ladder per service: GMV -> discounts -> tax -> provider payout -> payment fee -> refunds ->
 * variable cost -> contribution margin. Components that have a real canonical source are computed
 * exactly (bookings, coupon/PawPoints/wallet discounts, provider_order_payouts, processed refund
 * cases). Components with NO configured source (tax policy, payment gateway fees, variable
 * cost/COGS) are reported as configuration_required and EXCLUDED from the known-contribution
 * figure instead of being silently valued at zero - a service must never look profitable because
 * its costs are unrecorded. Monitors: repeat rate, cancellation rate, CSAT from real reviews,
 * complaints per 100 bookings, revenue per provider-day, LTV of active customers, roster
 * utilisation and CAC (only when marketing spend facts exist).
 */

import{chunkedIn}from"./d1-chunked-in";
type Db=D1Database;
type Row=Record<string,unknown>;

const round2=(value:number)=>Math.round(value*100)/100;
const pct=(part:number,whole:number)=>whole>0?Math.round((part/whole)*1000)/10:null;

async function tableExists(db:Db,name:string){const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();return Boolean(row);}

/**
 * Table-existence guards are memoised for the life of one request.
 *
 * Each guard is its own sqlite_master read, and each of these reads is now wrapped in chunkedIn, so
 * an unmemoised guard costs one extra subrequest PER CHUNK: 7 guarded lookups over 5,000 bookings
 * spent 1,012 D1 subrequests where a Worker invocation is allowed about 1,000. The chunking fix would
 * then have re-broken the screen it was fixing, one order of magnitude further up.
 *
 * The memo is per call, not per module. A module-level cache would remember "table absent" after
 * another module ran CREATE TABLE IF NOT EXISTS, and go on reporting zeros for the rest of the
 * isolate's life - the same confident-zero failure this file exists to remove.
 */
type Guards=Map<string,Promise<boolean>>;
function guardCache():Guards{return new Map();}
function knownTable(db:Db,guards:Guards,name:string){const hit=guards.get(name);if(hit)return hit;const probe=tableExists(db,name);guards.set(name,probe);return probe;}
async function safeAll(db:Db,guard:string[],sql:string,binds:unknown[],guards:Guards=guardCache()):Promise<Row[]>{for(const table of guard)if(!await knownTable(db,guards,table))return[];const rows=await db.prepare(sql).bind(...binds).all<Row>();return rows.results;}

export type UnitEconomicsFilters={from?:string;to?:string;cityId?:string};

export async function buildUnitEconomics(db:Db,input:UnitEconomicsFilters={}){
 const from=input.from||"1970-01-01",to=input.to||"2999-12-31";
 const filters=["substr(scheduled_start,1,10)>=?","substr(scheduled_start,1,10)<=?"],binds:unknown[]=[from,to];
 if(input.cityId){filters.push("city_id=?");binds.push(input.cityId);}
 const where=filters.join(" AND ");
 const guards=guardCache();
 const bookings=await safeAll(db,["canonical_bookings"],`SELECT id,customer_id,provider_id,service_code,status,total_amount,scheduled_start,scheduled_end FROM canonical_bookings WHERE ${where}`,binds,guards);
 if(!bookings.length)return{from,to,cityId:input.cityId??null,services:{},company:emptyCompany(),dataCoverage:coverageNote(),truth:truthNote()};

 const ids=bookings.map(row=>String(row.id));
 const active=bookings.filter(row=>!["cancelled","draft"].includes(String(row.status)));
 const serviceOf=new Map(bookings.map(row=>[String(row.id),String(row.service_code)]));

 // Real per-booking money components (each guarded on its owning table)
 const coupons=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["coupon_redemptions"],`SELECT booking_id,discount_amount FROM coupon_redemptions WHERE status='consumed' AND booking_id IN (${placeholders})`,chunk,guards));
 const points=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["paw_points_ledger"],`SELECT booking_id,points FROM paw_points_ledger WHERE entry_type='redeemed' AND booking_id IN (${placeholders})`,chunk,guards));
 const wallet=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["pawspace_wallet_ledger"],`SELECT source_id booking_id,applied_value FROM pawspace_wallet_ledger WHERE entry_type='redeem' AND source_id IN (${placeholders})`,chunk,guards));
 const payouts=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["provider_order_payouts"],`SELECT booking_id,amount FROM provider_order_payouts WHERE booking_id IN (${placeholders})`,chunk,guards));
 // Refunds are counted in every state that means the money actually MOVED, not just the gateway's own.
 // This matched the literal 'processed', which is written ONLY by the Razorpay refund.processed webhook
 // path. The cross-vertical STAFF refund workflow in app/api/booking-operations declares its state
 // machine as {requested:[approved,rejected], approved:[processing], processing:[completed]} and
 // terminates at 'completed' - a value this never matched - so every refund settled by staff through the
 // ops console was invisible here. Measured: a fully refunded Rs 5,000 month reported refunds 0 and
 // grooming at 100% contribution margin, when its true known contribution was zero. A vertical with
 // heavy manual refunds looked like the most profitable one on the board.
 //
 // 'requested' and 'rejected' are deliberately excluded: an unapproved or refused request has moved no
 // money. This is the same set the refund ceiling in app/api/grooming-payment-sandbox already uses, so
 // the two agree on what "refunded" means.
 const refunds=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["booking_refund_cases"],`SELECT booking_id,amount FROM booking_refund_cases WHERE status IN ('processing','processed','completed') AND booking_id IN (${placeholders})`,chunk,guards));
 const reviews=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["service_reviews"],`SELECT booking_id,stars FROM service_reviews WHERE booking_id IN (${placeholders})`,chunk,guards));
 const tickets=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,["customer_experience_tickets"],`SELECT booking_id FROM customer_experience_tickets WHERE booking_id IN (${placeholders})`,chunk,guards));

 type Ladder={gmv:number;orders:number;cancelled:number;discounts:number;providerPayout:number;refunds:number;tax:null;paymentFee:null;variableCost:null;contributionKnown:number;contributionPctOfGmv:number|null;avgOrderValue:number|null;reviews:number;csatAvgStars:number|null;csatPct:number|null;complaintsPer100:number|null;repeatRatePct:number|null;revenuePerProviderDay:number|null};
 const ladders:Record<string,Ladder>={};
 const ladderFor=(service:string)=>ladders[service]??={gmv:0,orders:0,cancelled:0,discounts:0,providerPayout:0,refunds:0,tax:null,paymentFee:null,variableCost:null,contributionKnown:0,contributionPctOfGmv:null,avgOrderValue:null,reviews:0,csatAvgStars:null,csatPct:null,complaintsPer100:null,repeatRatePct:null,revenuePerProviderDay:null};

 for(const row of bookings){const ladder=ladderFor(String(row.service_code));if(["cancelled","draft"].includes(String(row.status))){ladder.cancelled++;continue;}ladder.orders++;ladder.gmv+=Number(row.total_amount||0);}
 const addByBooking=(rows:Row[],pick:(row:Row)=>number,apply:(ladder:Ladder,value:number)=>void)=>{for(const row of rows){const service=serviceOf.get(String(row.booking_id));if(!service)continue;apply(ladderFor(service),pick(row));}};
 addByBooking(coupons,row=>Number(row.discount_amount||0),(ladder,value)=>{ladder.discounts+=value;});
 addByBooking(points,row=>Math.abs(Number(row.points||0))*0.5,(ladder,value)=>{ladder.discounts+=value;});
 addByBooking(wallet,row=>Number(row.applied_value||0),(ladder,value)=>{ladder.discounts+=value;});
 addByBooking(payouts,row=>Number(row.amount||0),(ladder,value)=>{ladder.providerPayout+=value;});
 addByBooking(refunds,row=>Number(row.amount||0),(ladder,value)=>{ladder.refunds+=value;});

 // Monitors per service
 const starsByService=new Map<string,number[]>(),ticketsByService=new Map<string,number>();
 for(const row of reviews){const service=serviceOf.get(String(row.booking_id));if(!service)continue;const list=starsByService.get(service)??[];list.push(Number(row.stars||0));starsByService.set(service,list);}
 for(const row of tickets){const service=serviceOf.get(String(row.booking_id));if(!service)continue;ticketsByService.set(service,(ticketsByService.get(service)||0)+1);}
 const customersByService=new Map<string,Map<string,number>>(),providerDaysByService=new Map<string,Set<string>>();
 for(const row of active){const service=String(row.service_code);const customers=customersByService.get(service)??new Map<string,number>();customers.set(String(row.customer_id),(customers.get(String(row.customer_id))||0)+1);customersByService.set(service,customers);const days=providerDaysByService.get(service)??new Set<string>();days.add(`${String(row.provider_id)}:${String(row.scheduled_start).slice(0,10)}`);providerDaysByService.set(service,days);}

 for(const [service,ladder] of Object.entries(ladders)){
  ladder.gmv=round2(ladder.gmv);ladder.discounts=round2(ladder.discounts);ladder.providerPayout=round2(ladder.providerPayout);ladder.refunds=round2(ladder.refunds);
  ladder.contributionKnown=round2(ladder.gmv-ladder.discounts-ladder.providerPayout-ladder.refunds);
  ladder.contributionPctOfGmv=ladder.gmv>0?Math.round((ladder.contributionKnown/ladder.gmv)*1000)/10:null;
  ladder.avgOrderValue=ladder.orders>0?round2(ladder.gmv/ladder.orders):null;
  const stars=starsByService.get(service)||[];
  ladder.reviews=stars.length;
  ladder.csatAvgStars=stars.length?Math.round((stars.reduce((sum,value)=>sum+value,0)/stars.length)*10)/10:null;
  ladder.csatPct=stars.length?pct(stars.filter(value=>value>=4).length,stars.length):null;
  ladder.complaintsPer100=ladder.orders>0?Math.round(((ticketsByService.get(service)||0)/ladder.orders)*1000)/10:null;
  const customers=customersByService.get(service);
  ladder.repeatRatePct=customers&&customers.size>0?pct([...customers.values()].filter(count=>count>=2).length,customers.size):null;
  const providerDays=providerDaysByService.get(service);
  ladder.revenuePerProviderDay=providerDays&&providerDays.size>0?round2(ladder.gmv/providerDays.size):null;
 }

 // Company-level monitors
 const activeCustomers=[...new Set(active.map(row=>String(row.customer_id)))];
 let ltvPerActiveCustomer:number|null=null;
 if(activeCustomers.length){
  const lifetime=await chunkedIn(activeCustomers,(chunk,placeholders)=>safeAll(db,["canonical_bookings"],`SELECT customer_id,SUM(total_amount) total FROM canonical_bookings WHERE status NOT IN ('cancelled','draft') AND customer_id IN (${placeholders}) GROUP BY customer_id`,chunk,guards));
  ltvPerActiveCustomer=round2(lifetime.reduce((sum,row)=>sum+Number(row.total||0),0)/activeCustomers.length);
 }
 // Roster utilisation: booked reservation hours / rostered window hours across the window
 let utilisationPct:number|null=null;
 if(await tableExists(db,"scheduling_reservations")&&await tableExists(db,"scheduling_availability")){
  const reservations=await safeAll(db,["scheduling_reservations"],"SELECT scheduled_start,scheduled_end FROM scheduling_reservations WHERE status!='cancelled' AND substr(scheduled_start,1,10)>=? AND substr(scheduled_start,1,10)<=?",[from,to],guards);
  const bookedHours=reservations.reduce((sum,row)=>sum+Math.max(0,(new Date(String(row.scheduled_end)).getTime()-new Date(String(row.scheduled_start)).getTime())/3_600_000),0);
  const roster=await safeAll(db,["scheduling_availability"],"SELECT windows_json FROM scheduling_availability WHERE date>=? AND date<=?",[from,to],guards);
  let rosterHours=0;
  for(const row of roster){let windows:string[]=[];try{windows=JSON.parse(String(row.windows_json||"[]"));}catch{windows=[];}for(const window of windows){const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);if(match)rosterHours+=Math.max(0,(Number(match[3])*60+Number(match[4])-Number(match[1])*60-Number(match[2]))/60);}}
  utilisationPct=rosterHours>0?pct(bookedHours,rosterHours):null;
 }
 // CAC: only when real marketing spend facts exist - never an invented number
 let cac:{status:string;spend:number|null;newCustomers:number|null;cacPerNewCustomer:number|null}={status:"configuration_required",spend:null,newCustomers:null,cacPerNewCustomer:null};
 if(await tableExists(db,"marketing_attribution_facts")){
  const spendRow=await db.prepare("SELECT COALESCE(SUM(spend_amount),0) spend,COUNT(*) rows FROM marketing_attribution_facts WHERE spend_amount IS NOT NULL").first<Row>();
  const spend=Number(spendRow?.spend||0);
  if(Number(spendRow?.rows||0)>0&&spend>0){
   const firsts=await safeAll(db,["canonical_bookings"],`SELECT customer_id,MIN(substr(scheduled_start,1,10)) first_day FROM canonical_bookings WHERE status NOT IN ('cancelled','draft') GROUP BY customer_id`,[],guards);
   const newCustomers=firsts.filter(row=>String(row.first_day)>=from&&String(row.first_day)<=to).length;
   cac={status:"derived_from_recorded_spend",spend:round2(spend),newCustomers,cacPerNewCustomer:newCustomers>0?round2(spend/newCustomers):null};
  }
 }

 const totals={gmv:round2(active.reduce((sum,row)=>sum+Number(row.total_amount||0),0)),orders:active.length,cancelled:bookings.length-active.length,discounts:round2(Object.values(ladders).reduce((sum,ladder)=>sum+ladder.discounts,0)),providerPayout:round2(Object.values(ladders).reduce((sum,ladder)=>sum+ladder.providerPayout,0)),refunds:round2(Object.values(ladders).reduce((sum,ladder)=>sum+ladder.refunds,0))};
 return{
  from,to,cityId:input.cityId??null,
  services:ladders,
  company:{...totals,contributionKnown:round2(totals.gmv-totals.discounts-totals.providerPayout-totals.refunds),cancellationRatePct:pct(totals.cancelled,bookings.length),activeCustomers:activeCustomers.length,ltvPerActiveCustomer,utilisationPct,cac},
  dataCoverage:coverageNote(),
  truth:truthNote(),
 };
}

function emptyCompany(){return{gmv:0,orders:0,cancelled:0,discounts:0,providerPayout:0,refunds:0,contributionKnown:0,cancellationRatePct:null,activeCustomers:0,ltvPerActiveCustomer:null,utilisationPct:null,cac:{status:"configuration_required",spend:null,newCustomers:null,cacPerNewCustomer:null}};}
function coverageNote(){return{
 gmv:"canonical_bookings (cancelled/draft excluded)",
 discounts:"coupon_redemptions + paw_points_ledger redemptions (Rs.0.50/point) + pawspace_wallet_ledger applied value",
 providerPayout:"provider_order_payouts (sandbox rail)",
 refunds:"booking_refund_cases status=processed",
 tax:"configuration_required - no published tax policy; excluded from contribution, never zeroed",
 paymentFee:"configuration_required - gateway fees are sandbox; excluded from contribution, never zeroed",
 variableCost:"configuration_required - COGS/variable cost rules not configured; excluded, never zeroed",
};}
function truthNote(){return{source:"canonical tables only",syntheticNumbers:false,contributionIsKnownComponentsOnly:true,productionReady:false};}
