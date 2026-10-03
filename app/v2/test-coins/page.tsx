"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "../v2.module.css";
type Service = { source: string; id: string; serviceCode: string; status: string };
type History = { source_kind: string; source_id: string; entry_type: string; coins: number; created_at: number };
type Account = { balance: number; spendableCoins: number; reversalDebt: number; history: History[]; services?: Service[]; expiredCoins: number; expiryPendingCoins: number; expiryConfigurationRequired: boolean; grants: { grant_id: string; source_id: string; remaining: number; expires_at: number | null; eligible_amount: number; earn_percent: number }[]; policy: { earnPercent: number; expirySeconds: number | null; previewRupeesPerCoin: number } };
type Preview = { bookingTotal: number; currency: string; actualPayable: number; simulatedDiscount: number; simulatedPayable: number; testCoinsRedeemed: number; completed: boolean; refunded: boolean; status: string };
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const payload = await response.json() as { data?: T; error?: string };
  if (!response.ok || !payload.data) throw new Error(payload.error || "TEST coins are unavailable. Sign in and check that the test environment is enabled.");
  return payload.data;
}
export default function TestCoinsPage() {
  const [account, setAccount] = useState<Account | null>(null), [services, setServices] = useState<Service[]>([]);
  const [selected, setSelected] = useState(""), [coins, setCoins] = useState(""), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function refresh() {
    setBusy(true); setError("");
    try { const data = await request<Account>("/api/v2/test-coins", { action: "sync" }); setAccount(data); setServices(data.services || []); setPreview(null); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to refresh TEST coins"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    void request<Account>("/api/v2/test-coins", { action: "sync" }).then(data => {
      if (active) { setAccount(data); setServices(data.services || []); }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load TEST coins"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (!selected) return;
    const service = services.find(s => `${s.source}:${s.id}` === selected);
    if (service) void request<Preview>(`/api/v2/test-coins?source=${encodeURIComponent(service.source)}&id=${encodeURIComponent(service.id)}`).then(p => { if (active) setPreview(p); }).catch(e => { if (active) setError(e instanceof Error ? e.message : "Unable to load booking totals"); });
    return () => { active = false; };
  }, [selected, services]);
  async function redeem() {
    const service = services.find(s => `${s.source}:${s.id}` === selected);
    if (!service || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const data = await request<Account & { preview: Preview }>("/api/v2/test-coins", { action: "redeem", source: service.source, id: service.id, coins: Number(coins) });
      setAccount(data); setPreview(data.preview); setMessage("TEST coins applied to the simulation. Your payment amount is unchanged.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to redeem TEST coins"); }
    finally { setBusy(false); }
  }
  const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: preview?.currency || "INR" }).format(value);
  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.topbar}><Link href="/v2/account" className={styles.back}>← Account</Link><Link href="/v2/activity" className={styles.back}>Your services</Link><Link href="/v2/test-coin-wallet" className={styles.back}>TEST wallet and history</Link></header>
    <section className={styles.hero}><span className={styles.eyebrow}>TEST COINS · NO CASH VALUE</span><h1>Try your PawSpace rewards.</h1><p>Earn demonstration coins after a paid service is complete, and try savings on another booking. TEST coins do not pay for services or change your bills, taxes or refunds.</p></section>
    {error && <p className={styles.notice} role="alert">{error}</p>}{message && <p className={styles.notice} role="status">{message}</p>}
    <section className={styles.card}><h2>{account ? `${account.balance} TEST coins` : "Your TEST balance"}</h2>
      {account && <><p>{account.spendableCoins} unexpired coins available for subsequent bookings.</p>{account.expiryConfigurationRequired && <p role="status">New TEST grants need an expiry duration to be configured. No expiry duration has been assumed.</p>}{account.expiredCoins > 0 && <p>{account.expiredCoins} unused TEST coins have expired.</p>}{account.expiryPendingCoins > 0 && <p>{account.expiryPendingCoins} older TEST coins have no expiry snapshot and are unavailable until reviewed.</p>}<p>Demonstration settings: {account.policy.earnPercent}% of the eligible paid order value in whole TEST coins; ₹{account.policy.previewRupeesPerCoin} simulated savings per coin. The earning percentage is adjustable. This is a TEST program; the simulated conversion is unchanged and is not a real cash value.</p>{account.reversalDebt > 0 && <p>Refund reversals removed {account.reversalDebt} coins already used in a simulation. Future TEST earnings cover this before more redemption.</p>}</>}
      <button className={styles.back} onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing…" : "Refresh TEST rewards"}</button>
    </section>
    {account && <section className={styles.card} style={{ marginTop: 16 }}><h2>Try savings on a booking</h2><div className={styles.form}>
      <label className={styles.field}>Your service booking<select value={selected} onChange={e => { setSelected(e.target.value); setPreview(null); setMessage(""); }} disabled={busy}><option value="">Choose a booking</option>{services.map(s => <option key={`${s.source}:${s.id}`} value={`${s.source}:${s.id}`}>{s.serviceCode.replaceAll("_", " ")} · {s.id} · {s.status}</option>)}</select></label>
      {preview && <><dl><dt>Booking total</dt><dd>{money(preview.bookingTotal)}</dd><dt>Actual amount due now</dt><dd>{money(preview.actualPayable)}</dd><dt>TEST simulated discount</dt><dd>{money(preview.simulatedDiscount)}</dd><dt>TEST simulated payable</dt><dd>{money(preview.simulatedPayable)}</dd></dl><p>Your actual payment remains {money(preview.actualPayable)}. Only the TEST simulation changes.</p></>}
      <label className={styles.field}>TEST coins to use<input type="number" min="1" step="1" max={account.spendableCoins} value={coins} onChange={e => setCoins(e.target.value)} disabled={busy}/></label>
      <button className={styles.primary} onClick={() => void redeem()} disabled={busy || !preview || preview.refunded || ["cancelled", "canceled", "closed"].includes(preview.status) || preview.actualPayable <= 0 || preview.testCoinsRedeemed > 0 || !Number.isSafeInteger(Number(coins)) || Number(coins) <= 0 || Number(coins) > account.spendableCoins}>Apply TEST coins to simulation</button>
    </div></section>}
    {account && <section className={styles.card} style={{ marginTop: 16 }}><h2>TEST coin grants and history</h2>{account.grants.length > 0 && <ul>{account.grants.map(g => <li key={g.grant_id}>{g.source_id}: {g.remaining} coins remaining · {g.expires_at === null ? "Expiry configuration required" : `Expires ${new Date(g.expires_at).toLocaleString()}`}</li>)}</ul>}<p>Refunded services reverse TEST earnings. Cancelled or fully refunded bookings restore simulated redemptions.</p>{account.history.length ? <ul>{account.history.map((h, i) => <li key={`${h.source_kind}:${h.source_id}:${h.entry_type}:${i}`}>{h.entry_type.replaceAll("_", " ")}: {h.coins > 0 ? "+" : ""}{h.coins} TEST coins · {h.source_id}</li>)}</ul> : <p>No TEST coin activity yet.</p>}</section>}
  </div></main>;
}
