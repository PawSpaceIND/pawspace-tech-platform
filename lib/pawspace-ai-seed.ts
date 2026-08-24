/**
 * "Trains" the PawSpace assistant the right way for a Claude-based bot: not by fine-tuning model
 * weights (you can't, and shouldn't), but by GROUNDING it - a governed assistant profile, a system
 * prompt policy, and an approved knowledge base the bot must answer from. This is a starter set that
 * staff refine in Control; everything goes through the normal draft -> review -> approve -> activate
 * lifecycle so it's versioned and auditable.
 *
 * Deliberately price-free: the bot quotes prices LIVE from the catalogue tool, never from static
 * knowledge - so a price change is instantly correct and the bot can't hallucinate a number.
 */

import { createAiBusinessDraft, transitionAiBusinessConfig } from "./ai-business-configuration";
import { AI_PROVIDER_REF, DEFAULT_AI_MODEL_REF } from "./ai-provider-adapter";

type Db = D1Database;
type EntityType = "profile" | "intent" | "knowledge" | "prompt";

async function activate(db: Db, entityType: EntityType, payload: Record<string, unknown>, maker: string, checker: string) {
  const draft = await createAiBusinessDraft(db, { entityType, payload, actorEmail: maker });
  await transitionAiBusinessConfig(db, { entityType, entityId: draft.id, action: "submit_review", actorEmail: maker });
  await transitionAiBusinessConfig(db, { entityType, entityId: draft.id, action: "approve", actorEmail: checker });
  await transitionAiBusinessConfig(db, { entityType, entityId: draft.id, action: "activate", actorEmail: checker });
  return draft;
}

const KNOWLEDGE: Array<{ sourceKey: string; title: string; contentText: string }> = [
  { sourceKey: "services_overview", title: "PawSpace services", contentText: "PawSpace offers at-home and doorstep pet care: Grooming, Dog Training, Boarding, Pet Sitting, Pet Taxi (pick & drop), Dog Walking, Fresh Food, and Funeral/Memorial. Bookings are made in the app; a vetted provider is auto-assigned. Prices are always quoted live from the current catalogue - never quote a price from memory; use the quote tool." },
  { sourceKey: "how_booking_works", title: "How booking works", contentText: "The customer picks a service, pet, date and time; PawSpace auto-schedules a governed provider and confirms the booking. For online payment the customer pays via UPI/GPay through a secure Razorpay order and the booking is marked paid only after the payment is verified. Booking status, reschedules and cancellations are available in the app." },
  { sourceKey: "cancellation_refund", title: "Cancellations & refunds", contentText: "A customer can cancel or reschedule from the app subject to the service's policy. Eligible refunds are governed and reviewed by Finance (maker/checker) before any money moves; the assistant never promises or issues a refund itself - it hands off refund and payment-dispute requests to a human." },
  { sourceKey: "pawspace_wallet", title: "PawSpace Wallet", contentText: "PawSpace Wallet holds store credit that can come from a refund, a cancellation, or goodwill. When wallet credit is spent on a future booking the customer gets 10% enhanced value - every Rs.100 of wallet becomes Rs.110 of booking value, never applied beyond the booking total. The wallet balance and history are visible in the app." },
  { sourceKey: "paw_points_loyalty", title: "PawPoints loyalty", contentText: "Customers earn PawPoints on completed bookings and can redeem them for a discount on a future booking (redemption is capped per booking). Goodwill and win-back points may also be granted by staff. Balances and the full points ledger are shown in the app." },
  { sourceKey: "pet_passport", title: "Pet Passport", contentText: "The Pet Passport is one shareable card per pet that ties together the pet's basics, birthday, real vaccination status and the owner's loyalty tier, with badges like 'Fully Vaccinated'. Owners can share a privacy-safe public link that shows the pet's card with no owner personal details." },
  { sourceKey: "vaccination_reminders", title: "Vaccination records & reminders", contentText: "PawSpace stores each pet's vaccination records and due dates and reminds the owner when a vaccination is due or overdue. Keeping vaccinations up to date is required for some services like Boarding." },
  { sourceKey: "birthday_offer", title: "Pet birthday offer", contentText: "Around a pet's birthday, PawSpace surfaces a birthday grooming offer for that pet. The assistant can mention an upcoming birthday and the offer, but the exact discount is applied by the app, not quoted from memory." },
  { sourceKey: "reviews_rewards", title: "Reviews & rewards", contentText: "After a service the customer may be asked to review it. A 5-star rating surfaces the Google and app review links. Posting a public review can earn a coupon (one review earns a coupon; both platforms on the same order earn a larger grooming coupon), subject to the reward terms." },
  { sourceKey: "emergency_help", title: "Emergency help", contentText: "The app has an emergency help option for urgent pet situations that raises a priority case and can dispatch help. For any medical emergency, advise contacting a veterinarian immediately - the assistant never gives a medical diagnosis and always escalates safety and emergency matters to a human." },
];

