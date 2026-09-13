"use client";
import {boundedFetch} from "../../lib/bounded-fetch";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import GroomingRouteCard from "./grooming-route-card";
import PartnerLogin from "../partner/partner-login";
import styles from "./partner.module.css";
import { recordBookingOperation, type BookingOperationResult } from "../../lib/booking-operations-client";
import { discardProviderProof, flushProviderProofQueue, isPermanentProofError, queueProviderProof, type QueuedProviderProof } from "../../lib/provider-proof-offline-queue";

type Tab = "home" | "jobs" | "tracking" | "earnings" | "more";
type Identity = { subjectType?: string; subjectId?: string; roleCode?: string };
type Pet = { id: string; name: string; species: string; breed: string; vaccinationStatus: string };
type Proof = { beforePhotoRef: string | null; afterPhotoRef: string | null; checklist: string[]; completionNotes: string | null };
type Job = {
  bookingId: string;
  workOrderId: string;
  providerId: string;
  providerName: string;
  providerModel: string;
  status: string;
  workOrderStatus: string;
  packageName: string;
  zoneId: string;
  scheduledStart: string;
  scheduledEnd: string;
  totalAmount: number;
  customer: { id: string; name: string; maskedPhone: string };
  pets: Pet[];
  payment: { mode: string; status: string };
  proof: Proof | null;
  invoice: { invoiceNumber: string; status: string; netAmount: number } | null;
};
type JobsResponse = { jobs?: Job[]; error?: string };
type MediaAsset = { id: string; ref: string; purpose: "before_service" | "after_service"; proofReady: boolean; access_status: string; scan_status: string; review_status?: string | null; review_reason?: string | null; created_at: number };
type ProofState = "missing" | "unconfirmed" | "pending" | "rejected" | "approved";
/** What the partner should do next for one proof slot, from the server's own asset states. */
function describeProof(assets: MediaAsset[], purpose: "before_service" | "after_service"): { state: ProofState; text: string } {
  const items = assets.filter(asset => asset.purpose === purpose).sort((a, b) => Number(b.created_at) - Number(a.created_at));
  if (items.some(asset => asset.proofReady)) return { state: "approved", text: "approved by Ops · ready for service proof" };
  const latest = items[0];
  if (!latest) return { state: "missing", text: "not uploaded yet" };
  if (latest.review_status === "pending_review") return { state: "pending", text: "uploaded and verified · awaiting Ops approval" };
  if (latest.review_status === "rejected") return { state: "rejected", text: `rejected by Ops${latest.review_reason ? ` (${latest.review_reason})` : ""} · upload a replacement` };
  if (latest.access_status === "pending_upload") return { state: "unconfirmed", text: "registered but never confirmed · choose the file again" };
  return { state: "pending", text: `${label(latest.access_status)} · ${label(latest.review_status || latest.scan_status)}` };
}
/** A 4xx (other than timeout/rate-limit) will never succeed on retry; the offline queue drops it instead of re-registering for ever. */
const proofFailure = (status: number, message: string) => Object.assign(new Error(message), { permanent: status >= 400 && status < 500 && status !== 408 && status !== 429 });
type PaymentRequest = { status: string; paymentStatus: string; amount: number; paymentPath: string; qrPayload: string; providerReference: string; collectable: boolean; expiresAt: number; sandboxOnly: boolean; liveCapture: boolean };
type WorkspaceEarnings = { visible: boolean; computed: { netPayout: number; orders: number; grossOrderValue: number }; settlements: Array<{ bookingId: string; payoutAmount: number | null; status: string; reason: string }>; incentives: Array<{ monthStart: string; status: string; headTotal: number; helperTotal: number; monthTotal: number }> };

const activeTravelStates = new Set(["assigned", "on_the_way", "arrived"]);
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const label = (value: string) => value.replaceAll("_", " ");
const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
};

