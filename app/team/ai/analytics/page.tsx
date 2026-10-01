"use client";
import { useEffect, useState } from "react";
import { MetricBars, TargetProgress, VisualGrid } from "../../../components/ui/ReportVisuals";
import { StatCard, TeamAlert, TeamSection, TeamShell, TeamStatGrid, TeamTable } from "../../../components/ui";

/**
 * AI analytics.
 *
 * This page used to render its header and nothing else: every card lived inside `{data && ...}`, so
 * before the fetch resolved — and permanently if it failed or the caller lacked reports.view — the
 * screen was a title on an empty background with no loading state, no error surface and no way to
 * navigate anywhere. It also threw away most of what /api/ai-analytics returns (the channel, intent,
 * handoff-reason, policy, delivery and voice breakdowns) and exposed none of the filters the API
 * already supports. All of that is now on screen, on the shared Team shell.
 */

type Breakdown = { count: number };
type Data = {
  volume: { turns: number; threads: number; byChannel: Array<Breakdown & { channel: string }>; byIntent: Array<Breakdown & { intent: string; handoffs: number }> };
  containment: { rate: number | null; handoffTurns: number; nonHandoffTurns: number };
  handoff: { byReason: Array<Breakdown & { reason: string; avgTakeoverMs: number | null }> };
  policy: { byDecision: Array<Breakdown & { decision: string }> };
  performance: { avgLatencyMs: number | null; latencySamples?: number; inputTokens: number; outputTokens: number; costMinor: number };
  delivery: { byStatus: Array<Breakdown & { status: string }> };
  voice: { byOutcome: Array<Breakdown & { status: string; outcome: string; liveAgentTransfers: number; reconnects: number }> };
  conversion: { canonicalBookingLinkedThreads: number };
  bookingOutcomes?: {status: "available" | "unavailable";reason: string | null;scope: string | null;counts: Record<string, number | null>};
  csat: { responses: number; averageRating: number | null };
  definitions: Record<string, string>;
};

const DASH = "—";
const CHANNELS = [["", "All channels"], ["whatsapp", "WhatsApp"], ["chat", "Chat"], ["voice", "Voice"]] as const;
const pretty = (value: string) => value.replaceAll("_", " ");
const field = { padding: 9, borderRadius: "calc(8px * var(--paw-radius-scale))", border: "1px solid var(--paw-raised)", background: "var(--paw-surface)" } as const;
const NAV = [
  { href: "/team/ai", label: "AI home" },
  { href: "/team/ai/handoff", label: "Handoff queue" },
  { href: "/team/ai/configuration", label: "Configuration" },
  { href: "/team", label: "Team home", primary: true },
];

