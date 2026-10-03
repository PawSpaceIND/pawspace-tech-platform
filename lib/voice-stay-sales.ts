import type { AuthenticatedActor } from "./server-auth";
import { createLiveBoardingQuote, createLiveSittingQuote } from "./live-commercial-quotes";
import { requireBoardingRequirements, hostMeetsRequirements } from "./stay-host-requirements";

type Row = Record<string, unknown>;
type StayService = "boarding" | "pet_sitting";
const text = (v: unknown) => String(v ?? "").trim();
const refuse = (message: string, status = 409) => new Response(message, { status });

/** Reuse the app's live pricing and scheduler; the model never selects a provider or price. */
export async function prepareStaySalesQuote(db: D1Database, input: {
 actor: AuthenticatedActor; customerId: string; service: StayService; turnKey: string;
 schedule: Row; booking: Row; petCount: number;
}): Promise<Row> {
 const { schedule, booking, service } = input;
 if (!["prepaid", "split_50_50"].includes(text(booking.paymentMode))) throw refuse("Please choose full payment upfront, or a 50/50 split if this is an eligible overnight stay longer than four nights. For an eligible split, the remaining half is due 24 hours before check-in.", 400);
 const start = Date.parse(text(schedule.scheduledStart)), end = Date.parse(text(schedule.scheduledEnd));
 if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw refuse("Exact start and end times are required for care", 400);
 if (schedule.occurrences !== undefined && Number(schedule.occurrences) !== 1) throw refuse("A stay uses one continuous care reservation", 400);
 if (schedule.cadenceDays !== undefined || schedule.weekdays !== undefined) throw refuse("A stay cannot include an unrelated recurring schedule", 400);
 schedule.occurrences = 1;
 if (service === "boarding") booking.boardingRequirements = requireBoardingRequirements(booking.boardingRequirements);
 else {
  if (booking.boardingRequirements !== undefined) throw refuse("Host-home requirements do not belong to in-home Sitting", 400);
  const { ensureSittingGovernanceTables } = await import("./sitting-governance");
  await ensureSittingGovernanceTables(db);
  const pack = await db.prepare("SELECT mode FROM sitting_commercial_packages WHERE package_code=? AND active=1").bind(text(booking.packageCode)).first<Row>();
  if (!pack || !["visit", "overnight"].includes(text(pack.mode))) throw refuse("Choose an active Sitting package", 400);
  schedule.careMode = pack.mode;
 }
 const { executeGovernedSchedulingRequest } = await import("../app/api/uat-scheduling/route");
 const response = await executeGovernedSchedulingRequest(new Request("https://internal.pawspace/api/uat-scheduling", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...schedule, action: "preview", customerId: input.customerId, clientRequestId: `stay-preview:${input.turnKey}` }),
 }), input.actor);
 const payload = await response.json() as { error?: string; data?: { providers?: Row[]; cityId?: string; zoneId?: string } };
 const available = payload.data;
 if (!response.ok || !available?.providers?.length || !available.cityId || !available.zoneId) throw refuse(payload.error || "Care availability could not be verified");
 let candidates = available.providers;
 if (service === "boarding") {
  const { listBoardingHosts } = await import("./boarding-governance");
  const hosts = await listBoardingHosts(db,{cityId:available.cityId,zoneId:available.zoneId,at:text(schedule.scheduledStart)});
  const ownedPets = await Promise.all((schedule.petIds as string[]).map(petId => db.prepare("SELECT species,vaccination_status FROM canonical_pets WHERE id=? AND customer_id=?").bind(petId,input.customerId).first<Row>()));
  if (ownedPets.some(pet => !pet || pet.vaccination_status !== "verified")) throw refuse("Boarding needs verified vaccination for every selected pet");
  const requirements = requireBoardingRequirements(booking.boardingRequirements);
  candidates = candidates.filter(candidate => hosts.some(host => host.providerId === candidate.id
   && host.homeVerified && host.kycStatus === "verified" && host.backgroundCheckStatus === "verified"
   && host.capacity >= input.petCount && ownedPets.every(pet => host.species.includes(text(pet?.species)))
   && hostMeetsRequirements(host,requirements)));
 }
 const provider = candidates[0];
 if (!provider) throw refuse("No available caregiver matches the stated care requirements");
 if (!text(provider.id) || !text(provider.name)) throw refuse("A named available caregiver is required");
 const createQuote = service === "boarding" ? createLiveBoardingQuote : createLiveSittingQuote;
 const quote = await createQuote(db, {
  packageCode: text(booking.packageCode), petCount: input.petCount,
  scheduledStart: text(schedule.scheduledStart), scheduledEnd: text(schedule.scheduledEnd),
  paymentMode: text(booking.paymentMode) as "prepaid" | "split_50_50",
  cityId: available.cityId, zoneId: available.zoneId, providerId: text(provider.id),
 });
 if (!("priceSource" in quote) || !("providerId" in quote) || quote.priceSource !== "provider_rate" || quote.providerId !== text(provider.id)) {
  throw refuse("The available caregiver has no verified published rate for this care window. Please complete price review in the PawSpace app or with the team");
 }
 // The quoted provider's rate must also be the rate/provider the customer confirms.
 schedule.preferredProviderId = provider.id;
 booking[service === "boarding" ? "boardingQuoteId" : "sittingQuoteId"] = quote.quoteId;
 return { ...quote, recommendedProvider: { id: provider.id, name: provider.name } };
}