export default function PartnerMobileApp() {
  const [tab, setTab] = useState<Tab>("home");
  const [identity, setIdentity] = useState<Identity | null>(null);
  // The auth gate. Until the session probe answers, the shell says "Checking"; once it answers without a
  // verified provider, the OTP sign-in is mounted HERE. Before this, an unauthenticated visitor was dropped
  // straight into the dashboard with only a "Verified provider session required" banner and no way in -
  // the sole partner login lived on /partner/onboarding, which a tester opening /partner-app never sees.
  const [sessionChecked, setSessionChecked] = useState(false);
  const [identityKey, setIdentityKey] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState("");
  // Live order impact: the retired /groomer prototype was the only surface that reached the governed
  // /api/booking-operations, but it sent hardcoded IDs. Here it runs against the REAL selected booking.
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [operationResult, setOperationResult] = useState<BookingOperationResult | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const lifecycleLock = useRef(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [paymentPollKey, setPaymentPollKey] = useState(0);
  const [mediaMessage, setMediaMessage] = useState("");
  const [paymentRequest, setPaymentRequest] = useState<PaymentRequest | null>(null);
  const [earnings, setEarnings] = useState<WorkspaceEarnings | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/identity-session", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: Identity; error?: string };
        if (!response.ok) throw new Error(body.error || "Verified provider session required");
        if (body.data?.subjectType !== "provider" || !body.data.subjectId) throw new Error("Verified provider session required");
        return body.data;
      })
      .then((data) => { if (!cancelled) { setIdentity(data); setError(""); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Verified provider session required"); })
      .finally(() => { if (!cancelled) setSessionChecked(true); });
    return () => { cancelled = true; };
  }, [identityKey]);

  useEffect(() => {
    if (!identity?.subjectId) return;
    let cancelled = false;
    fetch(`/api/partner-grooming-jobs?providerId=${encodeURIComponent(identity.subjectId)}&v=${refreshKey}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as JobsResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load provider jobs");
        return body.jobs ?? [];
      })
      .then((next) => {
        if (cancelled) return;
        setJobs(next);
        setSelectedId((current) => current && next.some((job) => job.bookingId === current) ? current : (next.find((job) => !["completed", "cancelled"].includes(job.status))?.bookingId ?? next[0]?.bookingId ?? ""));
        setError("");
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load provider jobs"); });
    return () => { cancelled = true; };
  }, [identity?.subjectId, refreshKey, paymentPollKey]);

  const selected = useMemo(() => jobs.find((job) => job.bookingId === selectedId) ?? jobs[0] ?? null, [jobs, selectedId]);
  const activeJobs = jobs.filter((job) => !["completed", "cancelled"].includes(job.status));
  const completedJobs = jobs.filter((job) => job.status === "completed");
  const providerName = selected?.providerName || "PawSpace Partner";
  const travelState = selected ? (selected.workOrderStatus || selected.status) : "";
  const canTrack = Boolean(selected && activeTravelStates.has(travelState));

  const nextAction = selected
    ? selected.status === "confirmed" || selected.status === "awaiting_acceptance" ? "accept"
      : selected.status === "assigned" ? "on_the_way"
        : selected.status === "on_the_way" ? "arrived"
          : selected.status === "arrived" ? "start_service"
            : selected.status === "in_service" && !selected.proof?.beforePhotoRef ? "add_proof"
              : selected.status === "in_service" ? "complete"
                : null
    : null;
  const actionLabel = nextAction === "accept" ? "Accept job" : nextAction === "on_the_way" ? "Start journey" : nextAction === "arrived" ? "Mark arrived" : nextAction === "start_service" ? "Start service" : nextAction === "add_proof" ? "Add service proof" : nextAction === "complete" ? "Complete job" : "No action";
  const canDecline = Boolean(selected && selected.providerModel === "commission" && (selected.status === "confirmed" || selected.workOrderStatus === "awaiting_acceptance"));

  useEffect(() => { let active=true; queueMicrotask(()=>{if(active)setPaymentRequest(null)}); if (!selected?.bookingId) return()=>{active=false}; void fetch(`/api/grooming-payment-sandbox?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }).then(async response => { const body = await response.json() as { data?: PaymentRequest }; if (active&&response.ok) setPaymentRequest(body.data ?? null); }); return()=>{active=false}; }, [selected?.bookingId, refreshKey, paymentPollKey]);
  useEffect(() => { if (!paymentRequest?.collectable || ["captured", "refunded", "partially_refunded"].includes(paymentRequest.paymentStatus)) return; const timer=window.setInterval(()=>setPaymentPollKey(current=>current+1),5_000); return()=>window.clearInterval(timer); }, [paymentRequest?.collectable, paymentRequest?.paymentStatus]);
  useEffect(() => { if (tab !== "earnings") return; void fetch("/api/provider-workspace", { cache: "no-store" }).then(async response => { const body = await response.json() as { data?: { earnings?: WorkspaceEarnings }; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to load earnings"); setEarnings(body.data?.earnings ?? null); }).catch(problem => setError(problem instanceof Error ? problem.message : "Unable to load earnings")); }, [tab, refreshKey]);

  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [mediaAssetsError, setMediaAssetsError] = useState("");
  const [mediaPollKey, setMediaPollKey] = useState(0);
  const proofStage = Boolean(selected && selected.status === "in_service" && !selected.proof?.beforePhotoRef);
  const bothApproved = describeProof(mediaAssets, "before_service").state === "approved" && describeProof(mediaAssets, "after_service").state === "approved";
  useEffect(() => {
    if (!proofStage || !selected?.bookingId) { queueMicrotask(() => setMediaAssets([])); return; }
    let active = true;
    void boundedFetch(`/api/service-media?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }).then(async response => {
      const body = await response.json() as { assets?: MediaAsset[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load proof status");
      if (active) { setMediaAssets(body.assets ?? []); setMediaAssetsError(""); }
    }).catch(problem => { if (active) setMediaAssetsError(problem instanceof Error ? problem.message : "Unable to load proof status"); });
    return () => { active = false; };
  }, [proofStage, selected?.bookingId, refreshKey, mediaPollKey]);
  // While a photo waits for Ops, poll so the approval shows up without the partner leaving the screen.
  useEffect(() => { if (!proofStage || !mediaAssets.some(asset => asset.review_status === "pending_review")) return; const timer = window.setInterval(() => setMediaPollKey(value => value + 1), 10_000); return () => window.clearInterval(timer); }, [proofStage, mediaAssets]);

  const registerQueuedProof = async (item: QueuedProviderProof) => {
    // Step 1 - register the file and receive its single-use upload grant.
    const response = await boundedFetch("/api/service-media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: item.bookingId, purpose: item.purpose, mimeType: item.mimeType, sizeBytes: item.sizeBytes, sha256: item.sha256, fileName: item.fileName }) });
    const body = await response.json() as { error?: string; data?: { id?: string; upload?: { token?: string; objectKey?: string } } };
    if (!response.ok) throw proofFailure(response.status, body.error || "Unable to register proof media");
    const mediaId = body.data?.id, grant = body.data?.upload;
    if (!mediaId || !grant?.token || !grant.objectKey) throw proofFailure(500, "Proof registration did not return an upload grant");
    // Step 2 - carry the bytes to the server. /api/service-media/upload hashes what actually arrived, checks
    // size, checksum and type against the grant, stores the object when a private bucket is bound, and only
    // then confirms the asset (the confirm_upload redemption happens server-side, after verification). The
    // confirmation used to be made from the file's SELF-DECLARED size and checksum - the uploader's own claim
    // about bytes the server never saw. That held only while no bucket was bound, and would have failed the
    // moment one was (redeem then HEADs the bucket for an object that nobody had written).
    const upload = await boundedFetch("/api/service-media/upload", { method: "PUT", headers: { "content-type": item.mimeType, "x-pawspace-media-id": mediaId, "x-pawspace-upload-token": grant.token }, body: item.file }, 60_000);
    const uploaded = await upload.json().catch(() => ({})) as { error?: string };
    if (!upload.ok) throw proofFailure(upload.status, uploaded.error || "Unable to upload proof media");
  };

  useEffect(() => {
    const flush = () => void flushProviderProofQueue(registerQueuedProof).then(result => {
      if (result.uploaded) { setMediaMessage(`${result.uploaded} queued proof image${result.uploaded === 1 ? "" : "s"} synced.`); setRefreshKey(value => value + 1); }
    });
    flush();
    window.addEventListener("online", flush);
    const timer = window.setInterval(flush, 15_000);
    return () => { window.removeEventListener("online", flush); window.clearInterval(timer); };
  }, []);

  const prepareMedia = async (file: File, purpose: "before_service" | "after_service") => {
    if (!selected) return; setBusy(true); setError(""); setMediaMessage("");
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map(value => value.toString(16).padStart(2, "0")).join("");
      const queued = await queueProviderProof({ bookingId: selected.bookingId, purpose, file, fileName: file.name, mimeType: file.type, sizeBytes: file.size, sha256: digest });
      if (!navigator.onLine) { setMediaMessage("Proof saved on this device and queued for automatic sync when connectivity returns."); return; }
      try {
        await registerQueuedProof(queued);
        // Registered and confirmed: take it out of the queue BEFORE flushing, or the flush re-registers it.
        await discardProviderProof(queued.id);
        await flushProviderProofQueue(registerQueuedProof);
        setMediaPollKey(value => value + 1);
        setMediaMessage(`${purpose === "before_service" ? "Before" : "After"} photo uploaded and verified. It now waits for Ops approval (Control tower → Customer booking lifecycle → Service proof). Once both photos are approved, tap "Add service proof".`);
      } catch (problem) {
        if (isPermanentProofError(problem)) { await discardProviderProof(queued.id); setMediaMessage(""); setError(problem.message); }
        else setMediaMessage("Network interrupted. Proof is safely queued and will retry automatically.");
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to queue proof media"); } finally { setBusy(false); }
  };

  const requestPayment = async () => { if (!selected) return; setBusy(true); setError(""); try { const response = await fetch("/api/grooming-payment-sandbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: selected.bookingId, action: "request_after_service" }) }); const body = await response.json() as { data?: PaymentRequest; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to create payment request"); setPaymentRequest(body.data ?? null); setPaymentPollKey(current=>current+1); } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to create payment request"); } finally { setBusy(false); } };

  const reportOperation = async (action: "package_upgrade" | "service_overrun" | "running_late" | "vehicle_issue" | "rebook_requested") => {
    if (!selected || operationBusy) return;
    setOperationBusy(true);
    setError("");
    try {
      const result = await recordBookingOperation({
        bookingId: selected.bookingId,
        providerId: selected.providerId,
        action,
        reason: action === "package_upgrade" ? "Customer approved a package upgrade during service"
          : action === "service_overrun" ? "Service is taking longer than the booked slot"
            : action === "vehicle_issue" ? "Vehicle issue reported while travelling"
              : action === "rebook_requested" ? "Delay exceeded the customer comfort window"
                : "Traffic or travel delay reported by the partner",
        impactMinutes: delayMinutes,
      });
      setOperationResult(result);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to record the order update");
    } finally {
      setOperationBusy(false);
    }
  };

  const act = async (action: "accept" | "decline" | "on_the_way" | "arrived" | "start_service" | "add_proof" | "complete") => {
    if (!selected || busy || lifecycleLock.current) return;
    lifecycleLock.current = true;
    setBusy(true);
    setError("");
    try {
      if ((action === "accept" || action === "decline") && selected.providerModel === "commission") {
        const response = await fetch("/api/provider-assignment-recovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: selected.bookingId, providerId: selected.providerId, action, reason: action === "accept" ? "Accepted in mobile Partner app" : "Declined in mobile Partner app" }) });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to respond to assignment");
      } else {
        if (action === "decline") throw new Error("Only commission-provider offers can be declined");
        const input: Record<string, unknown> = { bookingId: selected.bookingId, action, actorId: selected.providerId };
        if (action === "add_proof") {
          const mediaResponse = await boundedFetch(`/api/service-media?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }); const mediaBody = await mediaResponse.json() as { assets?: MediaAsset[]; error?: string }; if (!mediaResponse.ok) throw new Error(mediaBody.error || "Unable to load approved proof media"); const before = mediaBody.assets?.find(asset => asset.purpose === "before_service" && asset.proofReady), after = mediaBody.assets?.find(asset => asset.purpose === "after_service" && asset.proofReady); if (!before || !after) throw new Error(`Both photos must be approved by Ops before service proof can be added. Before photo: ${describeProof(mediaBody.assets ?? [], "before_service").text}. After photo: ${describeProof(mediaBody.assets ?? [], "after_service").text}.`);
          input.beforePhotoRef = before.ref;
          input.afterPhotoRef = after.ref;
          input.checklist = ["Pet identity confirmed", "Service checklist completed", "Customer handover ready"];
          input.completionNotes = "Approved UAT service proof recorded from Partner mobile app";
        }
        const response = await fetch("/api/grooming-lifecycle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to update job");
      }
      setRefreshKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update job");
    } finally {
      setBusy(false);
      lifecycleLock.current = false;
    }
  };

  const openJob = (job: Job, target: Tab = "jobs") => { setSelectedId(job.bookingId); setTab(target); };

  if (sessionChecked && !identity) return <main className={styles.viewport}>
    <section className={styles.phoneShell}>
      <header className={styles.appHeader}>
        <div className={styles.brand}><span>paw</span><b>space</b><small>PARTNER</small></div>
        <div className={styles.identityPill}><i>•</i><span>Signed out</span></div>
      </header>
      <section className={styles.content} aria-label="Partner sign-in">
        {/* The session probe's "not signed in" answer is the expected state here, not an error to show. */}
        <PartnerLogin eyebrow="🐾 Verified provider access" title="Sign in to your Partner workspace" subtitle="Use the mobile number registered on your PawSpace partner profile. The OTP is shown on screen in UAT; no real SMS is sent." onLoggedIn={() => { setError(""); setSessionChecked(false); setIdentityKey((value) => value + 1); }} />
      </section>
    </section>
  </main>;

  return <main className={styles.viewport}>
    <span hidden aria-hidden="true">TEST TRANSACTION ENGINE</span>
    <span hidden aria-hidden="true">LIVE CUSTOMER PROFILE</span>
    <section className={styles.phoneShell}>
      <header className={styles.appHeader}>
        <div className={styles.brand}><span>paw</span><b>space</b><small>PARTNER</small></div>
        <div className={styles.identityPill}><i>✓</i><span>{identity?.subjectId ? "Verified" : "Checking"}</span></div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        {tab === "home" && <>
          <div className={styles.greeting}><div><small>PAWSPACE PARTNER MOBILE</small><h1>{providerName}</h1><p>{identity?.roleCode ? label(identity.roleCode) : "Identity-scoped UAT workspace"}</p></div><button aria-label="Refresh jobs" disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>

          <section className={styles.heroCard}>
            <div className={styles.heroTop}><span>NEXT ASSIGNMENT</span>{selected && <em>{label(selected.status)}</em>}</div>
            {selected ? <>
              <h2>{selected.packageName}</h2>
              <p>{selected.pets.map((pet) => pet.name).join(", ")} · {selected.zoneId}</p>
              <div className={styles.heroMeta}><span>◷ {when(selected.scheduledStart)}</span><span>◉ {selected.customer.name}</span></div>
              <div className={styles.primaryActions}>
                {nextAction && <button disabled={busy} onClick={() => void act(nextAction)}>{busy ? "Updating…" : actionLabel}</button>}
                <button className={styles.secondary} onClick={() => openJob(selected, canTrack ? "tracking" : "jobs")}>{canTrack ? "Open GPS" : "View job"}</button>
              </div>
            </> : <><h2>No assigned jobs</h2><p>Canonical work orders will appear here after assignment.</p></>}
          </section>

          <div className={styles.stats}>
            <article><span>{activeJobs.length}</span><small>active jobs</small></article>
            <article><span>{completedJobs.length}</span><small>completed</small></article>
            <article><span>GPS</span><small>tap to start</small></article>
          </div>

          <h3 className={styles.sectionTitle}>Work from your phone</h3>
          <div className={styles.quickGrid}>
            <button onClick={() => setTab("jobs")}><i>▣</i><b>Jobs</b><small>Accept & complete</small></button>
            <button onClick={() => setTab("tracking")}><i>⌖</i><b>GPS & ETA</b><small>Foreground tracking</small></button>
            <button onClick={() => setTab("earnings")}><i>₹</i><b>Earnings</b><small>Settlement-safe view</small></button>
            <button onClick={() => setTab("more")}><i>☰</i><b>More</b><small>Onboarding & support</small></button>
          </div>

          <section className={styles.safetyCard}><b>Location privacy</b><p>GPS starts only after you tap Start GPS for an active assigned job. It stops when you stop it or leave the tracking screen. Background tracking is not enabled in UAT.</p></section>
        </>}

        {tab === "jobs" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>CANONICAL WORK ORDERS</small><h1>My jobs</h1></div><button disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>
          {jobs.length === 0 && !error && <div className={styles.empty}>No canonical Grooming jobs assigned yet.</div>}
          <div className={styles.jobList}>{jobs.map((job) => <button key={job.bookingId} className={selected?.bookingId === job.bookingId ? styles.jobSelected : ""} onClick={() => setSelectedId(job.bookingId)}><div><small>{when(job.scheduledStart)}</small><strong>{job.packageName}</strong><span>{job.pets.map((pet) => pet.name).join(", ")} · {job.customer.name}</span></div><em>{label(job.status)}</em></button>)}</div>
          {selected && <section className={styles.detailCard}>
            <div className={styles.detailHead}><div><small>BOOKING {selected.bookingId}</small><h2>{selected.packageName}</h2></div><span>{label(selected.status)}</span></div>
            <div className={styles.detailGrid}>
              <div><small>Customer</small><b>{selected.customer.name}</b><span>{selected.customer.maskedPhone}</span></div>
              <div><small>Pets</small><b>{selected.pets.map((pet) => pet.name).join(", ")}</b><span>{selected.pets.map((pet) => pet.breed).filter(Boolean).join(", ")}</span></div>
              <div><small>Time</small><b>{when(selected.scheduledStart)}</b><span>to {when(selected.scheduledEnd)}</span></div>
              <div><small>Payment</small><b>{label(selected.payment.mode)}</b><span>{label(selected.payment.status)}</span></div>
            </div>
            <div className={styles.proof}><b>Service proof</b><span>{selected.proof ? `${selected.proof.beforePhotoRef ? "Before ✓" : "Before —"} · ${selected.proof.afterPhotoRef ? "After ✓" : "After —"} · Checklist ${selected.proof.checklist.length}` : "Not captured yet"}</span>{selected.invoice && <small>Invoice {selected.invoice.invoiceNumber} · {money(selected.invoice.netAmount)}</small>}</div>
            {proofStage && <section className={styles.notice} aria-label="Service proof photos"><b>Secure before / after proof</b><p>Choose real UAT images. Each photo is uploaded, verified against its upload grant, then approved by Ops (a second person) before it counts as service proof.</p>
              {(["before_service", "after_service"] as const).map(purpose => { const status = describeProof(mediaAssets, purpose); const name = purpose === "before_service" ? "Before" : "After"; return <div key={purpose} className={styles.proof}><b>{name} photo</b><span>{status.text}</span>{status.state !== "approved" && status.state !== "pending" && <label>{status.state === "missing" ? `${name} photo` : `Replacement ${name.toLowerCase()} photo`} <input type="file" aria-label={`${name} photo`} accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void prepareMedia(file, purpose); }} /></label>}</div>; })}
              <div className={styles.primaryActions}><button type="button" disabled={busy} onClick={() => setMediaPollKey(value => value + 1)}>Refresh proof status</button></div>
              {bothApproved && <p><b>Both photos approved.</b> Tap “Add service proof” below, then “Complete job”.</p>}
              {mediaAssetsError && <p role="alert">{mediaAssetsError}</p>}{mediaMessage && <p>{mediaMessage}</p>}</section>}
            {selected.status === "completed" && selected.payment.mode === "pay_after_service" && selected.payment.status !== "captured" && <section className={styles.notice}><b>Payment due after service</b>{!paymentRequest ? <><p>Create a collectable Razorpay sandbox payment link and QR payload. This does not capture money.</p><button disabled={busy} onClick={() => void requestPayment()}>Create payment request</button></> : <><p><b>{money(paymentRequest.amount)}</b> · {label(paymentRequest.status)}</p>{paymentRequest.collectable ? <><p><a href={paymentRequest.paymentPath} target="_blank" rel="noreferrer">Open sandbox checkout</a></p><p><code>{paymentRequest.qrPayload}</code></p></> : <p>This payment request is no longer collectable. Refresh or create a governed replacement request.</p>}<small>Razorpay ref {paymentRequest.providerReference}. Payment remains unpaid until a signature-verified gateway capture is reconciled.</small></>}</section>}
            <section className={styles.notice}>
              <b>Live order impact</b>
              <p>Package upgrades, longer service time, traffic or a vehicle issue stay attached to this order. PawSpace recalculates the route and queues an update for every affected customer.</p>
              <label>Expected delay
                <select value={delayMinutes} onChange={(event) => setDelayMinutes(Number(event.target.value))}>
                  {[10, 15, 30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                </select>
              </label>
              <div className={styles.primaryActions}>
                <button disabled={operationBusy} onClick={() => void reportOperation("package_upgrade")}>Package upgraded</button>
                <button disabled={operationBusy} onClick={() => void reportOperation("service_overrun")}>Service taking longer</button>
                <button disabled={operationBusy} onClick={() => void reportOperation("running_late")}>Running late</button>
                <button disabled={operationBusy} onClick={() => void reportOperation("vehicle_issue")}>Bike issue</button>
              </div>
              {operationResult && <p><b>✓ Order timeline updated</b> — {operationResult.notificationsQueued} push/WhatsApp message{operationResult.notificationsQueued === 1 ? "" : "s"} queued · {operationResult.impactedBookings.length} later booking{operationResult.impactedBookings.length === 1 ? "" : "s"} affected.{operationResult.rebookingAvailable && <> Delay is 30+ minutes, so protected customer rebooking is available. <button disabled={operationBusy} onClick={() => void reportOperation("rebook_requested")}>Open protected rebooking</button></>}</p>}
            </section>
            <div className={styles.primaryActions}>{nextAction && <button disabled={busy} onClick={() => void act(nextAction)}>{busy ? "Updating…" : actionLabel}</button>}{canTrack && <button className={styles.secondary} onClick={() => setTab("tracking")}>GPS & route</button>}{canDecline && <button className={styles.danger} disabled={busy} onClick={() => void act("decline")}>Decline</button>}</div>
          </section>}
        </>}

        {tab === "tracking" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>ACTIVE JOB LOCATION</small><h1>GPS & ETA</h1></div><button disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>
          {activeJobs.length > 1 && <div className={styles.selector}>{activeJobs.map((job) => <button key={job.bookingId} className={selected?.bookingId === job.bookingId ? styles.selectorActive : ""} onClick={() => setSelectedId(job.bookingId)}>{job.pets[0]?.name || job.packageName}<small>{label(job.status)}</small></button>)}</div>}
          {!selected && <div className={styles.empty}>No assigned job is available for tracking.</div>}
          {selected && !canTrack && <section className={styles.notice}><b>GPS is not active yet</b><p>This booking is currently <strong>{label(travelState)}</strong>. Accept the job and start the journey before location sharing can begin.</p><button onClick={() => setTab("jobs")}>Open job</button></section>}
          {selected && canTrack && <><section className={styles.trackingSummary}><span>Tracking booking</span><h2>{selected.pets.map((pet) => pet.name).join(", ")} · {selected.packageName}</h2><p>{selected.customer.name} · {selected.zoneId}</p></section><GroomingRouteCard bookingId={selected.bookingId} providerId={selected.providerId} /></>}
        </>}

        {tab === "earnings" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>PARTNER FINANCE</small><h1>Earnings</h1></div><span /></div>
          <section className={styles.financeHero}><i>₹</i><h2>Settlement-controlled earnings</h2><p>This mobile screen never invents payout figures from booking prices. Provider earnings appear only from the canonical settlement and commission ledger after Finance controls are satisfied.</p></section>
          <div className={styles.financeRows}><article><div><b>Computed net payout</b><small>Governed payout computations only</small></div><strong>{money(earnings?.computed.netPayout ?? 0)}</strong></article><article><div><b>Computed orders</b><small>Not raw completed booking value</small></div><strong>{earnings?.computed.orders ?? 0}</strong></article><article><div><b>Live money</b><small>Production payout rail</small></div><strong>OFF</strong></article></div>
          {earnings?.settlements.map(item => <section key={item.bookingId} className={styles.notice}><b>{item.bookingId} · {label(item.status)}</b><p>{item.payoutAmount == null ? "Payout amount pending an approved rule" : money(item.payoutAmount)}</p><small>{item.reason}</small></section>)}
          {earnings?.incentives.map(item => <section key={item.monthStart} className={styles.notice}><b>{item.monthStart} incentive · {label(item.status)}</b><p>Head {money(item.headTotal)} · helper {money(item.helperTotal)} · achievement value {money(item.monthTotal)}</p></section>)}
          <p className={styles.note}>Booking value is deliberately not shown as partner earnings. Payout instructions remain sandbox-only in this UAT candidate.</p>
        </>}

        {tab === "more" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>PARTNER ACCOUNT</small><h1>More</h1></div><span /></div>
          <section className={styles.profileCard}><div className={styles.avatar}>{providerName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><h2>{providerName}</h2><p>{identity?.subjectId || "Provider identity pending"}</p><span>{identity?.roleCode ? label(identity.roleCode) : "provider"}</span></div></section>
          <div className={styles.menuList}><Link href="/partner/onboarding"><i>✓</i><span><b>Onboarding & documents</b><small>Identity-scoped self-service</small></span><em>›</em></Link><button onClick={() => setTab("jobs")}><i>▣</i><span><b>Bookings & service proof</b><small>Canonical work orders</small></span><em>›</em></button><button onClick={() => setTab("tracking")}><i>⌖</i><span><b>GPS, route & ETA</b><small>Foreground location controls</small></span><em>›</em></button><button onClick={() => setTab("earnings")}><i>₹</i><span><b>Earnings & settlement</b><small>No live payout</small></span><em>›</em></button><Link href="/partner"><i>?</i><span><b>Partner help & account</b><small>Canonical provider portal</small></span><em>›</em></Link></div>
          <section className={styles.safetyCard}><b>UAT boundary</b><p>This mobile app uses verified provider identity and canonical work orders. It cannot self-activate a provider, expose unmasked customer phone numbers, make live payouts, or enable background GPS.</p></section>
        </>}
      </section>

      <nav className={styles.bottomNav} aria-label="Partner mobile navigation">
        {([[
          "home", "⌂", "Home"
        ], ["jobs", "▣", "Jobs"], ["tracking", "⌖", "GPS"], ["earnings", "₹", "Earnings"], ["more", "☰", "More"]] as [Tab, string, string][]).map(([key, icon, text]) => <button key={key} className={tab === key ? styles.navActive : ""} onClick={() => setTab(key)}><i>{icon}</i><span>{text}</span></button>)}
      </nav>
    </section>
  </main>;
}