export default function AiAnalyticsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [channel, setChannel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // `loading` is DERIVED from "which filter has been loaded" rather than set at the top of the
  // effect. Calling setState synchronously inside an effect triggers cascading renders (and the
  // React compiler rejects it), but the screen still has to show a spinner the moment a filter
  // changes — comparing the requested key with the loaded key gives both.
  const filterKey = `${channel}|${from}|${to}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== filterKey;

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams();
    if (channel) query.set("channel", channel);
    if (from) query.set("from", String(Date.parse(`${from}T00:00:00`)));
    if (to) query.set("to", String(Date.parse(`${to}T23:59:59`)));
    const search = query.toString();
    void fetch(`/api/ai-analytics${search ? `?${search}` : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: Data; error?: string };
        if (!response.ok) throw new Error(body.error || `AI analytics failed to load (HTTP ${response.status}) — the API errored; this is not a permission problem.`);
        if (!live) return;
        setData(body.data ?? null);
        setError("");
      })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load AI analytics"); })
      .finally(() => { if (live) setLoadedKey(filterKey); });
    return () => { live = false; };
  }, [channel, from, to, filterKey]);

  const containment = data?.containment.rate == null ? DASH : `${Math.round(data.containment.rate * 100)}%`;
  const latency = data?.performance.avgLatencyMs == null ? DASH : `${Math.round(data.performance.avgLatencyMs)} ms`;
  const csat = data?.csat.averageRating == null ? DASH : `${data.csat.averageRating}/5`;
  const busy = loading || Boolean(error);

  return (
    <TeamShell
      eyebrow="PAWSPACE TEAM · AI ANALYTICS"
      title="How the assistant is actually performing"
      description="Source-derived operational analytics only: figures come from canonical turns and operational records. Unsupported attribution, inferred CSAT and fabricated business KPIs are deliberately omitted — the cards that say so mean it."
      nav={NAV}
      status={error ? <TeamAlert>{error}</TeamAlert> : undefined}
    >
      <TeamSection title="Filter" note="Filters apply to AI turns, latency, tokens, policy and booking-linked threads. CSAT, handoff reasons, voice calls and delivery below remain all-time across all channels.">
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--paw-link)" }}>Channel
            <select value={channel} onChange={(event) => setChannel(event.target.value)} style={{ ...field, minWidth: 160 }}>
              {CHANNELS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--paw-link)" }}>From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={field} />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--paw-link)" }}>To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} style={field} />
          </label>
          <button onClick={() => { setChannel(""); setFrom(""); setTo(""); }} style={{ ...field, cursor: "pointer", fontWeight: 700 }}>Clear</button>
          {loading && <span style={{ color: "var(--paw-link)", fontSize: 13 }}>Loading…</span>}
        </div>
      </TeamSection>

      <TeamStatGrid>
        <StatCard label="AI turns" value={busy ? "…" : data?.volume.turns ?? DASH} meta="canonical governed turns" />
        <StatCard label="Canonical threads" value={busy ? "…" : data?.volume.threads ?? DASH} meta="conversations touched" />
        <StatCard label="Containment" value={busy ? "…" : containment} meta="turns not escalated — not a resolution claim" />
        <StatCard label="Human handoff turns" value={busy ? "…" : data?.containment.handoffTurns ?? DASH} meta="governed escalations only" />
        <StatCard label="Avg latency" value={busy ? "…" : latency} meta={`${data?.performance.latencySamples ?? "—"} timed turns · internal processing, not first audio`} />
        <StatCard label="Explicit CSAT" value={busy ? "…" : csat} meta={data ? `${data.csat.responses} submitted rating${data.csat.responses === 1 ? "" : "s"} · all-time, all channels` : "all-time, all channels"} />
        <StatCard label="Tokens used" value={busy ? "…" : data ? data.performance.inputTokens + data.performance.outputTokens : DASH} meta={data ? `in ${data.performance.inputTokens} · out ${data.performance.outputTokens}` : undefined} />
        <StatCard label="Provider cost" value={busy ? "…" : data ? `₹${(data.performance.costMinor / 100).toFixed(2)}` : DASH} meta="only when the provider records it" />
        <StatCard label="Booking-linked threads" value={busy ? "…" : data?.conversion.canonicalBookingLinkedThreads ?? DASH} meta="linkage only, no causal claim" />
        <StatCard label="Attributed conversion" value="Not claimed" meta="needs explicit attribution" />
        <StatCard label="First response" value="Not attributable yet" meta="needs canonical response timing" />
        <StatCard label="Resolution time" value="Not attributable yet" meta="needs canonical thread resolution" />
      </TeamStatGrid>

      {!data && !error && !loading && <TeamAlert tone="info">No AI analytics were returned for this filter.</TeamAlert>}

      {data && !busy && <>
        <p>{loading ? "Updating report…" : `Loaded period: ${from || "All recorded history"} – ${to || "present"} · ${channel || "all channels"}`}</p>
        {!loading && !error && <VisualGrid>
          <TargetProgress title="AI containment" percent={data.containment.rate == null ? null : data.containment.rate * 100} note="Share of turns without human handoff; this does not measure resolution." />
          <MetricBars title="Conversation channels" items={data.volume.byChannel.map(row => ({ label: pretty(row.channel), value: row.count }))} />
          <MetricBars title="Intent volume" items={data.volume.byIntent.map(row => ({ label: pretty(row.intent), value: row.count }))} />
          <MetricBars title="Handoff reasons" note="All-time, all channels; independent of the filters above." items={data.handoff.byReason.map(row => ({ label: pretty(row.reason), value: row.count, tone: "gold" }))} />
          <MetricBars title="Policy decisions" items={data.policy.byDecision.map(row => ({ label: pretty(row.decision), value: row.count }))} />
          <MetricBars title="Message delivery events" note="All-time, all channels; independent of the filters above. Event counts may overlap for the same message." items={data.delivery.byStatus.map(row => ({ label: pretty(row.status), value: row.count }))} />
        </VisualGrid>}

        <TeamSection title="AI-linked booking outcomes" note="Distinct canonical bookings linked to the selected AI-turn cohort. Current lifecycle/payment evidence, including outcomes after the turn window; observational linkage, not AI-attributed sales or resolution. Financial permission and organizational scope required.">
          {data.bookingOutcomes?.status === "available" ? <>
            <p>Scope: {data.bookingOutcomes.scope}. Collections include partial payments and historical collections before refunds; they do not mean fully paid or net revenue. Cancelled collections may represent refund liabilities. Missing booking links are excluded; missing payment records are shown separately.</p>
            <TeamTable head={["Outcome", "Distinct bookings"]} rows={[
              ["Linked canonical bookings", data.bookingOutcomes.counts.linkedBookings ?? DASH],
              ["With recorded collections", data.bookingOutcomes.counts.bookingsWithCollections ?? DASH],
              ["Completed", data.bookingOutcomes.counts.completedBookings ?? DASH],
              ["Completed with collections", data.bookingOutcomes.counts.completedWithCollections ?? DASH],
              ["Collections below current booking total", data.bookingOutcomes.counts.collectionsBelowBookingTotal ?? DASH],
              ["With refund evidence", data.bookingOutcomes.counts.bookingsWithRefundEvidence ?? DASH],
              ["Cancelled with collections", data.bookingOutcomes.counts.cancelledWithCollections ?? DASH],
              ["Without a payment record", data.bookingOutcomes.counts.bookingsWithoutPaymentRecord ?? DASH],
            ]} />
          </> : <TeamAlert tone="info">{data.bookingOutcomes?.reason === "source_unavailable" ? "Booking outcomes unavailable: a required source could not be read. Unknown outcomes are not zero." : "Booking outcomes unavailable: financial permission and a provisioned organizational scope are required."}</TeamAlert>}
        </TeamSection>

        <TeamSection title="By channel"><TeamTable head={["Channel", "Turns"]} rows={data.volume.byChannel.map((row) => [pretty(row.channel), row.count])} empty="No turns on any channel in this window." /></TeamSection>
        <TeamSection title="By intent" note="Intent is a deterministic keyword heuristic, not a model probability."><TeamTable head={["Intent", "Turns", "Handed off"]} rows={data.volume.byIntent.map((row) => [pretty(row.intent), row.count, row.handoffs])} /></TeamSection>
        <TeamSection title="Why the assistant handed over" note="All-time, all channels; independent of the filters above."><TeamTable head={["Reason", "Count", "Avg time to staff takeover"]} rows={data.handoff.byReason.map((row) => [pretty(row.reason), row.count, row.avgTakeoverMs == null ? "not taken over yet" : `${Math.round(row.avgTakeoverMs / 1000)}s`])} empty="No conversation has been escalated to a human." /></TeamSection>
        <TeamSection title="Policy decisions" note="What the governance layer allowed on each turn."><TeamTable head={["Decision", "Turns"]} rows={data.policy.byDecision.map((row) => [pretty(row.decision), row.count])} /></TeamSection>
        <TeamSection title="Voice calls" note="All-time, all channels; independent of the filters above."><TeamTable head={["Status", "Outcome", "Calls", "Live-agent transfers", "Reconnects"]} rows={data.voice.byOutcome.map((row) => [pretty(row.status), pretty(row.outcome), row.count, row.liveAgentTransfers, row.reconnects])} empty="No voice calls recorded." /></TeamSection>
        <TeamSection title="Message delivery" note="All-time, all channels; independent of the filters above."><TeamTable head={["Event", "Count"]} rows={data.delivery.byStatus.map((row) => [pretty(row.status), row.count])} empty="No delivery events recorded — outbound delivery is queued, not live." /></TeamSection>
        <TeamSection title="What each figure means" note="Written down so nobody has to guess what a number is claiming.">
          <TeamTable head={["Figure", "Definition"]} rows={Object.entries(data.definitions).map(([key, text]) => [pretty(key), text])} />
        </TeamSection>
      </>}
    </TeamShell>
  );
}
