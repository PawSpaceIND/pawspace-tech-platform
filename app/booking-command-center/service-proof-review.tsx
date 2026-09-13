"use client";
import { useEffect, useState } from "react";
import styles from "./service-proof-review.module.css";

/*
 * Founder / ops verification of a partner's before-and-after service photos.
 *
 * The Partner app registers and checksum-confirms each photo, which parks it in quarantine with
 * review_status=pending_review. Nothing could move it past that point from any screen: the only
 * approver was a manual PATCH {action:"record_scan"} against /api/service-media, so grooming
 * completion - and with it after-service payment capture and commission accrual - stalled on every
 * UAT job. This panel is that PATCH with a person, a reason and the maker/checker rule the API already
 * enforces (the uploader cannot approve their own file; a clean/rejected decision needs a reason).
 */
type Asset = {
  id: string; ref: string; purpose: string; proofReady: boolean; proofState?: string; blockedReason?: string | null;
  access_status: string; scan_status: string; review_status?: string | null; review_reason?: string | null;
  mime_type: string; size_bytes: number; created_at: number;
};
type Listing = { assets?: Asset[]; error?: string };

const PURPOSES: Array<{ purpose: string; title: string }> = [{ purpose: "before_service", title: "Before photo" }, { purpose: "after_service", title: "After photo" }];
const STATE_LABEL: Record<string, string> = {
  released: "Verified · accepted as service proof",
  awaiting_upload_confirmation: "Registered · the Partner app has not confirmed the upload yet",
  awaiting_verification: "Uploaded and checksum-confirmed · awaiting your verification",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  blocked: "Approved · release withheld by the scan boundary",
};
const tone = (state: string) => state === "released" ? styles.released : state === "rejected" || state === "withdrawn" ? styles.rejected : styles.waiting;
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const when = (value: number) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));

export default function ServiceProofReview({ bookingId }: { bookingId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    if (!bookingId) return () => { active = false; };
    fetch(`/api/service-media?bookingId=${encodeURIComponent(bookingId)}`, { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as Listing;
        if (!active) return;
        if (!response.ok) { setState("unavailable"); setNote(response.status === 404 ? "No provider work order on this booking, so there is no service proof to verify." : body.error || "Service media could not be loaded."); return; }
        setAssets((body.assets ?? []).filter(asset => asset.purpose === "before_service" || asset.purpose === "after_service"));
        setState("ready");
      })
      .catch(() => { if (active) { setState("unavailable"); setNote("Service media could not be loaded."); } });
    return () => { active = false; };
  }, [bookingId, refreshKey]);

  const decide = async (asset: Asset, scanResult: "clean" | "rejected") => {
    if (busy || reason.trim().length < 5) return;
    setBusy(asset.id); setError(""); setNote("");
    try {
      const response = await fetch("/api/service-media", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: asset.id, action: "record_scan", scanResult, reason: reason.trim() }) });
      const body = await response.json() as { data?: { proofReady?: boolean; accessStatus?: string }; error?: string };
      if (!response.ok) throw new Error(body.error || "The decision was not recorded");
      setNote(scanResult === "clean"
        ? body.data?.proofReady ? "Approved and released. The partner can now attach it as service proof." : "Approved, but the scan/quarantine boundary is withholding release in this environment."
        : "Rejected. The partner is asked for a replacement photo.");
      setReason("");
      setRefreshKey(value => value + 1);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The decision was not recorded"); }
    finally { setBusy(""); }
  };

  const latest = (purpose: string) => { const slot = assets.filter(asset => asset.purpose === purpose); return slot.find(asset => asset.proofReady) ?? slot[slot.length - 1]; };
  const pending = assets.filter(asset => asset.proofState === "awaiting_verification");

  return <section className={styles.panel} aria-label="Service proof verification">
    <div className={styles.head}><div><h3>Service proof verification</h3><p>Before and after photos the partner uploaded for this booking. Approval releases them for job completion; the uploader can never approve their own file.</p></div>{state === "ready" && <p>{pending.length} awaiting verification</p>}</div>
    {state === "loading" && <p className={styles.message}>Loading service media…</p>}
    {state === "unavailable" && <p className={styles.message}>{note}</p>}
    {state === "ready" && PURPOSES.map(({ purpose, title }) => {
      const asset = latest(purpose);
      const proofState = asset?.proofState ?? (asset?.proofReady ? "released" : "blocked");
      return <div key={purpose} className={`${styles.slot} ${asset ? tone(proofState) : styles.waiting}`}>
        <b>{title}</b>
        {!asset ? <span>Not uploaded yet.</span> : <>
          <span>{STATE_LABEL[proofState] ?? proofState}</span>
          <small>{asset.mime_type} · {kb(asset.size_bytes)} · uploaded {when(asset.created_at)}{asset.review_reason ? ` · reviewer note: ${asset.review_reason}` : ""}</small>
          {proofState === "awaiting_verification" && <div className={styles.actions}>
            <button className={styles.approve} disabled={Boolean(busy) || reason.trim().length < 5} onClick={() => void decide(asset, "clean")}>{busy === asset.id ? "Recording…" : "Approve"}</button>
            <button disabled={Boolean(busy) || reason.trim().length < 5} onClick={() => void decide(asset, "rejected")}>Reject</button>
          </div>}
        </>}
      </div>;
    })}
    {state === "ready" && pending.length > 0 && <label className={styles.reason}>Verification note (required, at least 5 characters)<input value={reason} maxLength={240} placeholder="e.g. Photos show the booked pet before and after grooming" onChange={event => setReason(event.target.value)} /></label>}
    {note && state === "ready" && <p className={styles.message}>{note}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
