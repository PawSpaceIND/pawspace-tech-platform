"use client";
import { useCallback, useEffect, useState } from "react";
import styles from "./service-proof-review.module.css";
import { loadPartnerProofForReview, partnerProofState, PARTNER_PROOF_SERVICES, recordPartnerProofDecision, type PartnerProofMedia, type PartnerProofService, type PartnerProofState } from "../../lib/partner-proof-client";

/*
 * [PARTNER-02] Service proof verification for Boarding, Pet Sitting and Pet Taxi.
 *
 * The partner uploads a photo from their proof page; the server checks its bytes against what was
 * declared and parks it in quarantine. Until a second person records a scan decision it cannot back a
 * daily update, medication record or incident - so without this panel no Boarding stay could ever be
 * checked out. Verify / Reject is the service's own governed record_media_scan action: it needs
 * bookings.manage, and the person who submitted a photo can never decide on it. This panel only
 * offers the decision for photos that are uploaded and awaiting it; it never approves anything itself.
 */
const STATE_LABEL: Record<PartnerProofState, string> = {
  awaiting_upload: "Registered · the partner's upload has not arrived yet",
  awaiting_verification: "Uploaded and checksum-verified · awaiting your verification",
  verified: "Verified · usable as service proof",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  blocked: "Not usable as proof",
};
const tone = (state: PartnerProofState) => state === "verified" ? styles.released : state === "rejected" || state === "withdrawn" ? styles.rejected : styles.waiting;
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
const when = (value: number) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(Number(value)));

export default function PartnerProofReview({ bookingId, service }: { bookingId: string; service: PartnerProofService }) {
  const config = PARTNER_PROOF_SERVICES[service];
  const [media, setMedia] = useState<PartnerProofMedia[]>([]);
  const [scopeId, setScopeId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const loaded = await loadPartnerProofForReview(service, bookingId);
      setScopeId(loaded.scopeId); setMedia(loaded.media); setState(loaded.scopeId ? "ready" : "unavailable");
      if (!loaded.scopeId) setNote(`No ${config.title} stay is linked to this booking, so there is no proof to verify.`);
    } catch (problem) { setState("unavailable"); setNote(problem instanceof Error ? problem.message : `${config.title} proof could not be loaded.`); }
  }, [bookingId, service, config.title]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const decide = async (item: PartnerProofMedia, scanResult: "clean" | "rejected") => {
    if (busy || reason.trim().length < 5) return;
    setBusy(item.id); setError(""); setNote("");
    try {
      await recordPartnerProofDecision(service, { scopeId, mediaId: item.id, scanResult, reason: reason.trim() });
      setNote(scanResult === "clean" ? `Verified. The partner can now use this photo for ${config.use}.` : "Rejected. The partner is asked to upload a replacement photo.");
      setReason("");
      await load();
    } catch (problem) {
      const status = (problem as { status?: number }).status;
      setError(status === 403 ? "Refused: a photo can only be verified by someone other than the person who submitted it, and verification needs booking-management permission." : problem instanceof Error ? problem.message : "The decision was not recorded");
    } finally { setBusy(""); }
  };

  const pending = media.filter(item => partnerProofState(item) === "awaiting_verification");
  return <section className={styles.panel} aria-label="Service proof verification">
    <div className={styles.head}><div><h3>Service proof verification</h3><p>{config.title} photos the partner uploaded for this booking. Verifying one makes it usable for {config.use}; the uploader can never verify their own photo.</p></div>{state === "ready" && <p>{pending.length} awaiting verification</p>}</div>
    {state === "loading" && <p className={styles.message}>Loading {config.title} proof…</p>}
    {state === "unavailable" && <p className={styles.message}>{note}</p>}
    {state === "ready" && !media.length && <p className={styles.message}>No {config.title} proof photos uploaded yet.</p>}
    {state === "ready" && media.map(item => {
      const proofState = partnerProofState(item);
      return <div key={item.id} className={`${styles.slot} ${tone(proofState)}`}>
        <b>{config.purposes[item.purpose] ?? item.purpose.replaceAll("_", " ")}</b>
        <span>{STATE_LABEL[proofState]}</span>
        <small>{item.id}{item.mime_type ? ` · ${item.mime_type}` : ""}{item.size_bytes ? ` · ${kb(Number(item.size_bytes))}` : ""} · registered {when(item.created_at)}</small>
        {item.object_stored === 0 && <small role="note">File storage is not connected in this environment: the upload&apos;s size and checksum were verified, but no image was kept to open. Whether that is enough to verify is your call.</small>}
        {proofState === "awaiting_verification" && <div className={styles.actions}>
          <button className={styles.approve} disabled={Boolean(busy) || reason.trim().length < 5} onClick={() => void decide(item, "clean")}>{busy === item.id ? "Recording…" : "Verify"}</button>
          <button disabled={Boolean(busy) || reason.trim().length < 5} onClick={() => void decide(item, "rejected")}>Reject</button>
        </div>}
      </div>;
    })}
    {state === "ready" && pending.length > 0 && <label className={styles.reason}>Verification note (required, at least 5 characters)<input value={reason} maxLength={240} placeholder="e.g. Photo shows the booked pet fed and settled at the host's home" onChange={event => setReason(event.target.value)} /></label>}
    {note && state === "ready" && <p className={styles.message}>{note}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
