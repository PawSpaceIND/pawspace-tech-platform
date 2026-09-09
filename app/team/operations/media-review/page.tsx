"use client";
import { useEffect, useState } from "react";
import { useQueryParameter } from "../../../../lib/use-query-parameter";
type Asset = { id: string; purpose: string; proofReady: boolean; access_status: string };
export default function InternalMediaReview() {
  const bookingId = useQueryParameter("bookingId");
  return <BookingMediaReview key={bookingId} bookingId={bookingId} />;
}
function BookingMediaReview({ bookingId }: { bookingId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]), [reason, setReason] = useState(""), [message, setMessage] = useState("");
  const [visiblePhotos, setVisiblePhotos] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const capability = await fetch("/api/internal-service-media?capabilities=1", { cache: "no-store" });
      if (!capability.ok) throw new Error("Internal review is unavailable");
      const response = await fetch(`/api/service-media?bookingId=${encodeURIComponent(bookingId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Photos unavailable");
      const body = await response.json() as { assets?: Asset[] };
      if (active) { setAssets(body.assets || []); setReady(true); }
    })().catch(() => { if (active) { setReady(false); setMessage("Sign in as an authorised reviewer and open an internal-test booking with private storage enabled."); } });
    return () => { active = false; };
  }, [bookingId, revision]);
  async function review(mediaId: string, decision: "approved" | "rejected") {
    if (busy || reason.trim().length < 5 || (decision === "approved" && !visiblePhotos[mediaId])) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/internal-service-media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mediaId, decision, reason }) });
      if (!response.ok) throw new Error("Review refused");
      setReason(""); setMessage(`Internal-test review ${decision}. Return to the partner job and reload its proof.`); setRevision(value => value + 1);
    } catch { setMessage("Review could not be saved. Use a separate reviewer, enter a reason, and confirm the upload is complete."); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 900, margin: "auto", padding: 24, fontSize: 16 }}>
    <h1>Review grooming photos</h1><p>Internal UAT only · Booking {bookingId || "not selected"}</p>
    <p>A different team member must review each photo. This manual UAT review is not an automated malware scan or production certification.</p>
    {message && <p role="status">{message}</p>}
    {ready && <><label htmlFor="review-reason">Review reason</label><textarea id="review-reason" value={reason} onChange={event => setReason(event.target.value)} style={{ display: "block", width: "100%", minHeight: 80 }} />
      {!assets.length && <p>No registered photos for this booking yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(260px,100%),1fr))", gap: 16, marginTop: 20 }}>
        {assets.map(asset => <article key={asset.id} style={{ border: "1px solid #d8cae7", borderRadius: 16, padding: 16 }}>
          <h2>{asset.purpose.replaceAll("_", " ")}</h2>
          {/* Authenticated private media must bypass public image optimisation/caching. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {["quarantined", "ready"].includes(asset.access_status) && <img src={`/api/internal-service-media?mediaId=${encodeURIComponent(asset.id)}`} alt={`${asset.purpose.replaceAll("_", " ")} for review`} onLoad={() => setVisiblePhotos(value => ({ ...value, [asset.id]: true }))} onError={() => setVisiblePhotos(value => ({ ...value, [asset.id]: false }))} style={{ width: "100%", maxHeight: 260, objectFit: "contain" }} />}
          {asset.access_status === "quarantined" && !visiblePhotos[asset.id] && <p>The photo must load before you can approve it. If it stays unavailable, refresh or ask the provider to upload it again.</p>}
          <p>{asset.proofReady ? "Approved internal proof" : asset.access_status.replaceAll("_", " ")}</p>
          {asset.access_status === "quarantined" && <div style={{ display: "flex", gap: 12 }}><button disabled={busy || reason.trim().length < 5 || !visiblePhotos[asset.id]} onClick={() => void review(asset.id, "approved")}>Approve for UAT</button><button disabled={busy || reason.trim().length < 5} onClick={() => void review(asset.id, "rejected")}>Reject photo</button></div>}
        </article>)}
      </div></>}
  </main>;
}
