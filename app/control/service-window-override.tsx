"use client";
import { useCallback, useEffect, useState } from "react";
import { SERVICE_WINDOW_EARLY_MINUTES, SERVICE_WINDOW_LATE_MINUTES, SERVICE_WINDOW_OVERRIDE_MIN_REASON, ist } from "../../lib/grooming-service-window";

/**
 * Ops step for the booked-time window (owner decision QA M1).
 *
 * When the window is enforced, a groomer can mark arrived or start service only from 60 minutes before to
 * 2 hours after the booked start. A tester who books and runs the lifecycle straight away, or a groomer who
 * is early or late for a real reason, needs Operations to authorise it. This is `POST /api/grooming-lifecycle
 * {action:"authorise_service_window"}`, which requires bookings.manage and a reason of 10 characters or more.
 * The authorisation is tied to the booked start: after a reschedule (even one back to the same time) it no
 * longer applies and is shown below as an earlier authorisation, so Operations authorises the booked time again.
 */
type Override = { authorisedBy: string; authorisedAt: number; reason: string; scheduledStart: string | null };
type ServiceWindow = { bookingId: string; status: string; scheduledStart: string; opensAt?: number; closesAt?: number; enforced: boolean; override: Override | null; earlierOverrides: Override[] };
const CLOSED = new Set(["completed", "cancelled", "in_service"]);
const bookedTime = (value: string | null) => { const at = Date.parse(String(value ?? "")); return Number.isFinite(at) ? `${ist(at)} IST` : "a booked time that was not recorded"; };

export default function ServiceWindowOverride({ bookingId }: { bookingId: string }) {
  const [view, setView] = useState<ServiceWindow | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}&view=service_window`, { cache: "no-store" });
      const body = await response.json() as { serviceWindow?: ServiceWindow; error?: string };
      if (!response.ok || !body.serviceWindow) throw new Error(body.error || "Unable to load the booked-time window");
      setView(body.serviceWindow);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to load the booked-time window"); }
    finally { setLoading(false); }
  }, [bookingId]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const trimmed = reason.trim();
  const authorise = async () => {
    if (trimmed.length < SERVICE_WINDOW_OVERRIDE_MIN_REASON) { setError(`Write a reason of at least ${SERVICE_WINDOW_OVERRIDE_MIN_REASON} characters before authorising.`); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/grooming-lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId, action: "authorise_service_window", reason: trimmed }) });
      const body = await response.json() as { error?: string; serviceWindowOverride?: Override };
      if (!response.ok || !body.serviceWindowOverride) throw new Error(body.error || "Unable to authorise the early or late start");
      setNotice(`Early or late start authorised by ${body.serviceWindowOverride.authorisedBy} on ${ist(body.serviceWindowOverride.authorisedAt)} IST for the booked time ${bookedTime(body.serviceWindowOverride.scheduledStart)}.`);
      setReason("");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to authorise the early or late start"); }
    finally { setBusy(false); }
  };

  const closed = view ? CLOSED.has(view.status) : false;
  return <section aria-label="Authorise early or late start" style={{ border: "1px solid var(--staff-line, #d9e2dc)", borderRadius: 14, padding: 14, display: "grid", gap: 10, background: "var(--staff-surface, #fff)" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><div><span style={{ fontSize: 14, letterSpacing: ".08em", textTransform: "uppercase", opacity: .7 }}>Booked-time window</span><h4 style={{ margin: 0 }}>Authorise early/late start</h4></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button></header>
    {error && <p role="alert" style={{ color: "var(--staff-muted, #b3261e)", margin: 0 }}>{error}</p>}
    {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    {view && <>
      <p style={{ margin: 0 }}>Booked for {bookedTime(view.scheduledStart)}. The groomer can mark arrived or start service from {view.opensAt ? `${ist(view.opensAt)} IST` : "—"} to {view.closesAt ? `${ist(view.closesAt)} IST` : "—"} ({SERVICE_WINDOW_EARLY_MINUTES} minutes before to {SERVICE_WINDOW_LATE_MINUTES / 60} hours after the booked time).</p>
      <small style={{ opacity: .8 }}>{view.enforced ? "The window is switched on here: outside it, arrive and start are refused unless you authorise them below." : "The window is not switched on in this environment, so the groomer is not blocked. An authorisation is still recorded."}</small>
      {view.override
        ? <article style={{ display: "grid", gap: 4, padding: 10, borderRadius: 10, background: "#eef8f2" }}><strong>Early/late start authorised</strong><small>By {view.override.authorisedBy} on {ist(view.override.authorisedAt)} IST, for the booked time {bookedTime(view.override.scheduledStart)} · &quot;{view.override.reason}&quot;</small></article>
        : <p style={{ margin: 0, opacity: .75 }}>No early or late start is authorised for this booked time.</p>}
      {view.earlierOverrides.map(item => <small key={`${item.authorisedAt}-${item.authorisedBy}`} style={{ opacity: .7 }}>No longer applies ({item.scheduledStart ? "the booking was rescheduled after it" : "it was recorded without a booked time"}): authorised by {item.authorisedBy} on {ist(item.authorisedAt)} IST for {bookedTime(item.scheduledStart)} · &quot;{item.reason}&quot;</small>)}
      {closed
        ? <small style={{ opacity: .7 }}>This job is {view.status.replaceAll("_", " ")}, so there is no arrival or start left to authorise.</small>
        : <div style={{ display: "grid", gap: 6 }}>
          <input aria-label="Reason for the early or late start" placeholder={`Why the groomer may arrive or start outside the window (at least ${SERVICE_WINDOW_OVERRIDE_MIN_REASON} characters)`} value={reason} onChange={event => setReason(event.target.value)} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" disabled={busy || trimmed.length < SERVICE_WINDOW_OVERRIDE_MIN_REASON} onClick={() => void authorise()}>{busy ? "Authorising…" : "Authorise early/late start"}</button>
            <small style={{ opacity: .7 }}>{trimmed.length}/{SERVICE_WINDOW_OVERRIDE_MIN_REASON} characters. Applies to this booked time only; a reschedule needs a new authorisation.</small>
          </div>
        </div>}
    </>}
  </section>;
}