const INTENTS: Array<{ intentCode: string; workflowMapping: string; escalationRule: string; requiredFields: string[]; confidenceThreshold: number }> = [
  { intentCode: "service_info", workflowMapping: "answer_from_approved_knowledge + quote.request", escalationRule: "handoff_if_low_confidence", requiredFields: [], confidenceThreshold: 0.6 },
  { intentCode: "booking_status", workflowMapping: "booking_status.read", escalationRule: "handoff_if_not_owned", requiredFields: ["bookingId"], confidenceThreshold: 0.6 },
  { intentCode: "subscription_wallet", workflowMapping: "subscription_wallet.read", escalationRule: "handoff_if_low_confidence", requiredFields: [], confidenceThreshold: 0.6 },
  { intentCode: "support", workflowMapping: "case_status.read + human_handoff", escalationRule: "handoff_on_complaint_or_safety", requiredFields: [], confidenceThreshold: 0.5 },
  { intentCode: "refund_review", workflowMapping: "human_handoff", escalationRule: "always_handoff", requiredFields: [], confidenceThreshold: 0.5 },
];

const SYSTEM_PROMPT = `You are the PawSpace assistant helping pet parents in India across WhatsApp, chat and voice.
Rules you must always follow:
- Only answer from the approved PawSpace knowledge and the server tools. If you don't know, say so and offer a human.
- Never quote a price, discount or availability from memory - always use the live quote/catalogue tool.
- Never claim an action is done (booking, payment, refund, cancellation) unless a tool confirms it.
- You cannot issue refunds, capture payments, change prices, assign providers or start campaigns - hand those to a human.
- Immediately hand off complaints, refund/payment disputes, safety and any pet medical emergency to a human. Never give medical advice.
- Be warm, concise and clear. Reply in the customer's language (English, Hindi or Tamil) when you can.`;

/** Seed + activate the starter PawSpace assistant grounding (profile + prompt + knowledge + intents). */
export async function seedPawspaceAiAssistant(db: Db, input: { maker: string; checker: string }) {
  const { maker, checker } = input;
  const profile = await activate(db, "profile", { profileKey: "pawspace_default", brandVoice: "Warm, trustworthy, concise - a caring pet-care concierge.", supportedLanguages: ["en", "hi", "ta"], greetingText: "Hi! I'm the PawSpace assistant. How can I help you and your pet today?", fallbackText: "I'm not fully sure about that - let me connect you to a PawSpace team member.", modelRef: DEFAULT_AI_MODEL_REF, providerRef: AI_PROVIDER_REF }, maker, checker);
  const prompt = await activate(db, "prompt", { policyKey: "pawspace_system", systemPrompt: SYSTEM_PROMPT, policy: { groundedOnly: true, neverQuotePriceFromMemory: true, forbiddenAutonomousActions: ["refund", "payment", "price_change", "provider_assignment", "campaign_activation"], handoffTopics: ["complaint", "refund_dispute", "payment_dispute", "safety", "medical_emergency"] } }, maker, checker);
  const knowledge = [];
  for (const k of KNOWLEDGE) knowledge.push(await activate(db, "knowledge", { sourceKey: k.sourceKey, title: k.title, contentText: k.contentText, sourceType: "policy", visibilityScope: ["public"] }, maker, checker));
  const intents = [];
  for (const i of INTENTS) intents.push(await activate(db, "intent", { intentCode: i.intentCode, businessOwner: "cx@pawspace.in", workflowMapping: i.workflowMapping, escalationRule: i.escalationRule, requiredFields: i.requiredFields, confidenceThreshold: i.confidenceThreshold, enabled: true }, maker, checker));
  return { profile: profile.id, prompt: prompt.id, knowledgeCount: knowledge.length, intentCount: intents.length };
}
