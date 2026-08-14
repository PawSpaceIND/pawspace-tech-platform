/**
 * The Team home front door's numbers, derived from real platform data.
 *
 * /team used to render a static shell: "Revenue actions 100", "Open escalations 3", "7 PM command
 * pack Ready", "18 bookings today", "3 need attention", "Day close pending" and "8 active partners"
 * were literals typed into the page, so the first screen every staff member saw was fiction that
 * never moved. Every one of those figures already exists in a canonical table — this reads them.
 *
 * Cold-DB safe: a table that no module has created yet yields null (rendered as "—"), never a
 * fabricated number and never a 500.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value || 0);

async function one(db: Db, sql: string, binds: unknown[] = []): Promise<Row | null> {
  try {
    let statement = db.prepare(sql);
    if (binds.length) statement = statement.bind(...binds);
    return await statement.first<Row>();
  } catch {
    return null; // table not created yet on a cold database
  }
}

/** IST calendar day — the same day key the CRM engine and finance closure use. */
const istDay = (at: number) => new Date(at + 19_800_000).toISOString().slice(0, 10);

export async function buildTeamOverview(db: Db, input: { actorEmail: string; actorName: string; roleCode: string; permissions?: string[]; asOf?: number }) {
  const asOf = input.asOf ?? Date.now();
  const today = istDay(asOf);
  const startIso = `${today}T00:00:00.000Z`, endIso = `${today}T23:59:59.999Z`;

  const [opportunities, tickets, reports, bookings, closure, people, slaPolicy] = await Promise.all([
    // ranked revenue actions still open for today — the Daily 100 worklist
    one(db, "SELECT COUNT(*) count FROM revenue_opportunities WHERE opportunity_date=? AND status!='completed'", [today]),
    one(db, "SELECT SUM(CASE WHEN status!='resolved' THEN 1 ELSE 0 END) open,SUM(CASE WHEN status!='resolved' AND escalation_level>0 THEN 1 ELSE 0 END) escalated FROM customer_experience_tickets"),
    one(db, "SELECT COUNT(*) count FROM command_report_runs WHERE report_date=?", [today]),
    one(db, "SELECT COUNT(*) count FROM canonical_bookings WHERE scheduled_start>=? AND scheduled_start<=? AND status NOT IN ('cancelled','draft')", [startIso, endIso]),
    one(db, "SELECT status,escalation_level FROM finance_day_closures WHERE closure_date=?", [today]),
    one(db, "SELECT COUNT(*) count FROM employees WHERE employment_status='active'"),
    // the SLA the CRM actually applies, read off a real lead rather than restated as a constant
    one(db, "SELECT (first_action_due_at-assigned_at) first_ms,(manager_alert_at-assigned_at) alert_ms FROM lead_work_items WHERE assigned_at IS NOT NULL AND first_action_due_at IS NOT NULL ORDER BY assigned_at DESC LIMIT 1"),
  ]);

  const openTickets = tickets ? num(tickets.open) : null;
  const escalated = tickets ? num(tickets.escalated) : null;

  // Real work genuinely waiting on a human decision, across the governed maker/checker flows.
  // Approval SLA/throughput ("approved today", "median 18 min", "auto-approved") has no canonical
  // source, so it is reported as unavailable rather than invented.
  const [payrollAwaiting, incentivesAwaiting, termsAwaiting] = await Promise.all([
    one(db, "SELECT COUNT(*) count FROM payroll_runs WHERE status='reviewed'"),
    one(db, "SELECT COUNT(*) count FROM employee_incentive_results WHERE status='calculated'"),
    one(db, "SELECT COUNT(*) count FROM provider_commercial_terms WHERE status='draft'"),
  ]);
  // AI: the assistant workspace was not reachable from this front door at all, so it needs its own
  // counter here. Both reads are cold-safe (one() returns null on a missing table), and the rollout
  // stage is what decides whether the AI is talking to anyone — it is the honest headline.
  const [aiHandoffsWaiting, aiTurnsToday, aiRollout] = await Promise.all([
    one(db, "SELECT COUNT(*) count FROM ai_handoffs WHERE status IN ('queued','staff_active')"),
    one(db, "SELECT COUNT(*) count FROM ai_conversation_turns WHERE created_at>=?", [Date.parse(startIso)]),
    one(db, "SELECT stage FROM ai_audience_rollout WHERE id=1"),
  ]);
  const approvalParts = [payrollAwaiting, incentivesAwaiting, termsAwaiting];
  const pendingApprovals = approvalParts.every((part) => part === null) ? null : approvalParts.reduce((sum, part) => sum + (part ? num(part.count) : 0), 0);

  return {
    actor: { name: input.actorName || input.actorEmail, email: input.actorEmail, roleCode: input.roleCode, permissions: input.permissions ?? [] },
    today,
    commandStrip: {
      revenueActions: opportunities ? num(opportunities.count) : null,
      firstResponseMinutes: slaPolicy ? Math.round(num(slaPolicy.first_ms) / 60_000) : null,
      managerAlertMinutes: slaPolicy ? Math.round(num(slaPolicy.alert_ms) / 60_000) : null,
      openEscalations: escalated,
      openTickets,
      commandPackReports: reports ? num(reports.count) : null,
    },
    workspaces: {
      bookingsToday: bookings ? num(bookings.count) : null,
      ticketsNeedAttention: openTickets,
      dayCloseStatus: closure ? String(closure.status) : null,
      activeEmployees: people ? num(people.count) : null,
      aiHandoffsWaiting: aiHandoffsWaiting ? num(aiHandoffsWaiting.count) : null,
      aiTurnsToday: aiTurnsToday ? num(aiTurnsToday.count) : null,
      aiRolloutStage: aiRollout ? String(aiRollout.stage) : null,
    },
    approvals: {
      pending: pendingApprovals,
      breakdown: {
        payrollRuns: payrollAwaiting ? num(payrollAwaiting.count) : null,
        incentiveResults: incentivesAwaiting ? num(incentivesAwaiting.count) : null,
        commercialTerms: termsAwaiting ? num(termsAwaiting.count) : null,
      },
      slaMeasured: false, // no canonical approval-timing source yet
    },
    truth: { source: "canonical platform tables", fabricatedCounters: false, productionReady: false },
  };
}
