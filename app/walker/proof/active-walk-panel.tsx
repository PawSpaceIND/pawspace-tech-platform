"use client";

import { useEffect, useState } from "react";
import ActiveWalkMap from "../../../components/partner/active-walk-map";
import { loadWalkingLifecycle } from "../../../lib/walking-lifecycle-client";
import { loadWalkingProof } from "../../../lib/walking-proof-client";
import { resolveActiveWalkContext } from "../../../lib/mobile/walk-context";

type Context = ReturnType<typeof resolveActiveWalkContext>;
export default function ActiveWalkPanel({ bookingId, sessionId }: { bookingId: string; sessionId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; context?: Context; error?: string }>();
  const key = `${bookingId}:${sessionId}:${attempt}`;
  useEffect(() => {
    let active = true;
    void Promise.all([loadWalkingLifecycle({ bookingId }), loadWalkingProof({ bookingId })]).then(([bookings, proof]) => {
      const context = resolveActiveWalkContext(bookingId, sessionId, bookings, proof);
      if (active) setState({ key, context });
    }).catch(() => {
      if (active) setState({ key, error: "We couldn't open an active walk for this booking. Sign in as its assigned partner, start the walk from your job list, then try again." });
    });
    return () => { active = false; };
  }, [bookingId, sessionId, key]);

  if (state?.key !== key) return <p role="status">Checking your walk before opening location controls…</p>;
  if (!state.context) return <section><p role="alert">{state.error}</p><button onClick={() => setAttempt(value => value + 1)}>Check active walk again</button></section>;
  return <section aria-label="Internal test live walking route">
    <p>Internal testing only. Device coordinates and sample points are stored as sandbox evidence, not production-verified GPS.</p>
    <ActiveWalkMap key={key} {...state.context} />
  </section>;
}
