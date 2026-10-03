"use client";
import { useState } from "react";
import { testCoinEstimate, type TestCoinEstimateInput } from "../../lib/v2/test-coin-estimate";
import { useTestCoinClock } from "./use-test-coin-clock";

/** Mount beside each service's governed quote, before the booking submit action. */
export default function TestCoinBookingPreview({ serviceName, quote }: { serviceName: string; quote: Omit<TestCoinEstimateInput, "requestedCoins"> }) {
  const [requested, setRequested] = useState(0);
  const now = useTestCoinClock(quote.grants);
  const preview = testCoinEstimate({ ...quote, requestedCoins: requested }, now);
  if (!preview.enabled) return <section aria-label={`${serviceName} TEST rewards`}><h2>TEST rewards unavailable</h2><p>TEST coins are disabled here. Your booking price and payment are unchanged.</p></section>;
  const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value);
  return <section aria-label={`${serviceName} TEST rewards`}>
    <h2>{serviceName} · TEST coins, no cash value</h2>
    <p>{preview.estimatedCoins === null ? "Estimated earnings will appear when the eligible INR quote is confirmed." : `Estimated earnings: ${preview.estimatedCoins} whole TEST coins (${quote.policy.earnPercent}% of eligible order value).`}</p>
    <p>Earn only after the service is completed and paid. Quote changes can change this estimate.</p>
    {!preview.earningConfigured ? <p role="status">New earnings are unavailable until an expiry duration is configured. No expiry duration has been assumed.</p> : <p>New grants expire {preview.expirySeconds} seconds after earning; each grant keeps its own expiry.</p>}
    <p>{preview.availableCoins} unexpired TEST coins available for this subsequent booking. Coins earned on this booking cannot be reused on it. Earliest-expiring coins are used first.</p>
    {preview.nextExpiry !== null && <p>Next grant expiry: <time dateTime={new Date(preview.nextExpiry).toISOString()}>{new Date(preview.nextExpiry).toLocaleString()}</time>.</p>}
    <label>TEST coins to preview <input type="number" min="0" step="1" max={preview.maximumCoins} value={requested} onChange={event => setRequested(Number(event.target.value))} disabled={preview.maximumCoins === 0}/></label>
    {!preview.requestEligible && <p role="alert">Choose whole coins up to {preview.maximumCoins}. Expired coins, reversal debt and this booking’s own grants are unavailable.</p>}
    {preview.simulatedPayable !== null && <dl><dt>Actual amount due now — unchanged</dt><dd>{money(quote.actualPayable!)}</dd><dt>TEST simulated discount</dt><dd>{money(preview.simulatedDiscount)}</dd><dt>TEST simulated remaining payable</dt><dd>{money(preview.simulatedPayable)}</dd></dl>}
    <p>This is a read-only preview. Final eligibility is checked against current booking totals and expiry when applying TEST coins. Cancelled or fully refunded bookings restore simulation coins to their original grants; expired grants remain expired. Service refunds reverse earnings.</p>
  </section>;
}
