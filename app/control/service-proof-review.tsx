"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Ops decision step for provider service proof (before / after photos).
 *
 * The Partner app registers a photo and confirms its upload against a single-use grant; the asset then
 * sits in `pending_review`. The grooming `complete` gate (lib/service-media-security.ts) accepts a photo
 * only after a SECOND person approves it with a reason (maker/checker), so without this screen a partner
 * could never finish a job: every completion failed with "approved before and after images are required".
 * Approve / Reject here is `PATCH /api/service-media {action:"record_scan"}`, which requires
 * bookings.manage and refuses self-approval by the uploader.
 */
type Asset = { id: string; ref: string; booking_id: string; provider_id: string; purpose: string; mime_type: string; size_bytes: number; scan_status: string; access_status: string; review_status?: string | null; review_reason?: string | null; reviewed_by?: string | null; created_by?: string | null; created_at: number; proofReady: boolean; provider_name?: string; service_code?: string; objectStored?: boolean | null };
const label = (value: string | null | undefined) => String(value ?? "").replaceAll("_", " ") || "—";
const when = (value: number) => new Date(Number(value)).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/**
 * [LP-N09] objectStored is what the redemption actually verified, not this environment's headline
 * status: false means the upload was confirmed from a caller-reported digest alone because no private
 * bucket is bound, and no bytes exist anywhere for a reviewer to open. "awaiting your decision" and
 * "proof ready" must never be the whole story when that is true - the words themselves changed, not
 * whether the reviewer may still approve (that choice stays theirs; see the banner in the article below).
 */
const stateOf = (asset: Asset) => {
  const notStored = asset.objectStored === false;
  if (asset.proofReady) return notStored ? "approved · but no file was ever kept (storage not connected)" : "approved · proof ready";
  if (asset.review_status === "pending_review") return notStored ? "hash recorded only, no file kept · awaiting your decision" : "awaiting your decision";
  if (asset.review_status === "rejected") return "rejected";
  if (asset.access_status === "pending_upload") return "registered, upload not confirmed";
  return `${label(asset.access_status)} · ${label(asset.review_status ?? asset.scan_status)}`;
};

export default function ServiceProofReview({ bookingId, title }: { bookingId?: string; title?: string }) {
  const [assets, setAssets] = useState<Asset[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({}), [busyId, setBusyId] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const url = bookingId ? `/api/service-media?bookingId=${encodeURIComponent(bookingId)}` : "/api/service-media?pending=1";
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json() as { assets?: Asset[]; pending?: Asset[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load service proof");
      setAssets(body.assets ?? body.pending ?? []);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to load service proof"); }
    finally { setLoading(false); }
  }, [bookingId]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const decide = async (asset: Asset, scanResult: "clean" | "rejected") => {
    const reason = (reasons[asset.id] || "").trim();
    if (reason.length < 5) { setError("Write a short reason (at least 5 characters) before approving or rejecting."); return; }
    setBusyId(asset.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/service-media", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: asset.id, action: "record_scan", scanResult, reason }) });
      const body = await response.json() as { error?: string; data?: { proofReady?: boolean; reviewStatus?: string } };
      if (!response.ok) throw new Error(body.error || "Unable to record the decision");
      setNotice(scanResult === "clean" ? (body.data?.proofReady ? `${label(asset.purpose)} photo approved and released as service proof.` : `${label(asset.purpose)} photo approved, but the release boundary still holds it (${body.data?.reviewStatus ?? "see media events"}).`) : `${label(asset.purpose)} photo rejected. The partner can upload a replacement.`);
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to record the decision"); }
    finally { setBusyId(""); }
  };

  const pending = assets.filter(asset => asset.review_status === "pending_review");
  return <section aria-label={title ?? "Service proof review"} style={{ border: "1px solid #d9e2dc", borderRadius: 14, padding: 14, display: "grid", gap: 10, background: "#fff" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><div><span style={{ fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", opacity: .7 }}>Maker / checker</span><h4 style={{ margin: 0 }}>{title ?? "Service proof review"}</h4></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button></header>
    {error && <p role="alert" style={{ color: "#b3261e", margin: 0 }}>{error}</p>}
    {notice && <p role="status" style={{ margin: 0 }}>{notice}</p>}
    {!loading && !assets.length && <p style={{ margin: 0, opacity: .75 }}>{bookingId ? "No proof photos registered for this booking yet." : "No proof photos are waiting for review."}</p>}
    {assets.map(asset => <article key={asset.id} style={{ display: "grid", gap: 6, padding: 10, borderRadius: 10, background: asset.review_status === "pending_review" ? "#fff8e6" : "#f4f7f5" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}><strong>{label(asset.purpose)} photo</strong><span>{stateOf(asset)}</span></div>
      <small>{!bookingId && <>Booking {asset.booking_id} · {asset.provider_name ?? asset.provider_id} · </>}{asset.mime_type} · {Math.round(Number(asset.size_bytes) / 1024)} KB · uploaded {when(asset.created_at)}{asset.created_by ? ` by ${asset.created_by}` : ""}{asset.reviewed_by ? ` · reviewed by ${asset.reviewed_by}` : ""}{asset.review_reason ? ` · "${asset.review_reason}"` : ""}</small>
      {asset.objectStored === false && <p role="alert" style={{ margin: 0, color: "#b3261e", fontWeight: 600 }}>⚠ File storage is not connected in this environment. Only the upload&apos;s hash was verified — no image exists to open. Whether that is acceptable to approve is your call.</p>}
      {asset.review_status === "pending_review" && <div style={{ display: "grid", gap: 6 }}>
        <input aria-label={`Review reason for ${label(asset.purpose)} photo`} placeholder="Reason for the decision (required)" value={reasons[asset.id] ?? ""} onChange={event => setReasons(current => ({ ...current, [asset.id]: event.target.value }))} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={busyId === asset.id} onClick={() => void decide(asset, "clean")}>Approve {label(asset.purpose)} photo</button>
          <button type="button" disabled={busyId === asset.id} onClick={() => void decide(asset, "rejected")}>Reject</button>
        </div>
      </div>}
    </article>)}
    {pending.length > 0 && <small style={{ opacity: .7 }}>The person who uploaded a photo cannot approve it. Approval here is what lets the partner add service proof and complete the job.</small>}
  </section>;
}
