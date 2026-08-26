"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The staff PII reveal control. [PTJA-W3-RU]
 *
 * Every staff list on this platform now serves masked contact data. That is the right default and it is
 * also unusable on its own: somebody looking at "+91 ••••••3210" while a customer is on the phone has
 * no way to do their job, and the predictable outcome of an unusable control is a spreadsheet kept
 * outside the platform where nothing is audited at all. This is the sanctioned way to see the value.
 *
 * WHAT IT ENFORCES, all of it server-backed rather than cosmetic:
 *   - It only offers itself where the masked read said `revealAvailable`. A button that is always shown
 *     and always fails teaches people to ignore refusals.
 *   - A reason is typed BEFORE the request is sent. The API refuses a reveal without one, so a
 *     disabled button is not the control - it is the courtesy of not making somebody click twice.
 *   - The value on screen is the one the API returned, never a field read off the list row. A screen
 *     that already had the raw value would make the whole exercise theatre.
 *   - It remasks itself at the server's `revealExpiresAt`, not at a duration the screen invents, and
 *     clears the timer on unmount so a stale reveal cannot resurface on a re-render.
 */
export type RevealField = "phone" | "email" | "address";

type RevealedView = {
  contact: { phone: string | null; email: string | null };
  address: { line1: string | null; area: string | null; city: string | null; pincode: string | null };
  revealExpiresAt: number | null;
  revealedFields?: RevealField[];
};

export default function CustomerReveal({
  customerId, purpose = "operations", fields, revealAvailable, label = "Reveal contact",
}: {
  customerId: string;
  purpose?: string;
  fields?: RevealField[];
  revealAvailable: boolean;
  label?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<RevealedView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remask = useCallback(() => {
    setView(null);
    setReason("");
    setAsking(false);
  }, []);

  // The server decides how long a reveal lasts. Clearing on unmount matters: without it a component
  // that unmounts mid-reveal leaves a timer holding a closure over the revealed value.
  useEffect(() => {
    if (!view?.revealExpiresAt) return undefined;
    const remaining = view.revealExpiresAt - Date.now();
    if (remaining <= 0) { remask(); return undefined; }
    timer.current = setTimeout(remask, remaining);
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [view, remask]);

  if (!revealAvailable) {
    return <span title="Your role and this record's assignment do not permit a reveal">Masked</span>;
  }

  if (view) {
    const seconds = Math.max(0, Math.round(((view.revealExpiresAt ?? 0) - Date.now()) / 1000));
    return (
      <span>
        <strong>{view.contact.phone ?? view.contact.email ?? [view.address.line1, view.address.area, view.address.pincode].filter(Boolean).join(", ")}</strong>
        <small> · remasks in {seconds}s</small>
        <button type="button" onClick={remask}>Hide now</button>
      </span>
    );
  }

  if (!asking) {
    return <button type="button" onClick={() => setAsking(true)}>{label}</button>;
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/customer-data-reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, purpose, reason, fields }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) { setError(String(body?.error ?? "This reveal was refused")); return; }
      setView(body?.data ?? null);
    } catch {
      setError("The reveal could not be requested");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why do you need this? (recorded)"
        aria-label="Reason for revealing customer contact data"
      />
      <button type="button" disabled={busy || reason.trim().length < 5} onClick={submit}>
        {busy ? "Requesting…" : "Confirm reveal"}
      </button>
      <button type="button" onClick={() => { setAsking(false); setReason(""); }}>Cancel</button>
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
