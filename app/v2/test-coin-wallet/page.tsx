"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "../v2.module.css";
import { useTestCoinClock } from "../use-test-coin-clock";
type Entry = { id: string; serviceCode?: string; source_kind: string; source_id: string; created_at: number; entry_type: string; coins: number };
type Wallet = { customerId: string; policy: { enabled: boolean }; spendableCoins: number; grantBalanceAdjustment: number; reversalDebt: number; expiredCoins: number; expiryPendingCoins: number; expiryConfigurationRequired: boolean; history: Entry[]; nextHistoryCursor: string | null;
  grants: { grant_id: string; source_kind: string; source_id: string; remaining: number; expires_at: number | null }[];
  walletSummary: { lifetimeCoinsEarned: number; lifetimeCoinsRedeemed: number; lifetimeEarningsReversed: number; lifetimeRedemptionsRestored: number; lifetimeNetSimulatedSavings: number; lifetimeActualRupeesSaved: number; pendingEarnedCoins: number } };
async function load(cursor?: string, reconcile = false): Promise<Wallet> {
  const response = await fetch(`/api/v2/test-coins${cursor ? `?historyCursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", credentials: "same-origin",
    ...(reconcile ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync" }) } : {}) });
  const body = await response.json();
  if (!response.ok || !body.data || body.data.policy?.enabled !== true || typeof body.data.customerId !== "string" || !body.data.customerId || !Number.isFinite(body.data.grantBalanceAdjustment)) throw new Error(body.error || "TEST wallet unavailable");
  return body.data;
}
export default function TestCoinWalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(true);
  const inFlight = useRef(true);
  useEffect(() => { let active = true; void load(undefined, true).then(value => { if (active) setWallet(value); }).catch(reason => { if (active) setError(String(reason.message)); }).finally(() => { if (active) { inFlight.current = false; setBusy(false); } }); return () => { active = false; }; }, []);
  const now = useTestCoinClock(wallet?.grants);
  const activePrincipal = wallet?.grants.filter(g => g.expires_at !== null && g.expires_at > now).reduce((sum, g) => sum + g.remaining, 0) || 0;
  const availableCoins = wallet ? Math.max(0, Math.min(wallet.spendableCoins, activePrincipal + wallet.grantBalanceAdjustment)) : 0;
  const reversalDebt = wallet ? Math.max(0, -(activePrincipal + wallet.grantBalanceAdjustment)) : 0;
  const expiredCoins = wallet?.grants.filter(g => g.expires_at !== null && g.expires_at <= now).reduce((sum, g) => sum + g.remaining, 0) || 0;
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { setWallet(await load(undefined, true)); }
    catch (reason) { setWallet(null); setError(reason instanceof Error ? reason.message : "Unable to reconcile TEST wallet"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function more() {
    if (!wallet?.nextHistoryCursor || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { const next = await load(wallet.nextHistoryCursor); if (next.customerId !== wallet.customerId) throw new Error("Your customer session changed. Refresh the TEST wallet before viewing history."); setWallet(previous => previous?.customerId === next.customerId ? { ...next, history: [...previous.history, ...next.history.filter(entry => !previous.history.some(old => old.id === entry.id))] } : next); }
    catch (reason) { setWallet(null); setError(reason instanceof Error ? reason.message : "Unable to load history"); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <main className={styles.page}><div className={styles.shell}><Link href="/v2/account">Account</Link><h1>TEST coin wallet</h1><p>No cash value. TEST coins do not change payments, bills or taxes.</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh TEST wallet"}</button>
    {!wallet && !error && <p role="status">Loading TEST wallet…</p>}
    {wallet && <><section className={styles.card}><h2>Balance and lifetime activity</h2><dl>
      <dt>Available unexpired TEST coins</dt><dd>{availableCoins}</dd><dt>Pending earned TEST coins</dt><dd>{wallet.walletSummary.pendingEarnedCoins}</dd>
      <dt>Older grants awaiting expiry review — unavailable</dt><dd>{wallet.expiryPendingCoins}</dd><dt>Expired unused coins</dt><dd>{expiredCoins}</dd><dt>Refund reversal debt</dt><dd>{reversalDebt}</dd>
      <dt>Lifetime coins earned before reversals</dt><dd>{wallet.walletSummary.lifetimeCoinsEarned}</dd><dt>Lifetime coins redeemed in simulations</dt><dd>{wallet.walletSummary.lifetimeCoinsRedeemed}</dd>
      <dt>Earnings reversed after refunds</dt><dd>{wallet.walletSummary.lifetimeEarningsReversed}</dd><dt>Redemptions restored</dt><dd>{wallet.walletSummary.lifetimeRedemptionsRestored}</dd>
      <dt>Lifetime ACTUAL rupees saved by redemption</dt><dd>₹{wallet.walletSummary.lifetimeActualRupeesSaved}</dd><dt>Net TEST simulated savings</dt><dd>₹{wallet.walletSummary.lifetimeNetSimulatedSavings}</dd></dl>
      <p>Actual savings are zero because TEST redemptions never reduce a real payment. Unpaid or unfinished services are estimates, not pending ledger earnings.</p>
      {wallet.expiryConfigurationRequired && <p role="status">New grants are unavailable until an expiry duration is configured. No expiry duration is assumed.</p>}
    </section><section className={styles.card}><h2>Usage and expiry</h2><p>Use unexpired coins on a subsequent booking, never the booking that earned them. Earliest-expiring grants are used first. Current payable, ownership, refunds, prior redemption and available balance are checked again when applying. TEST savings cannot exceed the amount due.</p><p>Refunds reverse earnings. Cancellation or full refund restores simulated redemption to the original grants; restoration does not renew expiry.</p>
      <Link href="/v2/test-coins">Preview TEST savings on your services</Link><p>Expiry states below are derived from original grants; they are not financial or fabricated ledger debits.</p><ul>{wallet.grants.map(grant => <li key={grant.grant_id}>{grant.source_kind} · {grant.source_id} · {grant.remaining} unused coins · {grant.expires_at === null ? "Expiry snapshot missing; unavailable" : `${grant.expires_at <= now ? "Expired" : "Expires"} ${new Date(grant.expires_at).toLocaleString()}`}</li>)}</ul></section>
    <section className={styles.card}><h2>Ledger history</h2><ul>{wallet.history.map(entry => <li key={entry.id}>{new Date(entry.created_at).toLocaleString()} · {entry.serviceCode || "Service source unavailable"} · {entry.source_kind} · {entry.source_id} · {entry.entry_type.replaceAll("_", " ")} · {entry.coins > 0 ? "+" : ""}{entry.coins} TEST coins</li>)}</ul>{!wallet.history.length && <p>No TEST coin ledger activity.</p>}{wallet.nextHistoryCursor && <button onClick={() => void more()} disabled={busy}>{busy ? "Loading…" : "Load older history"}</button>}</section></>}
  </div></main>;
}
