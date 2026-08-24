"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import GroomingRouteCard from "./grooming-route-card";
import styles from "./partner.module.css";
import { recordBookingOperation, type BookingOperationResult } from "../../lib/booking-operations-client";

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
type MediaAsset = { ref: string; purpose: "before_service" | "after_service"; proofReady: boolean; access_status: string; scan_status: string };
type PaymentRequest = { status: string; paymentStatus: string; amount: number; paymentPath: string; qrPayload: string; providerReference: string; collectable: boolean; sandboxOnly: boolean; liveCapture: boolean };
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState("");
  // Live order impact: the retired /groomer prototype was the only surface that reached the governed
  // /api/booking-operations, but it sent hardcoded IDs. Here it runs against the REAL selected booking.
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [operationResult, setOperationResult] = useState<BookingOperationResult | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
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
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Verified provider session required"); });
    return () => { cancelled = true; };
  }, []);

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
  }, [identity?.subjectId, refreshKey]);

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

  useEffect(() => { let active=true; queueMicrotask(()=>{if(active)setPaymentRequest(null)}); if (!selected?.bookingId) return()=>{active=false}; void fetch(`/api/grooming-payment-sandbox?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }).then(async response => { const body = await response.json() as { data?: PaymentRequest }; if (active&&response.ok) setPaymentRequest(body.data ?? null); }); return()=>{active=false}; }, [selected?.bookingId, refreshKey]);
  useEffect(() => { if (tab !== "earnings") return; void fetch("/api/provider-workspace", { cache: "no-store" }).then(async response => { const body = await response.json() as { data?: { earnings?: WorkspaceEarnings }; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to load earnings"); setEarnings(body.data?.earnings ?? null); }).catch(problem => setError(problem instanceof Error ? problem.message : "Unable to load earnings")); }, [tab, refreshKey]);

  const prepareMedia = async (file: File, purpose: "before_service" | "after_service") => {
    if (!selected) return; setBusy(true); setError(""); setMediaMessage("");
    try { const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map(value => value.toString(16).padStart(2, "0")).join(""); const response = await fetch("/api/service-media", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: selected.bookingId, purpose, mimeType: file.type, sizeBytes: file.size, sha256: digest }) }); const body = await response.json() as { data?: { storage?: { uploadReady?: boolean } }; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to prepare proof media"); setMediaMessage(body.data?.storage?.uploadReady ? "Secure upload grant prepared." : "File registered, but private storage and malware scanning are not connected. An operations adapter must upload and approve it before completion."); }
    catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to prepare proof media"); } finally { setBusy(false); }
  };

  const requestPayment = async () => { if (!selected) return; setBusy(true); setError(""); try { const response = await fetch("/api/grooming-payment-sandbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: selected.bookingId, action: "request_after_service" }) }); const body = await response.json() as { data?: PaymentRequest; error?: string }; if (!response.ok) throw new Error(body.error || "Unable to create payment request"); setPaymentRequest(body.data ?? null); } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to create payment request"); } finally { setBusy(false); } };

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
    if (!selected || busy) return;
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
          const mediaResponse = await fetch(`/api/service-media?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }); const mediaBody = await mediaResponse.json() as { assets?: MediaAsset[]; error?: string }; if (!mediaResponse.ok) throw new Error(mediaBody.error || "Unable to load approved proof media"); const before = mediaBody.assets?.find(asset => asset.purpose === "before_service" && asset.proofReady), after = mediaBody.assets?.find(asset => asset.purpose === "after_service" && asset.proofReady); if (!before || !after) throw new Error("Approved before and after images are required. Register both files, then wait for private storage confirmation and malware-scan approval.");
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
    }
  };

  const openJob = (job: Job, target: Tab = "jobs") => { setSelectedId(job.bookingId); setTab(target); };

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
            {selected.status === "in_service" && !selected.proof?.beforePhotoRef && <section className={styles.notice}><b>Secure before / after proof</b><p>Choose real UAT images. Registration never marks them complete: private storage confirmation and a clean malware scan are required first.</p><label>Before photo <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void prepareMedia(file, "before_service"); }} /></label><label>After photo <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void prepareMedia(file, "after_service"); }} /></label>{mediaMessage && <p>{mediaMessage}</p>}</section>}
            {selected.status === "completed" && selected.payment.mode === "pay_after_service" && selected.payment.status !== "captured" && <section className={styles.notice}><b>Payment due after service</b>{!paymentRequest ? <><p>Create a collectable Razorpay sandbox payment link and QR payload. This does not capture money.</p><button disabled={busy} onClick={() => void requestPayment()}>Create payment request</button></> : <><p><b>{money(paymentRequest.amount)}</b> · {label(paymentRequest.status)}</p><p><a href={paymentRequest.paymentPath} target="_blank" rel="noreferrer">Open sandbox checkout</a></p><p><code>{paymentRequest.qrPayload}</code></p><small>Razorpay ref {paymentRequest.providerReference}. Payment remains unpaid until a signature-verified gateway capture is reconciled.</small></>}</section>}
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
