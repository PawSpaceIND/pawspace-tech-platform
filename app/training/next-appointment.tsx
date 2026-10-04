"use client";
import { useEffect, useState } from "react";
import { type TrainerAssignmentView } from "../../lib/training-assignment-view";
import { createRollingBooking, frozenRollingClient, rollingScheduleGate, toMs, type RollingBooking, type RollingClient, type RollingSlot, type RollingState } from "../../lib/training-rolling-booking";

const istRange = (slot: RollingSlot) => {
  const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const end = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  const start = toMs(slot.start), finish = toMs(slot.end);
  return start != null && finish != null ? `${fmt.format(start)} – ${end.format(finish)} IST` : `${slot.start} – ${slot.end}`;
};
const istClock = (ms: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(ms);

/**
 * Books the next appointment of a rolling programme from the server's offered slots: hold, then confirm, then the
 * authoritative summary is reloaded. Shown only with an assigned trainer; disabled whenever the summary says the
 * customer may not schedule. Nothing is called booked unless the server confirmed it.
 */
export default function NextAppointment({ bookingId, assignment, trainerName, client }: { bookingId: string; assignment: TrainerAssignmentView; trainerName?: string | null; client?: RollingClient }) {
  const [state, setState] = useState<RollingState | null>(null);
  // One machine per mounted control (callers key the control by bookingId); its state changes arrive through onChange.
  const [machine] = useState<RollingBooking>(() => createRollingBooking({ bookingId, client: client ?? frozenRollingClient(), onChange: (next) => setState(next) }));
  const [now, setNow] = useState(() => Date.now());
  const assigned = assignment.state === "assigned";
  useEffect(() => {
    if (!assigned) return;
    const controller = new AbortController();
    void machine.load(controller.signal);
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [assigned, machine]);
  if (!assigned) {
    return <section aria-label="Next appointment"><h3>Next appointment</h3><p>{assignment.label}. You can book your next appointment once your trainer is assigned; nothing is booked until then.</p></section>;
  }
  const current = state;
  const gate = rollingScheduleGate({ assignmentState: assignment.state, summary: current?.summary ?? null });
  const busy = current?.phase === "holding" || current?.phase === "confirming";
  const expired = current?.hold?.expiresAt != null && current.hold.expiresAt <= now;
  const validUntil = toMs(current?.summary?.validUntil);
  return <section aria-label="Next appointment">
    <h3>Book your next appointment with {trainerName ?? "your certified trainer"}</h3>
    {current?.summary && <p>{current.summary.remainingUnallocatedSessions ?? current.summary.remainingSessions} of your sessions still to schedule{validUntil != null ? ` · valid until ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(validUntil)}` : ""} · up to {current.summary.maxUpcomingSessions} upcoming at a time.</p>}
    {current?.summary && current.summary.upcomingSessions.length > 0 && <ul aria-label="Upcoming sessions">{current.summary.upcomingSessions.map((session, index) => <li key={session.id ?? session.sessionId ?? index}>{istRange({ start: session.start ?? session.scheduled_start ?? "", end: session.end ?? session.scheduled_end ?? "" })}{session.status ? ` · ${session.status.replaceAll("_", " ")}` : ""}</li>)}</ul>}
    {!gate.ok && <p role="status">{gate.reason}</p>}
    {gate.ok && current && !current.hold && current.phase !== "confirmed" && <>
      <p>Choose one of the slots your trainer offered, hold it, then confirm.</p>
      <div role="radiogroup" aria-label="Offered slots">{current.summary!.availableSlots.map((slot) => {
        const selected = current.slot?.start === slot.start && current.slot?.end === slot.end;
        return <label key={`${slot.start}|${slot.end}`}><input type="radio" name={`slot-${bookingId}`} checked={selected} disabled={busy} onChange={() => machine.select(slot)} /> {istRange(slot)}</label>;
      })}</div>
      <button type="button" disabled={busy || !current.slot} onClick={() => void machine.hold()}>{current.phase === "holding" ? "Holding…" : "Hold this slot"}</button>
    </>}
    {current?.hold && <>
      <p role="status">Held: {istRange(current.hold.slot)}{current.hold.expiresAt != null ? ` · hold ends ${istClock(current.hold.expiresAt)} IST` : ""}. Not booked until you confirm.</p>
      {expired ? <p role="alert">This hold has expired. Check your programme schedule before choosing another slot.</p> : <button type="button" disabled={busy} onClick={() => void machine.confirm()}>{current.phase === "confirming" ? "Confirming…" : "Confirm this appointment"}</button>}
      <button type="button" disabled={busy} onClick={() => machine.reset()}>Choose a different slot</button>
    </>}
    {current?.phase === "confirmed" && <p role="status">{current.message}{current.confirmedSessionIds.length ? ` Session reference${current.confirmedSessionIds.length === 1 ? "" : "s"}: ${current.confirmedSessionIds.join(", ")}.` : ""} Your programme schedule above is refreshed from PawSpace.</p>}
    {current?.phase === "confirmed" && <button type="button" onClick={() => machine.reset()}>Book another appointment</button>}
    {current?.error && <p role="alert">{current.error}</p>}
  </section>;
}
