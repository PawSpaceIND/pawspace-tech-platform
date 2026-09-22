import { trainingBookingPaymentState } from "../../../lib/training-payment-eligibility";
import { authError, database, requirePermission, requireProviderOwnership, resolveActor } from "../../../lib/server-auth";
import { listTrainerSessions } from "../../../lib/training-session-lifecycle";
import { projectTrainerSession } from "../../../lib/training-provider-projection";
import { ensureTrainingCommercialTables } from "../../../lib/training-commercial-governance";
import { maskName } from "../../../lib/platform-security";
import { GET as getGroomingJobs } from "../partner-grooming-jobs/route";

type Row = Record<string, unknown>;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const parse = <T,>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } };

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "bookings.view");
    const providerId = String(new URL(request.url).searchParams.get("providerId") || "").trim();
    if (!providerId) return json({ error: "Provider ID is required" }, 400);
    const db = await database();
    await requireProviderOwnership(db, actor, providerId);

    const profile = await db.prepare("SELECT name,services_json FROM provider_capacity_profiles WHERE id=? AND status='active' AND live=1").bind(providerId).first<Row>().catch(() => null);
    const services = new Set(parse<string[]>(profile?.services_json, []));
    const result: Record<string, unknown>[] = [];

    if (services.has("grooming")) {
      const url = new URL(request.url); url.pathname = "/api/partner-grooming-jobs";
      const response = await getGroomingJobs(new Request(url, request));
      const body = await response.json() as { jobs?: Record<string, unknown>[]; error?: string };
      if (!response.ok) return json({ error: body.error || "Unable to load Grooming jobs" }, response.status);
      for (const job of body.jobs ?? []) result.push({ ...job, serviceCode: "grooming" });
    }

    if (services.has("dog_training")) {
      const sessions = await listTrainerSessions(db, providerId);
      await ensureTrainingCommercialTables(db);
      const commercialByBooking = new Map<string, Row>();
      for (const raw of sessions) {
        const session = projectTrainerSession({ ...raw, customer_name: maskName(String((raw as Row).customer_name || "Customer")) });
        let commercial = commercialByBooking.get(session.booking_id);
        if (!commercial) {
          commercial = await db.prepare("SELECT b.total_amount,b.currency,b.city_id,b.zone_id,b.status booking_status,p.method,p.mode,p.status payment_status,p.amount_due_now,q.payment_mode,q.amount_due_now quote_due_now FROM canonical_bookings b LEFT JOIN booking_payments p ON p.booking_id=b.id LEFT JOIN training_booking_quote_links l ON l.booking_id=b.id LEFT JOIN training_commercial_quotes q ON q.id=l.quote_id WHERE b.id=? AND b.service_code='dog_training'").bind(session.booking_id).first<Row>() ?? {};
          const funding = await trainingBookingPaymentState(db, session.booking_id);
          commercial = {...commercial, funding_status:funding.status, amount_paid:funding.amountPaid};
          commercialByBooking.set(session.booking_id, commercial);
        }
        const totalAmount = Number(commercial.total_amount || 0);
        const inactive = ["cancelled", "refunded", "failed", "expired"].includes(String(commercial.booking_status));
        const refunded = ["refunded", "partially_refunded"].includes(String(commercial.payment_status));
        const paymentStatus = refunded ? String(commercial.payment_status) : commercial.funding_status === "FULLY_PAID" ? "captured" : commercial.funding_status === "PARTIALLY_PAID" ? "partially_paid" : "pending";
        const amountPaid = Number(commercial.amount_paid || 0);
        const amountDueNow = inactive || refunded || paymentStatus === "captured" ? 0 : Math.max(0, Number(commercial.quote_due_now ?? commercial.amount_due_now ?? totalAmount) - amountPaid);
        result.push({
          serviceCode: "dog_training",
          bookingId: session.booking_id,
          workOrderId: `TRAINING-SESSION-${session.id}`,
          trainingSessionId: session.id,
          providerId: session.provider_id,
          providerName: String(profile?.name || "PawSpace Trainer"),
          providerModel: "trainer",
          status: session.status,
          workOrderStatus: session.status,
          occurrenceCount: 1,
          packageCode: session.plan_code,
          packageName: session.plan_name || "Dog Training",
          zoneId: String(commercial.zone_id || ""),
          cityId: String(commercial.city_id || ""),
          scheduledStart: session.scheduled_start,
          scheduledEnd: session.scheduled_end,
          totalAmount,
          currency: String(commercial.currency || "INR"),
          customer: { id: session.customer_id, name: session.customer_name, maskedPhone: "Masked" },
          pets: session.petIds.map(id => ({ id, name: "Pet", species: "dog", breed: "", vaccinationStatus: "not_provided" })),
          payment: { method: String(commercial.method || "online"), mode: String(commercial.payment_mode || commercial.mode || "prepaid"), status: paymentStatus, amount: totalAmount, amountDueNow },
          training: { sequenceNo: session.sequence_no, totalSessions: session.total_sessions, completedSessions: session.completed_sessions, programmeStatus: session.programme_status, requirements: session.requirements, attendance: session.attendance, homework: session.homework, progress: session.progress, evidenceRefs: session.evidenceRefs },
          subscription: null,
          safetyRequirements: [],
          addOns: [],
          proof: null,
          invoice: null,
          events: session.events.map(event=>({...event,occurredAt:event.createdAt,entityType:"training_session"})),
        });
      }
    }

    result.sort((a, b) => String(a.scheduledStart || "").localeCompare(String(b.scheduledStart || "")));
    return json({ source: "canonical provider jobs", providerId, services: [...services], jobs: result });
  } catch (error) {
    return authError(error, "Unable to load Partner jobs");
  }
}
