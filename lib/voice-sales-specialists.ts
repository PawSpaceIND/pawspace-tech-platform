import { assertNativeDemoBusinessAllowed } from "./native-attended-demo";
import { ensureD1Once } from "./d1-ensure-once.js";
import { assertAiMayReply } from "./ai-human-handoff";
import { quoteGroomingBookingWithLiveMultiPet } from "./live-grooming-governance";
import { createTrainingQuote } from "./training-commercial-governance";
import { executeGovernedConversationTool } from "./ai-first-control-plane";
import { enqueueCommunication } from "./communication-engine";
import type { AuthenticatedActor } from "./server-auth";
import type { AiActionRequest } from "./ai-conversation-orchestrator";

type Row = Record<string, unknown>;
export type VoiceSalesService = "grooming" | "dog_training" | "boarding" | "pet_sitting" | "all_services" | "pet_taxi";
export const VOICE_SALES_MODELS = { "pawspace-grooming-sales": "grooming", "pawspace-training-sales": "dog_training", "pawspace-boarding-sales": "boarding", "pawspace-sitting-sales": "pet_sitting", "pawspace-service-sales": "all_services", "pawspace-taxi-sales": "pet_taxi" } as const;
export function voiceSalesService(model: unknown): VoiceSalesService | undefined {
 return Object.prototype.hasOwnProperty.call(VOICE_SALES_MODELS, String(model)) ? VOICE_SALES_MODELS[String(model) as keyof typeof VOICE_SALES_MODELS] : undefined;
}
export function specialistSalesPrompt(service: VoiceSalesService, options: { coupons?: boolean } = {}) {
 const shared = "You are a needs-led PawSpace sales specialist and concierge, not a generic FAQ bot. Speak naturally for a phone call: greet once, acknowledge briefly when useful, ask at most two or three closely related missing discovery questions in one short turn, then let the caller answer. For complex care needs, uncertainty, confusion or distress, ask only one question at a time. Never repeat the same filler sentence on every turn. Do not say 'one moment', 'give me a second', or equivalent on routine turns. Never use filler as a complete answer. Treat supplied canonical context and conversationHistory as durable call memory. Use the customer's saved name and the selected pet's saved name naturally when known, but do not overuse either. Never assume a dog: say pet until species is known, and handle cats correctly. PawSpace fulfillment is for dogs and cats only: for another species, provide only supported general-care information and a veterinarian referral, never a PawSpace booking proposal. A rash or skin problem is a medical concern, not a reason to sell Grooming as treatment. Give the appropriate veterinarian referral and prioritize urgent signs or a human request over selling. Mention a tick bath only when current approved catalogue, species-specific suitability and safety guidance support it; never assume a dog product is safe for a cat. Do not diagnose, prescribe medication or give a dose. Do not dump the complete package list. First learn the customer's goal and relevant pet needs, then recommend the most suitable approved option and connect its benefits to the customer's stated need. Explain its approved price and inclusions in plain words, and answer the customer's question or price objection honestly before asking for booking consent. If a required fact is unknown or unclear, ask a focused clarification instead of guessing. Use facts the caller already supplied; do not restart discovery after an answer or interruption. Reply in the caller's active language across English, Hindi, Tamil, Malayalam, Telugu, Punjabi, Marathi, Bengali and Kannada; in Indian code-mixed speech follow the dominant language naturally. A language switch changes only presentation and must never reset or reinterpret a confirmed pet, date, time, address, PIN, package, payment choice or booking state. Once the caller has supplied or confirmed a pet, date, time, address, PIN, package preference, or other booking field, do not ask for that same field again unless the caller changes it or the canonical record conflicts. Summarize already-known facts only when needed to resolve ambiguity. When a caller gives a breed or species instead of a pet name, inspect the saved owned pets in canonical context: if exactly one saved pet matches, confirm that pet by name once; if more than one could match, offer the saved pet names instead of asking a vague which-pet question. Your own assistant name is Maya; if a saved pet is also named Maya, always disambiguate with 'your pet Maya' or the breed and never say a confusing phrase like 'Which Maya?'. Preserve the caller's already-stated requested time and address while asking for the next small group of missing details. Recommend a suitable option, not automatically the most expensive. Suggest a higher package only when its approved additional inclusions provide clear value for this customer’s stated needs; explain that incremental value and respect their budget or refusal. Do not invent offers, results, urgency, discounts, availability, or payment success. Handle price objections honestly. Use only server-owned catalogue or quote data. Use the server-supplied todayDate, tomorrowDate, asOfIso and timezone to resolve relative dates. A requested time is not proof of availability; propose the governed scheduling preview to check availability. Never ask the caller for a timestamp when these calendar fields resolve the date. Collect the saved pet IDs, service address and PIN, package and requested appointment time before proposing checkout. As soon as every required field is present, stop interviewing the caller and propose exactly three registered actions in this order: schedule.reserve, booking.create, checkout.payment_order.create. This is an unconfirmed proposal, not permission to execute a booking or payment. The runtime will quote and preview the schedule, read the exact terms back, and require a separate explicit customer confirmation. Never tell the customer it is booked or paid yourself. A later yes confirms the stored offer, never a new model-generated plan. Do not read URLs or internal identifiers aloud. Never claim a payment link was delivered without delivery evidence. Payment and subscription activation require verified provider events. After answering the main need, offer at most one other enabled PawSpace service only when it fits a stated customer need, and briefly explain the fit. Ask whether the caller wants details; do not create another booking without its own governed quote and explicit confirmation. Do not introduce cross-selling during quote confirmation, medical or safety concerns, Funeral and Memorial, payment disputes or serious complaints. Stop selling when asked, and respect requests for a human.";
 if (service === "all_services") return shared + "\nHandle every enabled PawSpace service in one conversation using serviceDirectory and approvedKnowledge. Executable voice booking services are grooming, dog_training and pet_taxi. Boarding (including Daycare) and pet_sitting are provider-priced information with final booking in the PawSpace app. Never quote their catalogue defaults as a host or sitter rate. When the caller requests a Boarding, Daycare or Sitting quote and supplies all required facts, you MUST return the same three-action JSON envelope to PREPARE verified caregiver information. Do not simply redirect to the app without checking the available caregiver rate. These are unexecuted proposal descriptors: the server recognizes the stay service and stores app-only information with no executable actions. Its stored information cannot execute a stay reservation, booking or payment, even after yes. For Taxi, booking.create arguments MUST contain this nested taxi object: {petIds:[ownedPetId],paymentMode:split_50_50,taxi:{originLabel:fullPickupAddress,destinationLabel:fullDropAddress,passengerCount:integer,luggageCount:integer,tripType:one_way_or_round_trip,ridePurpose:regular_or_airport,waitingMinutes:integer,hyperactivePet:boolean}}. Include taxi.returnDropLabel for round trips and taxi.vehicleClass only if the caller selected citroen_ec3 or xuv. Set schedule.serviceAddress to the full PICKUP address only, copied exactly into taxi.originLabel; never concatenate pickup and drop into serviceAddress. Do not use a legacy taxi route/package code. The server derives packageCode, vehicle, travel duration and quoted fare from address-based routing. The empty petTaxi catalogue is intentional: it is NOT an unavailable-service signal. No pre-existing Taxi package or quoted fare is required to PREPARE the proposal. Omit packageCode for Taxi. Return the three proposal actions with the supplied trip facts; their server-side preview invokes the live route quote and selects the vehicle. Do not send the customer to the Mobility team merely because you cannot see a fare before requesting that quote. All Taxi intake fields belong inside booking.create.arguments.taxi, not schedule.reserve. Ask for only the next group of at most two or three related missing ride facts: first pickup, drop and date/time; then one-way or return, passengers and luggage; then waiting or special handling only if still needed. Never list the entire Taxi checklist in one reply. Use paymentMode split_50_50, with no invented distance, fare or coordinates. The server recommends an eligible car and quotes its route and booking fee; the customer confirms those exact terms. Walking is upfront-only under approved policy; its legacy pay-after-service UAT API is not an approved customer checkout. Preserve the request for the team rather than offering deferred payment. Set schedule.serviceCode to the CURRENT requested service, even after another service was booked: Grooming=grooming, Training=dog_training, Boarding/Daycare=boarding, Sitting=pet_sitting, Taxi=pet_taxi. Pair packageCode with that same catalogue group; never carry grooming over from a previous booking. Use each service own package and payment rules. For stay information collect exact start and end times, one occurrence and the chosen app payment preference. Defer the detailed care checklist until the missing dates and location are clear; ask only one question at a time about complex care needs, and do not repeat a duration or care need the caller already supplied. Explain that final caregiver selection, current provider price and payment terms are confirmed in the app. Training requires cadence and prepaid or split. Grooming checkout is prepaid. For other services explain the specialist booking path honestly; do not issue unsupported booking actions or claim a collected enquiry is a confirmed booking. Preserve pet and customer details across service switches. A yes confirms only the latest stored quote, never an optional cross-sell.";
 if (service === "pet_taxi") return specialistSalesPrompt("all_services",options);
 if (service === "boarding" || service === "pet_sitting") return shared + `
Provider-priced information specialty: ${service === "boarding" ? "Boarding and Daycare at a host's home" : "Pet Sitting in the customer's home"}. Final booking is completed by the customer in the PawSpace app. Do not quote a fixed catalogue price or execute a voice stay booking. Collect exact start and end dates and times, saved pets, address and PIN, and the chosen active package. Ask about care needs without diagnosing. Defer the detailed care checklist until the missing dates and location are clear; ask only one question at a time about complex care needs, and do not repeat a duration or care need the caller already supplied. Use schedule.serviceCode ${service}. The server checks the continuous care window and the available caregiver's published provider price. A missing provider rate needs app/team review, never a catalogue fallback. Payment modes are prepaid or split_50_50 only when the canonical quote approves the stay for split payment. Never infer split eligibility or promise host acceptance. Include only customer-stated boardingRequirements (medicationRequired, noResidentPets, oneFamilyOnly) for boarding. Do not substitute a Grooming package. For other services answer the actual question from approved knowledge and explain the available booking path honestly.`;
 return shared + (service === "grooming"
  ? "\nExecutable booking specialty: Grooming only. For questions about another PawSpace service, answer that actual service using the supplied enabled serviceDirectory and approvedKnowledge; never steer a boarding or walking enquiry back to grooming. You are allowed to explain and recommend other enabled services, but this specialist cannot execute their bookings. Preserve the requested service and customer preferences, then offer its existing booking flow or a human teammate when another service needs booking. Understand pet species, age, coat or breed, pet count, grooming goal, temperament and relevant safety concerns; collect needs without veterinary diagnosis. Explain the most relevant one-time package and, when suitable, the actual subscription alternative using approved knowledge. Do not describe all subscriptions as prepaid-only or infer post-service credit activation or collection milestones. Before subscription purchase explain total price, included sessions or credits, per-pet consumption, validity, eligibility, pause or expiry terms from the supplied plan. A subscription pack is not an auto-renewing mandate. Founder-confirmed Grooming policy allows prepaid or pay-after-service, with cash and UPI accepted as payment methods. Payment timing and payment method are separate facts. This revision does not grant new action permissions: the automated voice checkout remains prepaid-only. Set schedule.serviceCode to grooming and booking.paymentMode to prepaid only after the caller chooses prepaid. If the caller chooses pay-after-service or cash, explain the option and offer a human teammate rather than silently switching them to prepaid. Do not invent recurring debits. Offer only saved, owned pets; a missing customer, pet, or address record needs the verified profile flow. No unsupported add-ons or discounts." + (options.coupons ? " A coupon is applied only when the customer accepts an offer listed in approvedOffers for the chosen package: put its exact code in booking.couponCode. The runtime validates it and reads the discounted total back; never state the discounted total yourself before that." : "")
  : "\nExecutable booking specialty: Dog Training only. Answer other service enquiries from supplied enabled serviceDirectory and approvedKnowledge without substituting Training. Explain another enabled service when relevant, but do not execute its booking through this specialist. Ask about dog's age and breed, goals (toilet training, walking, basic cues, puppy habits), prior training, behavior/safety concerns, household participation, preferred cadence and dates. Escalate aggression/bite risk or complex safety needs for a trainer assessment rather than promising a cure. Explain the live Meet & Greet/assessment and programme options, session count, duration, validity and approved full/split payment terms. Explain approved doorstep Training benefits in the pet’s home environment when relevant to the stated goal. Mention trainer experience, credentials, reviews or results only when current approved knowledge or canonical provider evidence supports the specific claim; if that evidence is missing, say you need the team to verify it. Never invent credentials, review counts, testimonials or success rates. Never guarantee behavior outcomes or invent trainer availability. Set schedule.serviceCode to dog_training. Include the selected packageCode and paymentMode prepaid or split in booking.create, and requirements as short customer-stated strings. The runtime derives session duration/count and creates a server quote. No grooming package sales through this agent.");
}
const text = (v: unknown) => String(v ?? "").trim();
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const parse = <T>(v: unknown, fallback: T): T => { try { return JSON.parse(String(v)) as T; } catch { return fallback; } };
const refusal = (message: string, status = 409) => new Response(message, { status });
const id = () => `VSO-${crypto.randomUUID()}`;
const money = (v: unknown) => `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })} rupees`;
const counted = (v: unknown, noun: string) => `${v} ${noun}${Number(v) === 1 ? "" : "s"}`;
export function isVoiceSalesConfirmation(message: string) {
 return /^(?:(?:yes|yeah|yep)(?:,? please|,? go ahead|,? proceed|,? book it|,? confirm)?|confirm(?: the booking)?|go ahead|proceed|book it|book this)[.! ]*$/i.test(message.trim());
}
/** An explicit request to prepare an offer is not permission to execute it. */
export function isVoiceSalesQuoteRequest(message: string) {
 return /^(?:(?:please|can you|could you)\s+)?(?:prepare|create)\s+(?:a|an|the)\s+(?:(?:unconfirmed|draft)\s+)?quote\s+for\b/i.test(message.trim());
}
/** Only quote preparation can explicitly withhold payment. Positive/mixed requests remain risky. */
export function voiceQuotePolicyText(message:string){
 if(!isVoiceSalesQuoteRequest(message))return message;
 // Normalize only a complete, explicitly negative execution clause in a quote request.
 // Commas may coordinate reserve/book/create. Contrast, conditions and later positive
 // payment clauses stay visible to the existing policy gate.
 const riskText=message.replace(/\b(?:do not|don't|don’t)\s+(?:(?:reserve|book)(?:\s+(?:(?:a|any|the)\s+)?(?:slot|booking|reservation))?\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+))*(?:create|take|collect|capture|process|make|send|start)\s+(?:(?:a|any|the)\s+)?(?:booking\s+(?:and|or)\s+(?:(?:a|any|the)\s+)?)?payment(?:\s+order)?\b(?:\s+(?:yet|now))?(?=\s*(?:[.!?;]|$))/gi,"");
 // A payment mode qualifies a read-only quote, never permission to execute payment.
 // Only the terminal qualifier is normalized; mixed financial commands remain visible.
 if(/\b(?:charge|capture|debit|transfer|refund|payout|execute|collect|process|initiate|send)\b/i.test(riskText))return message;
 return riskText.replace(/\bwith\s+(?:split|prepaid|full upfront)\s+payment\b(?=\s*[.!?]*$)/gi,"");
}
export async function ensureVoiceSalesOffers(db: D1Database) {
 return ensureD1Once(db,"voice_sales_offers",async()=>{
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS voice_sales_offers (id TEXT PRIMARY KEY,turn_key TEXT NOT NULL UNIQUE,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL,quote_json TEXT NOT NULL,actions_json TEXT NOT NULL,summary TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,confirmed_at INTEGER,result_json TEXT,completed_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS native_voice_offer_authority (turn_key TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS voice_sales_offers_thread ON voice_sales_offers(thread_id,customer_id,status,created_at)"),
 ]);
 });
}
// Carrier turns must retain authority at the atomic offer commit and receive a matching playout mark.
export async function beginNativeVoiceOfferTurn(db: D1Database, turnKey: string, threadId: string, customerId: string) {
 await ensureVoiceSalesOffers(db);
 await db.prepare("INSERT OR IGNORE INTO native_voice_offer_authority (turn_key,thread_id,customer_id,status,updated_at) VALUES (?,?,?,'awaiting',?)").bind(turnKey,threadId,customerId,Date.now()).run();
}
export async function cancelNativeVoiceOfferTurn(db: D1Database, turnKey: string, threadId: string, customerId: string) {
 await ensureVoiceSalesOffers(db);
 await db.batch([
  db.prepare("INSERT OR IGNORE INTO native_voice_offer_authority (turn_key,thread_id,customer_id,status,updated_at) VALUES (?,?,?,'cancelled',?)").bind(turnKey,threadId,customerId,Date.now()),
  db.prepare("UPDATE native_voice_offer_authority SET status='cancelled',updated_at=? WHERE turn_key=? AND thread_id=? AND customer_id=?").bind(Date.now(),turnKey,threadId,customerId),
  db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE turn_key=? AND thread_id=? AND customer_id=? AND status IN ('pending','app_only')").bind(turnKey,threadId,customerId),
 ]);
}
export async function acknowledgeNativeVoiceOfferTurn(db: D1Database, turnKey: string, threadId: string, customerId: string) {
 await ensureVoiceSalesOffers(db);
 await db.prepare("UPDATE native_voice_offer_authority SET status='delivered',updated_at=? WHERE turn_key=? AND thread_id=? AND customer_id=? AND status='awaiting'").bind(Date.now(),turnKey,threadId,customerId).run();
}
const nativeCommitFence = "EXISTS (SELECT 1 FROM native_voice_offer_authority WHERE turn_key=? AND thread_id=? AND customer_id=? AND status='awaiting')";
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
async function quoteSalesCoupon(db: D1Database, input: { code: string; customerId: string; cityId: string; quote: Row; channel: "website" | "whatsapp" }) {
 const { approvedSalesOffers, couponsLiveApproved } = await import("./ai-sales-offers");
 const { quoteCoupon } = await import("./coupon-governance");
 const petCount=Number(input.quote.petCount);
 if(!Number.isSafeInteger(petCount)||petCount<1||petCount>4)throw refusal("Coupon needs a verified pet-count quote",400);
 const {groomingPricingPackageCode}=await import("./grooming-pricing-code");
 const packageCode=input.quote.offerType==="subscription"?text(input.quote.packageCode):groomingPricingPackageCode(text(input.quote.packageCode),petCount);
 const context={serviceCode:"grooming" as const,cityId:input.cityId,channel:input.channel,packageCode,orderValue:Number(input.quote.totalAmount),paymentMode:"full" as const,isSubscription:input.quote.offerType==="subscription"};
 const approved=await approvedSalesOffers(db,{customerId:input.customerId,channel:input.channel,context});
 if(!approved.some(offer=>offer.code===input.code&&offer.package_code===packageCode))throw refusal("That coupon is not an offer PawSpace AI can apply for this customer",400);
 const result=await quoteCoupon(db,{...context,code:input.code,customerId:input.customerId},{liveApproved:await couponsLiveApproved()});
 if (!result.valid || !("quoteId" in result) || !result.quoteId) throw refusal(`The coupon could not be applied: ${result.error || "not eligible for this booking"}`);
 return { quoteId: result.quoteId, code: result.code, discount: Number(result.discount), finalAmount: Number(result.finalAmount) };
}
const writtenMoney = (v: unknown) => `INR ${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
function writtenSummaryFor(service: VoiceSalesService, quote: Row, schedule: Row) {
 const at = new Date(text(schedule.scheduledStart)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
 const plan = object(quote.subscriptionPlan), recommended = object(quote.recommendedProvider);
 const occurrences=Array.isArray(quote.occurrences)?quote.occurrences.map(object):[];
 const last=occurrences.length?new Date(text(occurrences[occurrences.length-1].start)).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"long"}):"";
 const cadence=Array.isArray(schedule.weekdays)&&schedule.weekdays.length?` on ${schedule.weekdays.map(day=>["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][Number(day)]).join(", ")}`:Number(schedule.cadenceDays)>0?` every ${schedule.cadenceDays} day(s)`:"";
 const terms = service === "pet_taxi" ? `${text(quote.originLabel)} to ${text(quote.destinationLabel)}${quote.returnDropLabel ? `, returning to ${text(quote.returnDropLabel)}` : ""}. Vehicle: ${text(quote.packageName)}. ${quote.passengerCount} passenger(s), ${quote.petCount} pet(s), ${quote.luggageCount} luggage item(s). Waiting: ${quote.waitingMinutes} minutes. The balance and any approved trip adjustments follow the quoted Taxi terms.` : service === "boarding" || service === "pet_sitting" ? `Care ends ${new Date(text(schedule.scheduledEnd)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })} India time. Recommended caregiver: ${text(recommended.name)}. Confirming selects this caregiver; provider acceptance remains pending.` : service === "dog_training" ? `${quote.sessions} session(s), ${quote.minutesPerSession} minutes per session${cadence}, valid for ${quote.validityDays} days.${occurrences.length>1?` Last planned session ${last}.`:""}`
  : quote.offerType === "subscription" ? `Prepaid bundle: ${plan.sessions} credits, ${plan.reserveSessions} credit(s) for this appointment, valid for ${plan.validityValue} ${plan.validityUnit}. This does not enable automatic renewal.` : "One-time grooming appointment.";
 const coupon = object(quote.coupon), discounted = text(coupon.quoteId) !== "";
 const total = discounted ? Number(coupon.finalAmount) : Number(quote.totalAmount), dueNow = discounted ? total : Number(quote.amountDueNow);
 const remaining = total - dueNow;
 return `${text(quote.packageName)} for ${quote.petCount} pet(s). ${terms}${discounted ? ` Coupon ${text(coupon.code)}: ${writtenMoney(coupon.discount)} off ${writtenMoney(quote.totalAmount)}.` : ""} Total ${writtenMoney(total)}; ${writtenMoney(dueNow)} due now${remaining > 0 ? ` and ${writtenMoney(remaining)} remaining under the quoted payment terms` : ""}. Requested start ${at} India time.${service === "dog_training" ? ` Recommended available trainer: ${text(recommended.name)}. Confirming also selects this trainer; you can ask for another option.` : ""} Availability was checked, not reserved. Shall I reserve this and create the booking with payment still pending?`;
}
function summaryFor(service: VoiceSalesService, quote: Row, schedule: Row, channel: SalesOfferChannel) {
 if (channel !== "voice") return writtenSummaryFor(service, quote, schedule);
 const at = new Date(text(schedule.scheduledStart)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
 const plan = object(quote.subscriptionPlan), recommended = object(quote.recommendedProvider);
 const occurrences=Array.isArray(quote.occurrences)?quote.occurrences.map(object):[];
 const last=occurrences.length?new Date(text(occurrences[occurrences.length-1].start)).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"long"}):"";
 const cadence=Array.isArray(schedule.weekdays)&&schedule.weekdays.length?` on ${schedule.weekdays.map(day=>["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][Number(day)]).join(", ")}`:Number(schedule.cadenceDays)>0?` every ${counted(schedule.cadenceDays,"day")}`:"";
 const terms = service === "pet_taxi" ? `${text(quote.originLabel)} to ${text(quote.destinationLabel)}${quote.returnDropLabel ? `, returning to ${text(quote.returnDropLabel)}` : ""}. Vehicle: ${text(quote.packageName)}. ${quote.passengerCount} passenger(s), ${quote.petCount} pet(s), ${quote.luggageCount} luggage item(s). Waiting: ${quote.waitingMinutes} minutes. The balance and any approved trip adjustments follow the quoted Taxi terms.` : service === "boarding" || service === "pet_sitting" ? `Care ends ${new Date(text(schedule.scheduledEnd)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })} India time. Recommended caregiver: ${text(recommended.name)}. Confirming selects this caregiver; provider acceptance remains pending.` : service === "dog_training" ? `${counted(quote.sessions,"session")}, ${quote.minutesPerSession} minutes per session${cadence}, valid for ${quote.validityDays} days.${occurrences.length>1?` Last planned session ${last}.`:""}`
  : quote.offerType === "subscription" ? `Prepaid bundle: ${counted(plan.sessions,"credit")}, ${counted(plan.reserveSessions,"credit")} for this appointment, valid for ${plan.validityValue} ${plan.validityUnit}. This does not enable automatic renewal.` : "One-time grooming appointment.";
 const coupon = object(quote.coupon), discounted = text(coupon.quoteId) !== "";
 const total = discounted ? Number(coupon.finalAmount) : Number(quote.totalAmount), dueNow = discounted ? total : Number(quote.amountDueNow);
 const remaining = total - dueNow;
 return `${text(quote.packageName)} for ${counted(quote.petCount,"pet")}. ${terms}${discounted ? ` Your approved coupon saves ${money(coupon.discount)} on the original ${money(quote.totalAmount)}.` : ""} The total is ${money(total)}, with ${money(dueNow)} due now${remaining > 0 ? ` and ${money(remaining)} remaining under the quoted payment terms` : ""}. Your requested appointment is ${at} India time.${service === "dog_training" ? ` Recommended available trainer: ${text(recommended.name)}. Confirming also selects this trainer; you can ask for another option.` : ""} Availability was checked, but the slot is not reserved yet. Shall I reserve it and create your booking? Payment will still be pending.`;
}
export type SalesOfferChannel = "voice" | "chat" | "whatsapp";
/** Where a customer pays a booking the AI created: the V2 booking page takes payment for any service. */
export async function bookingPaymentLink(bookingId: string, channel: SalesOfferChannel) {
 const path = `/v2/booking?bookingId=${encodeURIComponent(bookingId)}`;
 if (channel === "chat") return path;
 let origin = "https://pawspace.in";
 try { const { env } = await import("cloudflare:workers"); const configured = String((env as unknown as Row).PAWSPACE_PUBLIC_ORIGIN || "").trim(); if (/^https:\/\/[a-z0-9.-]+$/i.test(configured)) origin = configured; } catch { /* default origin */ }
 return `${origin}${path}`;
}
export async function prepareVoiceSalesOffer(db: D1Database, input: { actor: AuthenticatedActor; threadId: string; customerId: string; service: VoiceSalesService; turnKey: string; actions: AiActionRequest[]; channel?: SalesOfferChannel; nativeTurnKey?: string; onLookupPending?: () => () => void }): Promise<{id:string;summary:string;expiresAt:number;bookingPath?:string}> {
 await ensureVoiceSalesOffers(db); await assertOwner(db, input.threadId, input.customerId, input.actor);
 if (input.service === "all_services") {
  const requested = text(input.actions[0]?.arguments?.serviceCode);
  if (!["grooming", "dog_training", "boarding", "pet_sitting", "pet_taxi"].includes(requested)) throw refusal("This service requires its specialist booking workflow", 409);
  return prepareVoiceSalesOffer(db, { ...input, service: requested as VoiceSalesService });
 }
 const prior = await db.prepare("SELECT * FROM voice_sales_offers WHERE turn_key=?").bind(input.turnKey).first<Row>();
 if (prior) { if (prior.thread_id !== input.threadId || prior.customer_id !== input.customerId || prior.service_code !== input.service) throw refusal("Sales offer idempotency ownership mismatch", 403); return { id: text(prior.id), summary: text(prior.summary), expiresAt: Number(prior.expires_at), ...(prior.status === "app_only" ? { bookingPath: input.service === "boarding" ? "/v2/boarding" : "/v2/sitting" } : {}) }; }
 if (input.actions.length !== 3 || input.actions.map(a => a.toolCode).join(",") !== "schedule.reserve,booking.create,checkout.payment_order.create") throw refusal("Sales checkout must propose reservation, booking and payment order in that order", 400);
 const schedule = { ...object(input.actions[0].arguments) }, booking = { ...object(input.actions[1].arguments) };
 onlyKeys(schedule, ["serviceCode", "petIds", "serviceAddress", "servicePincode", "scheduledStart", "scheduledEnd", "cadenceDays", "weekdays", "occurrences"]);
 onlyKeys(booking, ["petIds", "packageCode", "paymentMode", "requirements", "couponCode", "boardingRequirements", "taxi"]);
 const couponCode = text(booking.couponCode).toUpperCase(); delete booking.couponCode;
 if (couponCode && input.service !== "grooming") throw refusal("This sales checkout applies coupons only to eligible Grooming offers", 400); onlyKeys(object(input.actions[2].arguments), []);
 if (text(schedule.serviceCode) !== input.service) throw refusal("The proposal does not belong to this sales specialist", 403);
 const ids = petIds(schedule.petIds), bookingPets = petIds(booking.petIds);
 if (JSON.stringify([...ids].sort()) !== JSON.stringify([...bookingPets].sort())) throw refusal("Booking pets differ from the proposed appointment", 400);
 const pets: Row[] = []; for (const petId of ids) { const pet = await db.prepare("SELECT id,species FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId, input.customerId).first<Row>(); if (!pet) throw refusal("Saved pet ownership could not be verified", 403); pets.push(pet); }
 if (!text(schedule.serviceAddress) || !/^\d{6}$/.test(text(schedule.servicePincode))) throw refusal("A complete service address and six-digit PIN are required", 400);
 const start = new Date(text(schedule.scheduledStart)); if (!Number.isFinite(start.getTime()) || start.getTime() <= Date.now()) throw refusal("A future appointment is required", 400);
 const mode = text(booking.paymentMode) || "prepaid"; booking.paymentMode = mode;
 let quote: Row;
 if (input.service === "pet_taxi") {
  const { prepareTaxiSalesQuote } = await import("./voice-taxi-sales");
  quote = await prepareTaxiSalesQuote(db,{schedule,booking,petCount:pets.length});
 } else if (input.service === "boarding" || input.service === "pet_sitting") {
  const { prepareStaySalesQuote } = await import("./voice-stay-sales");
  quote = await prepareStaySalesQuote(db, { actor: input.actor, customerId: input.customerId, service: input.service, turnKey: input.turnKey, schedule, booking, petCount: pets.length });
 } else if (input.service === "dog_training") {
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
  // Voice checkout is delivered over WhatsApp. Use that channel's campaign eligibility,
  // then let the canonical coupon engine calculate the only permitted discounted total.
  if (couponCode) { const coupon = await quoteSalesCoupon(db, { code: couponCode, customerId: input.customerId, cityId: address.cityId, quote, channel: input.channel === "chat" ? "website" : "whatsapp" }); quote = { ...quote, coupon }; booking.couponQuoteId = coupon.quoteId; }
 }
 // Stays are provider-priced information, followed by customer checkout in the app.
 // Never retain an executable proposal, even if an older model still sends one.
 if (input.service === "boarding" || input.service === "pet_sitting") {
  const provider = object(quote.recommendedProvider);
  const bookingPath = input.service === "boarding" ? "/v2/boarding" : "/v2/sitting";
  const date = (value: unknown) => new Date(text(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const summary = `${text(provider.name)} is currently available for ${text(quote.packageName)}, from ${date(schedule.scheduledStart)} to ${date(schedule.scheduledEnd)} India time. This caregiver's quote is ${money(quote.totalAmount)} for ${counted(quote.petCount,"pet")}. Complete the booking in the PawSpace app. Availability and price will be checked again there; nothing is reserved, booked or paid yet.`;
  const offerId = id(), now = Date.now(), expiresAt = Math.min(now + 10 * 60000, Number(quote.expiresAt) || Infinity);
  await db.batch([
   db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE thread_id=? AND customer_id=? AND status='pending' AND (? IS NULL OR "+nativeCommitFence+")").bind(input.threadId,input.customerId,input.nativeTurnKey??null,input.nativeTurnKey??null,input.threadId,input.customerId),
   db.prepare("INSERT INTO voice_sales_offers (id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) SELECT ?,?,?,?,?,'app_only',?,'[]',?,?,? WHERE ? IS NULL OR "+nativeCommitFence).bind(offerId,input.turnKey,input.threadId,input.customerId,input.service,JSON.stringify(quote),summary,expiresAt,now,input.nativeTurnKey??null,input.nativeTurnKey??null,input.threadId,input.customerId),
  ]);
  return { id: offerId, summary, expiresAt, bookingPath };
 }
 const { executeGovernedSchedulingRequest } = await import("../app/api/uat-scheduling/route");
 const stopAcknowledgment = input.onLookupPending?.();
 let response: Response;
 try { response = await executeGovernedSchedulingRequest(new Request("https://internal.pawspace/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...schedule, action: "preview", customerId: input.customerId, clientRequestId: `preview:${input.turnKey}` }) }), input.actor); } finally { stopAcknowledgment?.(); }
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
 const offerId = id(), now = Date.now(), expiresAt = Math.min(now + 10 * 60000, Number(quote.expiresAt) || Infinity), summary = summaryFor(input.service, quote, schedule, input.channel || "voice");
 await db.batch([
  db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE thread_id=? AND customer_id=? AND status='pending' AND (? IS NULL OR "+nativeCommitFence+")").bind(input.threadId,input.customerId,input.nativeTurnKey??null,input.nativeTurnKey??null,input.threadId,input.customerId),
  db.prepare("INSERT INTO voice_sales_offers (id,turn_key,thread_id,customer_id,service_code,status,quote_json,actions_json,summary,expires_at,created_at) SELECT ?,?,?,?,?,'pending',?,?,?,?,? WHERE ? IS NULL OR "+nativeCommitFence).bind(offerId,input.turnKey,input.threadId,input.customerId,input.service,JSON.stringify(quote),JSON.stringify(actions),summary,expiresAt,now,input.nativeTurnKey??null,input.nativeTurnKey??null,input.threadId,input.customerId),
 ]);
 return { id: offerId, summary, expiresAt };
}
export async function pendingVoiceSalesOffer(db: D1Database, threadId: string, customerId: string, service: VoiceSalesService, requireNativeDelivery = false) {
 await ensureVoiceSalesOffers(db);
 const delivered = requireNativeDelivery ? " AND EXISTS (SELECT 1 FROM native_voice_offer_authority a WHERE a.turn_key=voice_sales_offers.turn_key AND a.thread_id=voice_sales_offers.thread_id AND a.customer_id=voice_sales_offers.customer_id AND a.status='delivered')" : "";
 if (service === "all_services") return db.prepare("SELECT * FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND status='pending'"+delivered+" ORDER BY created_at DESC LIMIT 1").bind(threadId, customerId).first<Row>();
 return db.prepare("SELECT * FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code=? AND status='pending'"+delivered+" ORDER BY created_at DESC LIMIT 1").bind(threadId, customerId, service).first<Row>();
}
export async function invalidateVoiceSalesOffers(db: D1Database, threadId: string, customerId: string, nativeTurnKey?: string) {
 await ensureVoiceSalesOffers(db);
 await db.prepare("UPDATE voice_sales_offers SET status='superseded' WHERE thread_id=? AND customer_id=? AND status='pending' AND (? IS NULL OR "+nativeCommitFence+")").bind(threadId,customerId,nativeTurnKey??null,nativeTurnKey??null,threadId,customerId).run();
}
function resultValue(value: unknown, key: string): string {
 const row = object(value); if (typeof row[key] === "string") return row[key] as string;
 for (const child of Object.values(row)) if (child && typeof child === "object") { const found = resultValue(child, key); if (found) return found; } return "";
}
export async function confirmVoiceSalesOffer(db: D1Database, input: { actor: AuthenticatedActor; threadId: string; customerId: string; service: VoiceSalesService; offerId: string; confirmation: string; channel?: SalesOfferChannel; nativeTurnKey?: string; assertCurrent?: () => void }) {
 await assertNativeDemoBusinessAllowed(db,input.threadId);
 await ensureVoiceSalesOffers(db); await assertOwner(db, input.threadId, input.customerId, input.actor);
 if (!isVoiceSalesConfirmation(input.confirmation)) throw refusal("A separate unambiguous confirmation of the quoted offer is required", 400);
 if (input.service === "all_services") {
  const stored = await db.prepare("SELECT service_code FROM voice_sales_offers WHERE id=? AND thread_id=? AND customer_id=?").bind(input.offerId,input.threadId,input.customerId).first<Row>();
  if (!stored || !["grooming","dog_training","boarding","pet_sitting","pet_taxi"].includes(text(stored.service_code))) throw refusal("The confirmed service cannot be verified",403);
  input = { ...input, service: text(stored.service_code) as VoiceSalesService };
 }
 const offer = await db.prepare("SELECT * FROM voice_sales_offers WHERE id=? AND thread_id=? AND customer_id=? AND service_code=?").bind(input.offerId, input.threadId, input.customerId, input.service).first<Row>();
 if (!offer) throw refusal("Sales offer ownership could not be verified", 403);
 if (input.service === "boarding" || input.service === "pet_sitting") throw refusal("Complete Boarding or Sitting booking in the PawSpace app; voice information cannot confirm a stay");
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
 input.assertCurrent?.();
 const claimed = await db.prepare("UPDATE voice_sales_offers SET status='executing',confirmed_at=? WHERE id=? AND status='pending' AND expires_at>=? AND (? IS NULL OR ("+nativeCommitFence+" AND EXISTS (SELECT 1 FROM native_voice_offer_authority a WHERE a.turn_key=voice_sales_offers.turn_key AND a.thread_id=voice_sales_offers.thread_id AND a.customer_id=voice_sales_offers.customer_id AND a.status='delivered')))").bind(Date.now(),input.offerId,Date.now(),input.nativeTurnKey??null,input.nativeTurnKey??null,input.threadId,input.customerId).run();
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
  // Voice never reads URLs aloud. Queue the secure PawSpace checkout page to WhatsApp through
  // the governed communication outbox; queued is not delivered and order creation is not payment success.
  const channel = input.channel ?? "voice";
  const payLink = await bookingPaymentLink(bookingId, channel === "chat" ? "chat" : "whatsapp");
  let paymentMessageId:string|null=null,paymentLinkQueued=false,paymentLinkQueueStatus:string|null=null;
  if(channel==="voice"){
   const booking=await db.prepare("SELECT city_id FROM canonical_bookings WHERE id=? AND customer_id=?").bind(bookingId,input.customerId).first<Row>();
   const queued=await enqueueCommunication(db,{customerId:input.customerId,cityId:text(booking?.city_id)||"blr",channel:"whatsapp",purpose:"transactional",idempotencyKey:`voice-booking-checkout:${input.offerId}`,templateKey:"voice_booking_checkout_ready",bookingId,payload:{text:"Your PawSpace booking is created. Use this secure checkout link to complete payment. We will confirm the booking payment only after Razorpay verification.",bookingId,orderId,paymentLink:payLink,paymentProvider:"razorpay",paymentVerified:false,source:"voice_sales"},createdBy:"voice-sales@system.pawspace",asOf:Date.now()});
   const q=queued as unknown as Row;paymentMessageId=text(q.messageId)||text(object(q.message).id)||null;paymentLinkQueueStatus=text(q.status)||text(object(q.message).status)||null;paymentLinkQueued=paymentLinkQueueStatus!=="suppressed";
  }
  const output = channel==="voice"
   ? (paymentLinkQueued?"Your booking has been created and the secure Razorpay checkout is ready. I have queued the payment link to your WhatsApp. Payment is still pending verification.":"Your booking has been created and the secure Razorpay checkout is ready. I could not queue the WhatsApp link under the current communication preferences. Payment is still pending verification.")
   : `Your booking is created. Pay securely here to confirm it: ${payLink}\nIt is confirmed as soon as the payment is verified; I'll let you know here.`;
  const result = { offerId: input.offerId, bookingId, orderId, paymentVerified: false, paymentLinkDelivered: false, paymentLinkQueued, paymentLinkQueueStatus, paymentMessageId, payLink:channel==="voice"?null:payLink, output };
  await db.prepare("UPDATE voice_sales_offers SET status='completed',result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(JSON.stringify(result), Date.now(), input.offerId).run();
  return { ...result, duplicatePrevented: false };
 } catch (error) {
  await db.prepare("UPDATE voice_sales_offers SET status='failed',result_json=?,completed_at=? WHERE id=? AND status='executing'").bind(JSON.stringify({ groupId, bookingId, orderId, paymentVerified: false, requiresReview: true }), Date.now(), input.offerId).run();
  throw error;
 }
}
