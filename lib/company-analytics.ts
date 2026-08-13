import{createDegradationLog,degradationNotice,type DegradationLog}from"./degraded-reads";
import { attributeGroomingBookingCosts } from "./grooming-cost-attribution";
import{chunkedIn}from"./d1-chunked-in";

type Row=Record<string,unknown>;
const rows=<T=Row>(r:{results?:unknown[]})=>(r.results||[]) as T[];
// Every guarded read records what it could not read. An empty list that came from a failure is not
// the same fact as an empty list that came from an empty table, and the difference decides whether a
// screen shows Rs 0 or "payments could not be read".
async function safeAll(db:D1Database,sql:string,binds:unknown[]=[],log?:DegradationLog,source?:string){try{let q=db.prepare(sql);if(binds.length)q=q.bind(...binds);return rows(await q.all<Row>());}catch(error){return log&&source?log.note(source,error,[] as Row[]):[] as Row[];}}
export async function buildCompanyAnalytics(db:D1Database,input:{from?:string;to?:string;serviceCode?:string;zoneId?:string}={}){const from=input.from||"1970-01-01",to=input.to||"2999-12-31",filters:string[]=["scheduled_start>=?","scheduled_start<?"],binds:unknown[]=[from,to];if(input.serviceCode){filters.push("service_code=?");binds.push(input.serviceCode);}if(input.zoneId){filters.push("zone_id=?");binds.push(input.zoneId);}const where=filters.join(" AND ");const degradation=createDegradationLog();const bookings=await safeAll(db,`SELECT id,customer_id,service_code,package_code,zone_id,provider_id,status,total_amount,currency,scheduled_start,scheduled_end FROM canonical_bookings WHERE ${where}`,binds,degradation,"bookings");const ids=bookings.map(item=>String(item.id));let payments:Row[]=[],tickets:Row[]=[];if(ids.length){payments=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,`SELECT booking_id,amount,status,gateway FROM booking_payments WHERE booking_id IN (${placeholders})`,chunk,degradation,"payments"));tickets=await chunkedIn(ids,(chunk,placeholders)=>safeAll(db,`SELECT booking_id,category,priority,status,created_at,resolved_at,reopened_count FROM customer_experience_tickets WHERE booking_id IN (${placeholders})`,chunk,degradation,"customer experience tickets"));}const providers=await safeAll(db,"SELECT id,provider_model,status,live,quality_score,rating FROM provider_capacity_profiles",[],degradation,"providers");const paymentByBooking=new Map(payments.map(p=>[String(p.booking_id),p]));const completed=bookings.filter(b=>String(b.status)==="completed"),cancelled=bookings.filter(b=>String(b.status)==="cancelled"),collected=bookings.reduce((s,b)=>{const p=paymentByBooking.get(String(b.id));return s+(p&&["captured","paid"].includes(String(p.status))?Number(p.amount||0):0)},0);
  // GMV recognizes the same bookings as the P&L (lib/pnl-reporting.ts): cancelled and draft
  // bookings carry a total_amount but no recognizable revenue, so counting them silently
  // inflated GMV above the P&L turnover for the identical period.
  const revenueRecognized=(b:Row)=>!["cancelled","draft"].includes(String(b.status));
  const gmv=bookings.reduce((s,b)=>s+(revenueRecognized(b)?Number(b.total_amount||0):0),0);
  // Real per-vertical direct cost, from the actual provider settlement ledgers that exist today.
  // Boarding and Pet Sitting have real, booking-level payout data; Training's payout data exists
  // only at provider/period level (not attributable to a specific booking) and Grooming is
  // incentive-based at groomer-month level - neither has a clean per-booking cost figure, so both
  // stay honestly "not tracked" rather than forcing a false consistency across verticals.
  const boardingIds=bookings.filter(b=>String(b.service_code)==="boarding").map(b=>String(b.id));
  const sittingIds=bookings.filter(b=>String(b.service_code)==="pet_sitting").map(b=>String(b.id));
  const trainingIds=bookings.filter(b=>String(b.service_code)==="dog_training").map(b=>String(b.id));
  const groomingIds=bookings.filter(b=>String(b.service_code)==="grooming").map(b=>String(b.id));
  // Chunked for the same reason the payments read above is (#158): an IN list built straight from a
  // result set breaks past D1's 100-bound-parameter cap, and safeAll swallows the failure - so above
  // 100 bookings in a vertical/period the cost simply vanished and the margin with it, while GMV and
  // collected stayed correct and the screen looked healthy. Worse than absent: costCoverage then
  // reported 0% for a period in which every single booking had a real payout row.
  const [boardingPayouts,sittingPayouts,trainingEarnings,groomingCosts]=await Promise.all([
    chunkedIn(boardingIds,(chunk,placeholders)=>safeAll(db,`SELECT booking_id,payout_amount FROM boarding_host_settlement_ledger WHERE booking_id IN (${placeholders})`,chunk)),
    chunkedIn(sittingIds,(chunk,placeholders)=>safeAll(db,`SELECT booking_id,payout_amount FROM sitting_sitter_settlement_ledger WHERE booking_id IN (${placeholders})`,chunk)),
    chunkedIn(trainingIds,(chunk,placeholders)=>safeAll(db,`SELECT booking_id,gross_earning,status FROM training_session_earnings WHERE booking_id IN (${placeholders})`,chunk)),
    attributeGroomingBookingCosts(db,groomingIds),
  ]);
  const costByBooking=new Map<string,number|null>();
  for(const row of boardingPayouts)costByBooking.set(String(row.booking_id),row.payout_amount==null?null:Number(row.payout_amount));
  for(const row of sittingPayouts)costByBooking.set(String(row.booking_id),row.payout_amount==null?null:Number(row.payout_amount));
  // Training bookings have multiple sessions, each its own earnings row - a booking's real cost is
  // only knowable once every one of its completed sessions has a resolved gross_earning (status
  // 'earned' or 'held_payment' both have a real, calculated figure - only 'pending_rate_configuration'
  // means no compensation rule was found and gross_earning is null). A single unresolved session
  // marks the whole booking's cost unknown, the same safety property as Boarding and Sitting.
  const trainingBookingEarnings=new Map<string,{sum:number;hasUnresolved:boolean}>();
  for(const row of trainingEarnings){
    const id=String(row.booking_id),entry=trainingBookingEarnings.get(id)||{sum:0,hasUnresolved:false};
    if(row.gross_earning==null)entry.hasUnresolved=true;else entry.sum+=Number(row.gross_earning);
    trainingBookingEarnings.set(id,entry);
  }
  for(const[id,entry] of trainingBookingEarnings)costByBooking.set(id,entry.hasUnresolved?null:entry.sum);
  for(const[id,cost] of groomingCosts)costByBooking.set(id,cost);
  const costTrackedServices=new Set(["boarding","pet_sitting","dog_training","grooming"]);
  const serviceMap=new Map<string,{bookings:number;completed:number;cancelled:number;gmv:number;collected:number;customerCounts:Map<string,number>;costSum:number;costKnownBookings:number;costEligibleBookings:number}>();for(const b of bookings){const code=String(b.service_code),m=serviceMap.get(code)||{bookings:0,completed:0,cancelled:0,gmv:0,collected:0,customerCounts:new Map<string,number>(),costSum:0,costKnownBookings:0,costEligibleBookings:0};m.bookings++;if(String(b.status)==="completed")m.completed++;if(String(b.status)==="cancelled")m.cancelled++;if(revenueRecognized(b))m.gmv+=Number(b.total_amount||0);const p=paymentByBooking.get(String(b.id));if(p&&["captured","paid"].includes(String(p.status)))m.collected+=Number(p.amount||0);const cust=String(b.customer_id);m.customerCounts.set(cust,(m.customerCounts.get(cust)||0)+1);if(costTrackedServices.has(code)){m.costEligibleBookings++;const knownCost=costByBooking.get(String(b.id));if(knownCost!=null){m.costSum+=knownCost;m.costKnownBookings++;}}serviceMap.set(code,m);}
  const services=Object.fromEntries([...serviceMap.entries()].map(([code,m])=>{
    const uniqueForService=m.customerCounts.size,repeatForService=[...m.customerCounts.values()].filter(count=>count>1).length;
    const costTracked=costTrackedServices.has(code),costCoverageComplete=costTracked&&m.costEligibleBookings>0&&m.costKnownBookings===m.costEligibleBookings;
    // Cost/margin are only ever shown as a real number when EVERY eligible booking in this vertical/period
    // has a known payout - partial coverage stays "not tracked" rather than silently understating cost
    // (and therefore overstating margin) for bookings whose payout simply hasn't been computed yet.
    const costAmount=costCoverageComplete?m.costSum:null,marginAmount=costAmount!=null?m.gmv-costAmount:null,marginPct=costAmount!=null&&m.gmv>0?Math.round((marginAmount!/m.gmv)*1000)/10:null;
    return[code,{bookings:m.bookings,completed:m.completed,cancelled:m.cancelled,gmv:m.gmv,collected:m.collected,repeatRate:uniqueForService?Math.round((repeatForService/uniqueForService)*1000)/1000:null,costAmount,marginAmount,marginPct,costTracked,costCoverage:costTracked?(m.costEligibleBookings?Math.round((m.costKnownBookings/m.costEligibleBookings)*1000)/1000:null):null}];
  }));
  const uniqueCustomers=new Set(bookings.map(b=>String(b.customer_id))).size,repeatCustomers=Object.values(bookings.reduce((acc:Record<string,number>,b)=>{const id=String(b.customer_id);acc[id]=(acc[id]||0)+1;return acc;},{} as Record<string,number>)).filter(count=>count>1).length;const openTickets=tickets.filter(t=>String(t.status)!=="resolved").length,resolvedTickets=tickets.filter(t=>String(t.status)==="resolved"),resolutionMs=resolvedTickets.map(t=>Number(t.resolved_at||0)-Number(t.created_at||0)).filter(v=>v>=0);const dataQuality={bookingsMissingProvider:bookings.filter(b=>!String(b.provider_id||"")).length,paymentsMissing:bookings.filter(b=>!paymentByBooking.has(String(b.id))).length,ticketsMissingBooking:tickets.filter(t=>!String(t.booking_id||"")).length};return{degraded:degradationNotice(degradation.entries()),period:{from,to},filters:{serviceCode:input.serviceCode||null,zoneId:input.zoneId||null},bookings:{total:bookings.length,completed:completed.length,cancelled:cancelled.length,completionRate:bookings.length?completed.length/bookings.length:null,cancellationRate:bookings.length?cancelled.length/bookings.length:null},money:{gmv,collected,currency:"INR",refundsStatus:"service_finance_sources_required",contributionMarginStatus:"configuration_required"},customers:{unique:uniqueCustomers,repeat:repeatCustomers,repeatRate:uniqueCustomers?repeatCustomers/uniqueCustomers:null},cx:{tickets:tickets.length,open:openTickets,reopened:tickets.reduce((s,t)=>s+Number(t.reopened_count||0),0),averageResolutionMs:resolutionMs.length?resolutionMs.reduce((a,b)=>a+b,0)/resolutionMs.length:null},providers:{profiles:providers.length,active:providers.filter(p=>String(p.status)==="active"&&Number(p.live)===1).length,qualityConfigured:providers.filter(p=>Number(p.quality_score)>0).length},services,dataQuality,sourceStatus:{bookings:"canonical_bookings",payments:"booking_payments",cx:"customer_experience_tickets",providers:"provider_capacity_profiles",marketingSpend:"not_connected",tax:"configuration_required",payouts:"real_for_boarding_sitting_training_and_grooming"}};}