/** Only a persisted, currently executing offer can supply commercial values to booking creation. */
export async function confirmedStaySalesPayload(db: D1Database, input: {
 threadId: string; customerId: string; service: StayService; args: Row; petCount: number;
 scheduledStart: string; scheduledEnd: string; providerId: string;
}) {
 const quoteKey = input.service === "boarding" ? "boardingQuoteId" : "sittingQuoteId";
 const quoteId = text(input.args[quoteKey]);
 if (!quoteId) throw refuse("A confirmed stay quote is required", 400);
 const owner = await db.prepare("SELECT quote_json FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code=? AND status='executing' AND json_extract(quote_json,'$.quoteId')=? LIMIT 1")
  .bind(input.threadId, input.customerId, input.service, quoteId).first<Row>();
 if (!owner) throw refuse("Stay quote does not belong to this confirmed conversation", 403);
 const saved = JSON.parse(text(owner.quote_json)) as Row;
 const provider = saved.recommendedProvider as Row | undefined;
 if (text(provider?.id) !== input.providerId) throw refuse("The quoted caregiver changed; a new quote and confirmation are required");
 // Keep both table references explicit so the schema audit verifies each service.
 const statement = input.service === "boarding"
  ? db.prepare("SELECT q.*,p.name FROM boarding_commercial_quotes q JOIN boarding_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=? AND q.status='open' AND q.expires_at>=? AND p.active=1 AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?)")
  : db.prepare("SELECT q.*,p.name FROM sitting_commercial_quotes q JOIN sitting_commercial_packages p ON p.package_code=q.package_code AND p.version=q.package_version WHERE q.id=? AND q.status='open' AND q.expires_at>=? AND p.active=1 AND p.effective_from<=? AND (p.effective_to IS NULL OR p.effective_to>=?)");
 const quote = await statement
  .bind(quoteId, Date.now(), input.scheduledStart.slice(0, 10), input.scheduledStart.slice(0, 10)).first<Row>();
 if (!quote || text(quote.package_code) !== text(input.args.packageCode) || text(quote.payment_mode) !== text(input.args.paymentMode)
  || Number(quote.pet_count) !== input.petCount || Date.parse(text(quote.scheduled_start)) !== Date.parse(input.scheduledStart)
  || Date.parse(text(quote.scheduled_end)) !== Date.parse(input.scheduledEnd)
  || Number(quote.total_amount) !== Number(saved.totalAmount) || Number(quote.amount_due_now) !== Number(saved.amountDueNow)) {
  throw refuse("Stay quote expired or its confirmed terms changed");
 }
 return {
  serviceCode: input.service, packageCode: text(quote.package_code), packageName: text(quote.name),
  totalAmount: Number(quote.total_amount), amountDueNow: Number(quote.amount_due_now),
  pricing: { discount: 0, [quoteKey]: quoteId, ...(input.service === "boarding" ? { boardingRequirements: requireBoardingRequirements(input.args.boardingRequirements) } : {}) },
 };
}
