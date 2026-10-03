"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { TestCoinPolicy } from "../../lib/v2/test-coin-policy";
import type { TestCoinEstimateInput } from "../../lib/v2/test-coin-estimate";
import TestCoinBookingPreview from "./test-coin-booking-preview";
type Wallet = { customerId: string; policy: TestCoinPolicy; spendableCoins: number; grantBalanceAdjustment: number; grants: TestCoinEstimateInput["grants"] };
/** Reads owner-scoped TEST state; explicit refresh reconciles TEST sources without reserving coins. */
export default function TestCoinServicePreview({ serviceName, eligibleAmount, actualPayable, customerId, source, bookingId, blocked = false }: {
  serviceName: string; eligibleAmount: number | null; actualPayable: number | null; customerId?: string; source?: string; bookingId?: string; blocked?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ customerId: string; wallet: Wallet } | null>(null), [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState<{ customerId: string; attempt: number } | null>(null);
  useEffect(() => {
    if (!customerId) return;
    const controller = new AbortController();
    const reconcile = refresh?.customerId === customerId;
    void fetch("/api/v2/test-coins", { credentials: "same-origin", cache: "no-store", signal: controller.signal,
      ...(reconcile ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync" }) } : {}) }).then(async response => {
      if (!response.ok) throw new Error("TEST wallet unavailable");
      const body = await response.json();
      if (body.data?.policy?.enabled !== true || body.data.customerId !== customerId || !Number.isFinite(body.data.grantBalanceAdjustment)) throw new Error("TEST policy or owner unavailable");
      if (!controller.signal.aborted) { setLoaded({ customerId, wallet: body.data }); setUnavailable(false); }
    }).catch(() => { if (!controller.signal.aborted) { setLoaded(null); setUnavailable(true); } });
    return () => controller.abort();
  }, [customerId, refresh]);
  const wallet = loaded && loaded.customerId === customerId ? loaded.wallet : null;
  return <div style={{ marginBlock: 16, minWidth: 0 }}>
    {wallet ? <TestCoinBookingPreview serviceName={serviceName} quote={{ policy: wallet.policy, spendableCoins: wallet.spendableCoins, grantBalanceAdjustment: wallet.grantBalanceAdjustment, grants: wallet.grants, eligibleAmount, actualPayable, currency: "INR", source, bookingId, blocked }}/>
      : <section aria-label={`${serviceName} TEST rewards`}><h2>TEST coin preview</h2><p>{!customerId ? "Sign in to check TEST coin availability." : unavailable ? "TEST rewards are unavailable here. No earnings or discount have been applied." : "Checking TEST reward availability…"}</p><p>TEST coins have no cash value. Your booking price and payment are unchanged.</p></section>}
    <Link href="/v2/test-coin-wallet">View TEST wallet, history and expiry</Link>
    <p>Balances reflect the last TEST reconciliation. Refresh to check completed services and refunds.</p>
    <button type="button" disabled={!customerId} onClick={() => { if (!customerId) return; setLoaded(null); setUnavailable(false); setRefresh(previous => ({ customerId, attempt: (previous?.attempt || 0) + 1 })); }}>Refresh TEST balance</button>
  </div>;
}
