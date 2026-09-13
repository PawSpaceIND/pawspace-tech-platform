import { authError, database, requirePermission, requireProviderOwnership, resolveActor } from "../../../lib/server-auth";
import { listTrainerSessions } from "../../../lib/training-session-lifecycle";
import { projectTrainerSession } from "../../../lib/training-provider-projection";
import { maskName } from "../../../lib/platform-security";
import { GET as getGroomingJobs } from "../partner-grooming-jobs/route";

type Row = Record<string, unknown>;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const parse = <T,>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } };

export async function GET(request: Request) {
  try {
    const providerId = String(new URL(request.url).searchParams.get("providerId") || "").trim();
    if (!providerId) return json({ error: "Provider ID is required" }, 400);
    const db = await database();
    const actor = await resolveActor(request);
    requirePermission(actor, "bookings.view");
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
      for (const raw of sessions) {
        const session = projectTrainerSession({ ...raw, customer_name: maskName(String((raw as Row).customer_name || "Customer")) });
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
          zoneId: "",
          cityId: "blr",
          scheduledStart: session.scheduled_start,
          scheduledEnd: session.scheduled_end,
          totalAmount: 0,
          currency: "INR",
          customer: { id: session.customer_id, name: session.customer_name, maskedPhone: "Masked" },
          pets: session.petIds.map(id => ({ id, name: "Pet", species: "dog", breed: "", vaccinationStatus: "not_provided" })),
          payment: { method: "governed", mode: "programme", status: "programme", amount: 0, amountDueNow: 0 },
          training: { sequenceNo: session.sequence_no, totalSessions: session.total_sessions, completedSessions: session.completed_sessions, programmeStatus: session.programme_status, requirements: session.requirements, attendance: session.attendance, homework: session.homework, progress: session.progress, evidenceRefs: session.evidenceRefs },
          proof: null,
          invoice: null,
          events: session.events,
        });
      }
    }

    result.sort((a, b) => String(a.scheduledStart || "").localeCompare(String(b.scheduledStart || "")));
    return json({ source: "canonical provider jobs", providerId, services: [...services], jobs: result });
  } catch (error) {
    return authError(error, "Unable to load Partner jobs");
  }
}
