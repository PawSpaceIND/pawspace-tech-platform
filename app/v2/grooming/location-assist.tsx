"use client";
import { useEffect, useRef, useState } from "react";
import { requestGroomingLocationDraft, type GroomingLocationDraft } from "../../../lib/v2/grooming-location-draft";
import styles from "./location-assist.module.css";

type Props = {
  disabled: boolean;
  onConfirm: (draft: GroomingLocationDraft) => void;
  onPendingChange: (pending: boolean) => void;
  onManualEntry: () => void;
};
export default function GroomingLocationAssist({ disabled, onConfirm, onPendingChange, onManualEntry }: Props) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<GroomingLocationDraft | null>(null);
  const [error, setError] = useState("");
  const requestRef = useRef({ version: 0, controller: null as AbortController | null });
  useEffect(() => {
    const request = requestRef.current;
    return () => { request.version++; request.controller?.abort(); onPendingChange(false); };
  }, [onPendingChange]);

  function discard() {
    const request = requestRef.current;
    request.version++; request.controller?.abort(); request.controller = null;
    setBusy(false); setDraft(null); setError(""); onPendingChange(false);
  }
  async function locate() {
    if (disabled || requestRef.current.controller) return;
    const request = requestRef.current, version = ++request.version;
    const controller = new AbortController(); request.controller = controller;
    setBusy(true); setDraft(null); setError(""); onPendingChange(true);
    try {
      const suggestion = await requestGroomingLocationDraft({ signal: controller.signal });
      if (request.version === version) setDraft(suggestion);
    } catch (problem) {
      if (request.version === version) {
        setError(problem instanceof Error ? problem.message : "Location is unavailable. Enter your address manually.");
        onPendingChange(false);
      }
    } finally {
      if (request.version === version) { request.controller = null; setBusy(false); }
    }
  }
  function confirm() {
    if (disabled || !draft) return;
    const confirmed = draft; discard(); onConfirm(confirmed);
  }

  return <div className={`${styles.assist} ${styles.location}`} role="group" aria-label="Current location">
    <p>Use your device location to suggest an address. Review it and add your house or flat details before checking the service area. This does not save an address to your account.</p>
    <div className={styles.actions}>
      <button type="button" disabled={disabled || busy} onClick={() => void locate()}>Use current location</button>
      <button type="button" disabled={disabled} onClick={() => { discard(); onManualEntry(); }}>Enter address manually</button>
    </div>
    {busy && <div><p role="status">Finding your current address… You can cancel and keep the address already entered.</p><button type="button" disabled={disabled} onClick={discard}>Cancel location lookup</button></div>}
    {draft && <section aria-label="Suggested service address" className={styles.suggestion}>
      <p role="status">Review this suggested address. Your booking address has not changed.</p>
      <strong>{draft.address}</strong><p>PIN: {draft.pincode}</p>
      <p>A device location can identify the surrounding area, not your exact door. Please add any missing house, flat or floor after choosing it.</p>
      <div className={styles.actions}><button type="button" disabled={disabled} onClick={confirm}>Use suggested address</button><button type="button" disabled={disabled} onClick={discard}>Keep entered address</button></div>
    </section>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
