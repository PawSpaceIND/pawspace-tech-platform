import { createWalkingQuote } from "./walking-governance";
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const refuse = (message: string, status = 409) => new Response(message, { status });

export async function prepareWalkingSalesQuote(db: D1Database, input: { schedule: Row; booking: Row }): Promise<Row> {
 const { schedule, booking } = input;
 if (booking.paymentMode !== "pay_after_service") throw refuse("Walking requires the approved pay-after-service terms", 400);
 if (booking.boardingRequirements !== undefined || booking.requirements !== undefined) throw refuse("Use the Walking care workflow for special handling needs", 400);
 const count = schedule.occurrences === undefined ? 1 : Number(schedule.occurrences);
 const quote = await createWalkingQuote(db, {
  packageCode: text(booking.packageCode), mode: count === 1 ? "once" : "recurring", petCount: 1,
  walkCount: count, weekdays: schedule.weekdays as number[] | undefined,
  scheduledStart: text(schedule.scheduledStart), scheduledEnd: text(schedule.scheduledEnd), paymentMode: "pay_after_service",
 });
 schedule.occurrences = quote.walkCount;
 if (quote.walkCount > 1) schedule.weekdays = quote.weekdays;
 booking.walkingQuoteId = quote.quoteId;
 return { ...quote };
}

export async function confirmedWalkingSalesPayload(db: D1Database, input: { threadId: string; customerId: string; args: Row; petCount: number }) {
 const quoteId = text(input.args.walkingQuoteId);
 if (!quoteId || input.petCount !== 1) throw refuse("A confirmed one-dog Walking quote is required", 400);
 const owner = await db.prepare("SELECT quote_json FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code='dog_walking' AND status='executing' AND json_extract(quote_json,'$.quoteId')=? LIMIT 1")
  .bind(input.threadId,input.customerId,quoteId).first<Row>();
 if (!owner) throw refuse("Walking quote does not belong to this confirmed conversation",403);
 const saved = JSON.parse(text(owner.quote_json)) as Row;
 const quote = await db.prepare("SELECT q.*,p.name FROM walking_commercial_quotes q JOIN walking_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=? AND q.status='open' AND q.expires_at>=? AND p.active=1 AND p.effective_from<=substr(q.scheduled_start,1,10) AND (p.effective_to IS NULL OR p.effective_to>=substr(q.scheduled_start,1,10))")
  .bind(quoteId,Date.now()).first<Row>();
 if (!quote || text(quote.package_code)!==text(input.args.packageCode) || quote.payment_mode!=="pay_after_service"
  || input.args.paymentMode!=="pay_after_service" || Number(quote.amount_due_now)!==0
  || Number(quote.total_amount)!==Number(saved.totalAmount) || Number(quote.walk_count)!==Number(saved.walkCount)) throw refuse("Walking quote expired or its confirmed terms changed");
 return { walkingQuoteId:quoteId,packageCode:text(quote.package_code),packageName:text(quote.name),walkCount:Number(quote.walk_count),
  weekdays:JSON.parse(text(quote.weekdays_json)),totalAmount:Number(quote.total_amount),amountDueNow:0 };
}
