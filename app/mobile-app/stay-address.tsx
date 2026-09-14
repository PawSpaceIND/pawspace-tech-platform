"use client";
import { useEffect, useState } from "react";
import { loadCustomerAccount } from "../../lib/customer-account-client";
import { defaultStayAddress, savedStayAddressText, validateSavedStayAddress, type StayLocation } from "../../lib/stay-saved-address";
import AddressPicker, { type ZoneResult } from "./address-picker";
import styles from "./stay-flow.module.css";

export default function StayAddress({ customerId, mode, onResolved }: { customerId: string; mode: "boarding" | "sitting" | "training"; onResolved: (address: StayLocation | null) => void }) {
  const [summary, setSummary] = useState(""), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [editing, setEditing] = useState(false), [candidate, setCandidate] = useState<ZoneResult | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    void loadCustomerAccount(undefined, { signal: controller.signal }).then(async account => {
      if (!active) return;
      if (account.customerId !== customerId) throw new Error("Please sign in again to load your address.");
      const saved = defaultStayAddress(account.addresses);
      if (!saved) { setEditing(true); return; }
      setSummary(savedStayAddressText(saved));
      const resolved = await validateSavedStayAddress(saved, controller.signal);
      if (active) onResolved(resolved);
    }).catch(problem => { if (active) setError(controller.signal.aborted ? "Address check timed out. Please retry." : problem instanceof Error ? problem.message : "Unable to check your address."); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [customerId, onResolved, retry]);
  const change = () => { onResolved(null); setCandidate(null); setEditing(true); setError(""); };
  return <section className={styles.savedAddress} aria-label="Care location">
    {!editing && <><b>{mode === "boarding" ? "Find a host near your saved address" : "Your location"}</b>{summary && <p>{summary}</p>}
      {loading && <p role="status">Checking service area…</p>}
      <button type="button" className={styles.addressChange} disabled={loading} onClick={change}>Change Address</button></>}
    {error && <p role="alert">{error} <button type="button" onClick={() => { setLoading(true); setError(""); onResolved(null); setRetry(value => value + 1); }}>Retry address check</button></p>}
    {editing && <><AddressPicker restoreSaved={false} summaryLabel={mode === "boarding" ? "Host location" : "Your location"} onZoneResolved={setCandidate}/>
      <button type="button" className={styles.primary} disabled={!candidate?.zone.serviceAvailable} onClick={() => { if (candidate) { onResolved(candidate); setSummary(candidate.address); setEditing(false); } }}>Use this address</button></>}
  </section>;
}
