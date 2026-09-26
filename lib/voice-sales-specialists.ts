import { assertAiMayReply } from "./ai-human-handoff";
import { quoteGroomingBookingWithLiveMultiPet } from "./live-grooming-governance";
import { createTrainingQuote } from "./training-commercial-governance";
import { executeGovernedConversationTool } from "./ai-first-control-plane";
import type { AuthenticatedActor } from "./server-auth";
import type { AiActionRequest } from "./ai-conversation-orchestrator";

type Row = Record<string, unknown>;
export type VoiceSalesService = "grooming" | "dog_training";
export const VOICE_SALES_MODELS = { "pawspace-grooming-sales": "grooming", "pawspace-training-sales": "dog_training" } as const;
export function voiceSalesService(model: unknown): VoiceSalesService | undefined {
 return Object.prototype.hasOwnProperty.call(VOICE_SALES_MODELS, String(model)) ? VOICE_SALES_MODELS[String(model) as keyof typeof VOICE_SALES_MODELS] : undefined;
}
export function specialistSalesPrompt(service: VoiceSalesService, options: { coupons?: boolean } = {}) {
 const shared = "You are a needs-led PawSpace sales specialist, not a generic FAQ bot. Ask one question at a time, listen to the customer's answer and use the supplied canonical conversation history. Never ask again for facts already supplied. Recommend a suitable option, not automatically the most expensive. Do not invent offers, results, urgency, discounts, availability, or payment success. Handle price objections honestly. Use only server-owned catalogue/quote data. Collect the saved pet IDs, service address and PIN, package and requested appointment time before proposing checkout. When ready, propose the three registered actions schedule.reserve, booking.create, checkout.payment_order.create. The runtime will quote and preview the schedule, read the exact terms back, and require a separate explicit customer confirmation. Never tell the customer it is booked or paid yourself. A later yes confirms the stored offer, never a new model-generated plan. Do not read URLs or internal identifiers aloud. Never claim a payment link was delivered without delivery evidence. Payment and subscription activation require verified provider events. Stop selling when asked, and respect requests for a human.";
 return shared + (service === "grooming"
  ? "\nSpecialty: Grooming only. Understand pet species, age, coat/breed, pet count, grooming goal, temperament and relevant safety concerns; collect needs without veterinary diagnosis. Explain the most relevant one-time package and, when suitable, the actual prepaid subscription alternative. Before subscription purchase explain total price, included sessions/credits, per-pet consumption, validity, eligibility, pause/expiry terms from the supplied plan. A prepaid bundle is not an auto-renewing mandate. Do not invent recurring debits. Offer only saved, owned pets; a missing customer/pet/address record needs the verified profile flow. Set schedule.serviceCode to grooming and booking.paymentMode to prepaid. No unsupported add-ons or discounts." + (options.coupons ? " A coupon is applied only when the customer accepts an offer listed in approvedOffers for the chosen package: put its exact code in booking.couponCode. The runtime validates it and reads the discounted total back; never state the discounted total yourself before that." : "")
  : "\nSpecialty: Dog Training only. Ask about dog's age and breed, goals (toilet training, walking, basic cues, puppy habits), prior training, behavior/safety concerns, household participation, preferred cadence and dates. Escalate aggression/bite risk or complex safety needs for a trainer assessment rather than promising a cure. Explain the live Meet & Greet/assessment and programme options, session count, duration, validity and approved full/split payment terms. Never guarantee behavior outcomes or invent trainer availability. Set schedule.serviceCode to dog_training. Include the selected packageCode and paymentMode prepaid or split in booking.create, and requirements as short customer-stated strings. The runtime derives session duration/count and creates a server quote. No grooming package sales through this agent.");
}
const text = (v: unknown) => String(v ?? "").trim();
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const parse = <T>(v: unknown, fallback: T): T => { try { return JSON.parse(String(v)) as T; } catch { return fallback; } };
const refusal = (message: string, status = 409) => new Response(message, { status });
const id = () => `VSO-${crypto.randomUUID()}`;
const money = (v: unknown) => `INR ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function isVoiceSalesConfirmation(message: string) {
 return /^(?:yes(?:,? please|,? go ahead|,? proceed|,? book it|,? confirm)?|confirm(?: the booking)?|go ahead|proceed|book it|book this)[.! ]*$/i.test(message.trim());
}
export async function ensureVoiceSalesOffers(db: D1Database) {
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS voice_sales_offers (id TEXT PRIMARY KEY,turn_key TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL,quote_json TEXT NOT NULL,actions_json TEXT NOT NULL,summary TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,result_json TEXT,completed_at INTEGER)"),
  db.prepare("CREATE INDEX IF NOT EXISTS voice_sales_offers_thread ON voice_sales_offers(thread_id,customer_id,status,created_at)"),
 ]);
}
async function assertOwner(db: D1Database, threadId: string, customerId: string, actor: AuthenticatedActor) {
 if (!actor.email.endsWith("@system.pawspace") || !actor.permissions.includes("communications.manage")) throw refusal("Voice sales service actor required", 403);
 const thread = await db.prepare("SELECT customer_id,status,assigned_to FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
 if (!thread || text(thread.customer_id) !== customerId) throw refusal("Voice sales conversation ownership mismatch", 403);
 if (text(thread.status) !== "open" || (text(thread.assigned_to) && text(thread.assigned_to) !== "ai-orchestrator")) throw refusal("Human-owned or closed conversation cannot perform AI sales");
 await assertAiMayReply(db,threadId);
}
function onlyKeys(value: Row, allowed: string[]) {
 for (const key of Object.keys(value)) if (!allowed.includes(key)) throw refusal("Sales proposal contains unsupported or server-authoritative fields", 400);
}
function petIds(value: unknown) {
 if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some(v => typeof v !== "string" || !v.trim())) throw refusal("Select one to four saved pets before checkout", 400);
 const ids = value.map(text); if (new Set(ids).size !== ids.length) throw refusal("Duplicate pets are not allowed", 400); return ids;
}
/**
 * A coupon in a chat offer is one of the approved sales offers this customer can redeem (GROOM200's
 * closing discount or GROOM400's cross-sell), quoted by the governed coupon engine against the server's
 * own package price. The model names a code; the discount, total and eligibility are the server's.
 */
async function quoteSalesCoupon(db: D1Database, input: { code: string; customerId: string; cityId: string; quote: Row }) {
 const { approvedSalesOffers, couponsLiveApproved } = await import("./ai-sales-offers");
 const { quoteCoupon } = await import("./coupon-governance");
 const approved = await approvedSalesOffers(db, { customerId: input.customerId, channel: "website" });
 if (!approved.some(offer => offer.code === input.code)) throw refusal("That coupon is not an offer PawSpace AI can apply for this customer", 400);
 const result = await quoteCoupon(db, { code: input.code, customerId: input.customerId, serviceCode: "grooming", cityId: input.cityId, channel: "website", packageCode: text(input.quote.packageCode), orderValue: Number(input.quote.totalAmount), paymentMode: "full", isSubscription: input.quote.offerType === "subscription" }, { liveApproved: await couponsLiveApproved() });
 if (!result.valid || !("quoteId" in result) || !result.quoteId) throw refusal(`The coupon could not be applied: ${result.error || "not eligible for this booking"}`);
 return { quoteId: result.quoteId, code: result.code, discount: Number(result.discount), finalAmount: Number(result.finalAmount) };
}
function summaryFor(service: VoiceSalesService, quote: Row, schedule: Row) {
 const at = new Date(text(schedule.scheduledStart)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
 const plan = object(quote.subscriptionPlan), recommended = object(quote.recommendedProvider);
 const occurrences=Array.isArray(quote.occurrences)?quote.occurrences.map(object):[];
 const last=occurrences.length?new Date(text(occurrences[occurrences.length-1].start)).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"long"}):"";
 const cadence=Array.isArray(schedule.weekdays)&&schedule.weekdays.length?` on ${schedule.weekdays.map(day=>["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][Number(day)]).join(", ")}`:Number(schedule.cadenceDays)>0?` every ${schedule.cadenceDays} day(s)`:"";
 const terms = service === "dog_training" ? `${quote.sessions} session(s), ${quote.minutesPerSession} minutes per session${cadence}, valid for ${quote.validityDays} days.${occurrences.length>1?` Last planned session ${last}.`:""}`
  : quote.offerType === "subscription" ? `Prepaid bundle: ${plan.sessions} credits, ${plan.reserveSessions} credit(s) for this appointment, valid for ${plan.validityValue} ${plan.validityUnit}. This does not enable automatic renewal.` : "One-time grooming appointment.";
 const coupon = object(quote.coupon), discounted = text(coupon.quoteId) !== "";
 const total = discounted ? Number(coupon.finalAmount) : Number(quote.totalAmount), dueNow = discounted ? total : Number(quote.amountDueNow);
 const remaining = total - dueNow;
 return `${text(quote.packageName)} for ${quote.petCount} pet(s). ${terms}${discounted ? ` Coupon ${text(coupon.code)}: ${money(coupon.discount)} off ${money(quote.totalAmount)}.` : ""} Total ${money(total)}; ${money(dueNow)} due now${remaining > 0 ? ` and ${money(remaining)} remaining under the quoted payment terms` : ""}. Requested start ${at} India time.${service === "dog_training" ? ` Recommended available trainer: ${text(recommended.name)}. Confirming also selects this trainer; you can ask for another option.` : ""} Availability was checked, not reserved. Shall I reserve this and create the booking with payment still pending?`;
}
export type SalesOfferChannel = "voice" | "chat";
export async function prepareVoiceSalesOffer(db: D1Database, input: { actor: AuthenticatedActor; threadId: string; customerId: string; service: VoiceSalesService; turnKey: string; actions: AiActionRequest[]; channel?: SalesOfferChannel }) {
 await ensureVoiceSalesOffers(db); await assertOwner(db, input.threadId, input.customerId, input.actor);
 const prior = await db.prepare("SELECT * FROM voice_sales_offers WHERE turn_key=?").bind(input.turnKey).first<Row>();
 if (prior) { if (prior.thread_id !== input.threadId || prior.customer_id !== input.customerId || prior.service_code !== input.service) throw refusal("Sales offer idempotency ownership mismatch", 403); return { id: text(prior.id), summary: text(prior.summary), expiresAt: Number(prior.expires_at) }; }
 if (input.actions.length !== 3 || input.actions.map(a => a.toolCode).join(",") !== "schedule.reserve,booking.create,checkout.payment_order.create") throw refusal("Sales checkout must propose reservation, booking and payment order in that order", 400);
 const schedule = { ...object(input.actions[0].arguments) }, booking = { ...object(input.actions[1].arguments) };
 onlyKeys(schedule, ["serviceCode", "petIds", "serviceAddress", "servicePincode", "scheduledStart", "scheduledEnd", "cadenceDays", "weekdays", "occurrences"]);
 onlyKeys(booking, ["petIds", "packageCode", "paymentMode", "requirements", "couponCode"]);
 const couponCode = text(booking.couponCode).toUpperCase(); delete booking.couponCode;
 if (couponCode && (input.service !== "grooming" || (input.channel ?? "voice") === "voice")) throw refusal("Coupons are applied only to Grooming offers in web chat", 400); onlyKeys(object(input.actions[2].arguments), []);
 if (text(schedule.serviceCode) !== input.service) throw refusal("The proposal does not belong to this sales specialist", 403);
 const ids = petIds(schedule.petIds), bookingPets = petIds(booking.petIds);
 if (JSON.stringify([...ids].sort()) !== JSON.stringify([...bookingPets].sort())) throw refusal("Booking pets differ from the proposed appointment", 400);
 const pets: Row[] = []; for (const petId of ids) { const pet = await db.prepare("SELECT id,species FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId, input.customerId).first<Row>(); if (!pet) throw refusal("Saved pet ownership could not be verified", 403); pets.push(pet); }
 if (!text(schedule.serviceAddress) || !/^\d{6}$/.test(text(schedule.servicePincode))) throw refusal("A complete service address and six-digit PIN are required", 400);
 const start = new Date(text(schedule.scheduledStart)); if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now()) throw refusal("A future appointment is required", 400);
 const mode = text(booking.paymentMode) || "prepaid"; booking.paymentMode = mode;
 let quote: Row;
 if (input.service === "dog_training") {
  if (pets.some(p => p.species !== "dog") || !["prepaid", "split"].includes(mode)) throw refusal("Training requires saved dogs and an approved payment option", 400);
  quote = await createTrainingQuote(db, { packageCode: text(booking.packageCode), petCount: pets.length, scheduledStart: start.toISOString(), paymentMode: mode as "prepaid" | "split" });
  if(Number(quote.sessions)>1){
   const days=Number(schedule.cadenceDays),weekdays=schedule.weekdays;
   if(!Number.isInteger(days)||days<1||days>31){if(!Array.isArray(weekdays)||!weekdays.length)throw refusal("Ask the customer for their preferred Training cadence before quoting",400);}
   if(weekdays!==undefined&&(!Array.isArray(weekdays)||weekdays.length>7||weekdays.some(day=>!Number.isInteger(day)||Number(day)<0||Number(day)>6)))throw refusal("Training weekdays must be valid customer-selected days",400);
  }
  schedule.occurrences = Number(quote.sessions); schedule.scheduledEnd = new Date(start.getTime() + Number(quote.minutesPerSession) * 60000).toISOString(); booking.trainingQuoteId = quote.quoteId;
  if (booking.requirements !== undefined && (!Array.isArray(booking.requirements) || booking.requirements.length > 20 || booking.requirements.some(v => typeof v !== "string" || v.length > 250))) throw refusal("Training requirements must be short customer-stated notes", 400);
 } else {
  if (mode !== "prepaid") throw refusal("This sales flow supports prepaid Grooming purchases only", 400);
  if (schedule.occurrences !== undefined && Number(schedule.occurrences) !== 1) throw refusal("Only the first Grooming appointment is reserved with a purchase", 400);
  schedule.occurrences = 1;
  const { resolveGovernedServiceAddress } = await import("./service-discovery-address");
  const address = await resolveGovernedServiceAddress(db, { customerId: input.customerId, serviceCode: input.service, serviceAddress: text(schedule.serviceAddress), servicePincode: text(schedule.servicePincode) });
  quote = await quoteGroomingBookingWithLiveMultiPet(db, { packageCode: text(booking.packageCode), packageName: "", pets: pets.map(p => ({ species: text(p.species) as "dog" | "cat" | "other" })), paymentMode: mode, cityId: address.cityId, zoneId: address.zoneId, scheduledStart: start.toISOString() });
  if (couponCode) { const coupon = await quoteSalesCoupon(db, { code: couponCode, customerId: input.customerId, cityId: address.cityId, quote }); quote = { ...quote, coupon }; booking.couponQuoteId = coupon.quoteId; }
 }
 const { executeGovernedSchedulingRequest } = await import("../app/api/uat-scheduling/route");
 const response = await executeGovernedSchedulingRequest(new Request("https://internal.pawspace/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...schedule, action: "preview", customerId: input.customerId, clientRequestId: `preview:${input.turnKey}` }) }), input.actor);
 const preview = object(await response.json()); if (!response.ok) throw refusal("Current availability could not be verified; review the requested address and time");
 const available = object(preview.data); if (!Array.isArray(available.providers) || !available.providers.length) throw refusal("No eligible provider is available for this proposed schedule");
 quote = { ...quote, cityId: available.cityId, zoneId: available.zoneId };
 if(input.service === "dog_training"){
  // The scheduler's ranked eligible candidate is read back for the customer's choice.
  // This is not an LLM-supplied provider ID and does not bypass customer-select policy.
  const recommended=object(available.providers[0]);if(!text(recommended.id)||!text(recommended.name))throw refusal("An eligible named trainer is required");
  quote.recommendedProvider={id:recommended.id,name:recommended.name};schedule.preferredProviderId=recommended.id;
  const occurrences=Array.isArray(available.occurrences)?available.occurrences.map(object):[];
  if(occurrences.length!==Number(quote.sessions)||occurrences.some(o=>!Number.isFinite(Date.parse(text(o.start)))||!Number.isFinite(Date.parse(text(o.end)))))throw refusal("The complete Training schedule could not be verified");
  if(Date.parse(text(occurrences[occurrences.length-1].end))>start.getTime()+Number(quote.validityDays)*86400000)throw refusal("The proposed Training cadence exceeds the programme validity; choose a different cadence");
  quote.occurrences=occurrences.map(o=>({start:o.start,end:o.end,occurrenceNumber:o.occurrenceNumber}));
 }
 const actions: AiActionRequest[] = [{ toolCode: "schedule.reserve", arguments: schedule }, { toolCode: "booking.create", arguments: booking }, { toolCode: "checkout.payment_order.create", arguments: {} }];
 const offerId = id(), now = Date.now(), expiresAt = Math.min(now + 10 * 60000, Number(quote.expiresAt) || Infinity), summary = summaryFor(input.service, quote, schedule);
 await db.batch([
  db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE thread_id=? AND customer_id=? AND status='pending'").bind(input.threadId, input.customerId),
  db.prepare("INSERT INTO voice_sales_offers (id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?,?,?,?)").bind(offerId, input.turnKey, input.threadId, input.customerId, input.service, JSON.stringify(quote), JSON.stringify(actions), summary, expiresAt, now),
 ]);
 return { id: offerId, summary, expiresAt };
}
export async function pendingVoiceSalesOffer(db: D1Database, threadId: string, customerId: string, service: VoiceSalesService) {
 await ensureVoiceSalesOffers(db);
 return db.prepare("SELECT * FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code=? AND status='pending' ORDER BY created_at DESC LIMIT 1").bind(threadId, customerId, service).first<Row>();
}
export async function invalidateVoiceSalesOffers(db: D1Database, threadId: string, customerId: string) {
 await ensureVoiceSalesOffers(db);
 await db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE thread_id=? AND customer_id=? AND status='pending'").bind(threadId, customerId).run();
}
function resultValue(value: unknown, key: string): string {
 const row = object(value); if (typeof row[key] === "string") return row[key] as string;
 for (const child of Object.values(row)) if (child && typeof child === "object") { const found = resultValue(child, key); if (found) return found; } return "";
}
export async function confirmVoiceSalesOffer(db: D1Database, input: { actor: AuthenticatedActor; threadId: string; customerId: string; service: VoiceSalesService; offerId: string; confirmation: string; channel?: SalesOfferChannel }) {
 await ensureVoiceSalesOffers(db); await assertOwner(db, input.threadId, input.customerId, input.actor);
 if (!isVoiceSalesConfirmation(input.confirmation)) throw refusal("A separate unambiguous confirmation of the quoted offer is required", 400);
 const offer = await db.prepare("SELECT * FROM voice_sales_offers WHERE id=? AND thread_id=? AND customer_id=? AND service_code=?").bind(input.offerId, input.threadId, input.customerId, input.service).first<Row>();
 if (!offer) throw refusal("Sales offer ownership could not be verified", 403);
 if (offer.status === "completed") { const saved=parse<Row>(offer.result_json, {}); if(!text(saved.output))throw refusal("Stored sales result is incomplete"); return { ...saved, output:text(saved.output), duplicatePrevented: true }; }
 if (offer.status !== "pending" || Number(offer.expires_at) < Date.now()) throw refusal("This offer expired or changed; refresh price and availability before confirming");
 const quote = parse<Row>(offer.quote_json, {}), actions = parse<AiActionRequest[]>(offer.actions_json, []);
 if (actions.length !== 3) throw refusal("Stored sales offer is incomplete");
 if (input.service === "grooming") {
  const pets: Array<{species: "dog" | "cat" | "other"}> = [];
  for (const petId of petIds(actions[0].arguments.petIds)) { const pet = await db.prepare("SELECT species FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId, input.customerId).first<Row>(); if (!pet) throw refusal("Pet ownership changed", 403); pets.push({ species: text(pet.species) as "dog" | "cat" | "other" }); }
  const fresh = await quoteGroomingBookingWithLiveMultiPet(db, { packageCode: text(quote.packageCode), packageName: "", pets, paymentMode: "prepaid", cityId: text(quote.cityId), zoneId: text(quote.zoneId), scheduledStart: text(actions[0].arguments.scheduledStart) });
  if (fresh.totalAmount !== Number(quote.totalAmount) || fresh.catalogueVersion !== quote.catalogueVersion || JSON.stringify(fresh.subscriptionPlan) !== JSON.stringify(quote.subscriptionPlan)) throw refusal("The Grooming price or plan terms changed; a new customer confirmation is required");
 }
 if (input.service === "dog_training") {
  const current=await db.prepare("SELECT q.id FROM training_commercial_quotes q JOIN training_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=? AND q.status='open' AND q.expires_at>=? AND p.active=1 AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?)").bind(text(quote.quoteId),Date.now(),text(actions[0].arguments.scheduledStart).slice(0,10),text(actions[0].arguments.scheduledStart).slice(0,10)).first<Row>();
  if(!current)throw refusal("The Training quote or package changed; review a fresh quote before confirming");
 }
 const claimed = await db.prepare("UPDATE voice_sales_offers SET status='executing',confirmed_at=? WHERE id=? AND status='pending' AND expires_at>=?").bind(Date.now(), input.offerId, Date.now()).run();
 if (Number(claimed.meta?.changes) !== 1) throw refusal("This offer is already being processed");
 let groupId = "", bookingId = "", orderId = "";
 try {
  for (let index = 0; index < actions.length; index++) {
   const action = actions[index], args = { ...action.arguments };
   if (action.toolCode === "booking.create") args.scheduleGroupId = groupId;
   if (action.toolCode === "checkout.payment_order.create") args.bookingId = bookingId;
   const result = await executeGovernedConversationTool(db, { actor: input.actor, threadId: input.threadId, customerId: input.customerId, channel: input.channel ?? "voice", intent: "booking_create", toolCode: action.toolCode, arguments: args, idempotencyKey: `${input.offerId}:${index}:${action.toolCode}`, customerConfirmed: true });
   groupId = resultValue(result, "groupId") || groupId; bookingId = resultValue(result, "bookingId") || bookingId; orderId = resultValue(result, "orderId") || orderId;
  }
  if(!groupId||!bookingId||!orderId)throw refusal("Checkout is incomplete; no successful sale can be claimed",503);
  const result = { offerId: input.offerId, bookingId, orderId, paymentVerified: false, paymentLinkDelivered: false, output: "Your booking has been created and the secure Razorpay checkout is ready. Payment is still pending verification. No payment or subscription activation has been claimed." };
  await db.prepare("UPDATE voice_sales_offers SET status='completed',result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(JSON.stringify(result), Date.now(), input.offerId).run();
  return { ...result, duplicatePrevented: false };
 } catch (error) {
  await db.prepare("UPDATE voice_sales_offers SET status='failed',result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(JSON.stringify({ groupId, bookingId, orderId, paymentVerified: false, requiresReview: true }), Date.now(), input.offerId).run();
  throw error;
 }
}
