"use client";
import { useEffect, useState } from "react";
type Lot = { remaining: number; expires_at: number | null };
const noLots: Lot[] = [];
/** One timer at the next unused lot expiry; no polling or assumed business duration. */
export function useTestCoinClock(grants: Lot[] = noLots) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [grants]);
  useEffect(() => {
    const clock = Date.now();
    const next = grants.filter(g => g.remaining > 0 && g.expires_at !== null && g.expires_at > clock)
      .reduce((earliest, g) => Math.min(earliest, g.expires_at!), Infinity);
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - clock + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [grants, now]);
  return now;
}
