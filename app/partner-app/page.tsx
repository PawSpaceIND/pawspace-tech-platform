"use client";
import {boundedFetch} from "../../lib/bounded-fetch";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {useStatusQueue} from "./use-status-queue";
import {useDutyTracking} from "./use-duty-tracking";
import {BEFORE_SERVICE,AFTER_SERVICE,checklistComplete,isGroomerOnDuty} from "../../lib/partner-job-checklists";
import GroomingRouteCard from "./grooming-route-card";
import PartnerLogin from "../partner/partner-login";
import styles from "./partner.module.css";
import { recordBookingOperation, type BookingOperationResult } from "../../lib/booking-operations-client";
import { clearProviderProofQueue, discardProviderProof, flushProviderProofQueue, isPermanentProofError, queueProviderProof, type QueuedProviderProof } from "../../lib/provider-proof-offline-queue";

type Tab = "home" | "jobs" | "tracking" | "earnings" | "more";
type Identity = { subjectType?: string; subjectId?: string; roleCode?: string };
type UatProvider = { id: string; name: string; cityId: string; services: string[] };
type Pet = { id: string; name: string; species: string; breed: string; vaccinationStatus: string; safetyNotes?:string[] };
type Proof = { beforePhotoRef: string | null; afterPhotoRef: string | null; checklist: string[]; completionNotes: string | null };
/** Already sanitized server-side by projectProviderLifecycleEvent: operational state, never contact data. */
type JobEvent = { eventType: string; entityType: string; actorId: string; detail: Record<string, unknown>; occurredAt: number };
/**
 * Every field /api/partner-grooming-jobs actually returns for a job.
 *
 * The route projects safetyRequirements and addOns out of the booking's pricing_json and returns the
 * payment amounts alongside the mode - none of which were declared here, so all of them were dropped
 * on arrival. A partner therefore drove to a job without the handling requirements recorded against
 * the pet and without any of the money on it.
 *
 * amount and amountDueNow are not interchangeable: amountDueNow is what the customer owed ONLINE at
 * booking, which the flow sets to 0 for pay_after_service - exactly the case where the partner is the
 * one collecting. The door figure is therefore `amount`, and the render keeps them apart.
 *
 * occurrenceCount matters for the same reason: a multi-visit package rendered as if it were one visit.
 */
type Job = {
  serviceCode?: string;
  trainingSessionId?: string;
  training?: { sequenceNo: number; totalSessions: number; completedSessions: number; programmeStatus: string; requirements: string[]; attendance: Record<string, unknown>; homework: Record<string, unknown>; progress: Record<string, unknown>; evidenceRefs: string[] };
  bookingId: string;
  workOrderId: string;
  providerId: string;
  providerName: string;
  providerModel: string;
  status: string;
  workOrderStatus: string;
  occurrenceCount: number;
  packageCode: string;
  packageName: string;
  zoneId: string;
  cityId: string;
  scheduledStart: string;
  scheduledEnd: string;
  totalAmount: number;
  currency: string;
  customer: { id: string; name: string; maskedPhone: string };
  pets: Pet[];
  payment: { method: string; mode: string; status: string; amount: number; amountDueNow: number };
  subscription: string | null;
  addOns: string[];
  safetyRequirements: string[];
  proof: (Proof & { updatedAt: number }) | null;
  invoice: { invoiceNumber: string; status: string; netAmount: number; issuedAt: number } | null;
  events: JobEvent[];
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
/**
 * Both engagement shapes, because providerWorkspace returns different keys for each and this one screen
 * renders whichever arrives. A CONTRACT provider carries settlements + incentives and
 * computed.netPayout; a COMMISSION provider carries commissionOrders + payouts and
 * computed.commissionAmount, with no settlements or incentives key at all.
 *
 * Reading computed.netPayout therefore showed every commission partner zero while
 * earnings.netPayout held the real figure, and mapping the settlements list threw outright on the
 * missing key - an optional chain on `earnings` short-circuits one level too early to protect the list
 * itself, so the Earnings tab hit the error boundary. Every per-engagement key is optional here, each
 * list is defaulted before it is mapped, and the totals are read from the top-level fields, which both
 * shapes always set.
 */
type WorkspaceSettlement = { bookingId: string; payoutAmount: number | null; status: string; reason: string };
type WorkspaceIncentive = { monthStart: string; status: string; headTotal: number; helperTotal: number; monthTotal: number };
type WorkspaceCommissionOrder = { bookingId: string; serviceCode: string; orderAmount: number; commissionAmount: number; commissionMode: string; status: string; dueAt: number };
type WorkspaceCommissionPayout = { id: string; bookingId: string; amount: number; status: string; dueAt: number; providerReference: string | null };
type WorkspaceEarnings = {
  visible: boolean;
  netPayout?: number; orders?: number; grossOrderValue?: number; note?: string;
  computed?: { netPayout?: number; commissionAmount?: number; orders?: number; grossOrderValue?: number };
  settlements?: WorkspaceSettlement[];
  incentives?: WorkspaceIncentive[];
  commissionOrders?: WorkspaceCommissionOrder[];
  payouts?: WorkspaceCommissionPayout[];
};
/** Shift liveness for today, and the proof stages the server says are still outstanding. */
type WorkspaceLiveness = { required: boolean; matched: boolean; shiftDate: string; checkId: string | null };
type WorkspacePendingProof = { bookingId: string; serviceCode: string; missing: string[] };
type WorkspacePayload = { linked?: boolean; reason?: string; engagement?: string; onboardingStatus?: string; liveness?: WorkspaceLiveness; pendingProof?: WorkspacePendingProof[]; earnings?: WorkspaceEarnings };

const activeTravelStates = new Set(["assigned", "on_the_way", "arrived", "in_service"]);
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const label = (value: string) => value.replaceAll("_", " ");
const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
};
/** expiresAt, dueAt and friends arrive as epoch milliseconds rather than as a date string. */
// A payment that is captured, refunded or partially refunded is finished: nothing is collectable
// against it. This is the single source of that judgement. The pay-after-service section gate used to
// test only for "captured", so a REFUNDED booking still rendered "Payment due after service" and
// offered to create a collection link against money that had already gone back to the customer.
const SETTLED_PAYMENT_STATUSES = ["captured", "refunded", "partially_refunded"];

const whenMs = (value: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? when(new Date(Number(value)).toISOString()) : "";

export default function PartnerMobileApp() {
  return <Suspense fallback={null}><PartnerMobileAppContent /></Suspense>;
}

function PartnerMobileAppContent() {
  const searchParams = useSearchParams();
  const requestedBookingId = searchParams.get("bookingId") || "";
  const [tab, setTab] = useState<Tab>("home");
  const [identity, setIdentity] = useState<Identity | null>(null);
  // The dashboard is gated on the SERVER's answer only. "checking" avoids flashing the sign-in form at
  // a partner whose session is still being resolved; "unauthenticated" mounts the OTP sign-in in place
  // of the dashboard. A successful OTP never becomes an identity here: it only re-asks the server.
  const [sessionState, setSessionState] = useState<"checking" | "verified" | "revoking" | "revocation_failed" | "unauthenticated">("checking");
  const [identityKey, setIdentityKey] = useState(0);
  // Sign-out and the UAT-only provider switch both end in the same place: the server is asked again
  // who this session is, and the gate above renders whatever it answers.
  const [signingOut, setSigningOut] = useState(false);
  const [uatProviders, setUatProviders] = useState<UatProvider[] | null>(null);
  const [uatRosterError, setUatRosterError] = useState("");
  const [uatProviderId, setUatProviderId] = useState("");
  const [uatCode, setUatCode] = useState("");
  const [switching, setSwitching] = useState(false);
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
  const [earningsNotice, setEarningsNotice] = useState("");
  const [engagement, setEngagement] = useState("");
  const [workspaceState, setWorkspaceState] = useState<{ onboardingStatus: string; liveness: WorkspaceLiveness | null; pendingProof: WorkspacePendingProof[] }>({ onboardingStatus: "", liveness: null, pendingProof: [] });
  const sessionVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const version = sessionVersion.current;
    fetch("/api/identity-session", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: Identity; error?: string };
        if (!response.ok) throw new Error(body.error || "Verified provider session required");
        if (body.data?.subjectType !== "provider" || !body.data.subjectId) throw new Error("Verified provider session required");
        return body.data;
      })
      .then((data) => { if (!cancelled && version === sessionVersion.current) { setIdentity(data); setSessionState("verified"); setError(""); } })
      .catch(() => { if (!cancelled && version === sessionVersion.current) { setIdentity(null); setSessionState("unauthenticated"); } });
    return () => { cancelled = true; };
  }, [identityKey]);

  useEffect(() => {
    // Only a verified session asks for the roster; the More tab is unreachable otherwise, and a 404
    // (the gate is shut outside UAT) simply leaves the switch unrendered.
    if (sessionState !== "verified") return;
    let cancelled = false;
    fetch("/api/uat-provider-switch", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) return null;
        const body = await response.json() as { data?: { providers?: UatProvider[] }; error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load the UAT provider roster");
        return body.data?.providers ?? [];
      })
      .then((providers) => { if (!cancelled) { setUatProviders(providers); setUatRosterError(""); } })
      // A 404 is the gate being shut (not UAT) and stays silent; any other failure is shown in the
      // More tab so a tester knows the switch exists but could not be loaded, rather than hidden.
      .catch((err) => { if (!cancelled) { setUatProviders(null); setUatRosterError(err instanceof Error ? err.message : "Unable to load the UAT provider roster"); } });
    return () => { cancelled = true; };
  }, [sessionState, identityKey]);

  useEffect(() => {
    if (!identity?.subjectId) return;
    let cancelled = false;
    const version = sessionVersion.current;
    fetch(`/api/partner-jobs?providerId=${encodeURIComponent(identity.subjectId)}&v=${refreshKey}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as JobsResponse;
        if (!response.ok) throw new Error(body.error || "Unable to load provider jobs");
        return body.jobs ?? [];
      })
      .then((next) => {
        if (cancelled || version !== sessionVersion.current) return;
        setJobs(next);
        setSelectedId((current) => {
          if (requestedBookingId && next.some((job) => job.bookingId === requestedBookingId)) return requestedBookingId;
          return current && next.some((job) => job.bookingId === current) ? current : (next.find((job) => !["completed", "cancelled"].includes(job.status))?.bookingId ?? next[0]?.bookingId ?? "");
        });
        setError("");
      })
      .catch((err) => { if (!cancelled && version === sessionVersion.current) setError(err instanceof Error ? err.message : "Unable to load provider jobs"); });
    return () => { cancelled = true; };
  }, [identity?.subjectId, refreshKey, paymentPollKey, requestedBookingId]);

  useEffect(()=>{if(!identity?.subjectId)return;const timer=setInterval(()=>setRefreshKey(value=>value+1),30000);return()=>clearInterval(timer);},[identity?.subjectId]);
  const dutyJob=jobs.filter(isGroomerOnDuty).sort((a,b)=>["in_service","arrived","on_the_way","assigned"].indexOf(a.status)-["in_service","arrived","on_the_way","assigned"].indexOf(b.status))[0]??null;
  const selected = useMemo(() => (tab==="home"?dutyJob:null) ?? jobs.find((job) => job.bookingId === selectedId) ?? jobs[0] ?? null, [jobs, selectedId, tab, dutyJob]);
  const statusQueue=useStatusQueue(identity?.subjectId,()=>setRefreshKey(value=>value+1));
  const trackingNotice=useDutyTracking(dutyJob,statusQueue.setConnection,()=>setRefreshKey(value=>value+1));
  const [checks,setChecks]=useState<Record<string,string[]>>({});
  const selectedChecks=selected?checks[selected.bookingId]??[]:[];
  const pendingStatus=Boolean(selected&&statusQueue.pending.some(item=>item.bookingId===selected.bookingId));
  const toggleCheck=(id:string)=>{if(selected)setChecks(current=>({...current,[selected.bookingId]:selectedChecks.includes(id)?selectedChecks.filter(value=>value!==id):[...selectedChecks,id]}));};
  const activeJobs = jobs.filter((job) => !["completed", "cancelled"].includes(job.status));
  const completedJobs = jobs.filter((job) => job.status === "completed");
  // A provider with no grooming work order yet (a trainer switched to in UAT, for one) is still named
  // from the roster the switch loaded, so the greeting shows who the session is.
  const providerName = selected?.providerName || uatProviders?.find((provider) => provider.id === identity?.subjectId)?.name || "PawSpace Partner";
  const travelState = selected ? (selected.workOrderStatus || selected.status) : "";
  const isTraining = selected?.serviceCode === "dog_training";
  const canTrack = Boolean(selected && !isTraining && activeTravelStates.has(travelState));

  const nextAction = selected
    ? isTraining
      ? selected.status === "scheduled" ? "training_accept"
        : selected.status === "accepted" ? "training_on_the_way"
          : null
      : selected.status === "confirmed" || selected.status === "awaiting_acceptance" ? "accept"
        : selected.status === "assigned" ? "on_the_way"
          : selected.status === "on_the_way" ? "arrived"
            : selected.status === "arrived" ? "start_service"
              : selected.status === "in_service" && !selected.proof?.beforePhotoRef ? "add_proof"
                : selected.status === "in_service" ? "complete"
                  : null
    : null;
  const actionLabel = nextAction === "training_accept" ? "Accept training session"
    : nextAction === "training_on_the_way" ? "Start journey"
      : nextAction === "accept" ? "Accept job"
        : nextAction === "on_the_way" ? "Start journey"
          : nextAction === "arrived" ? "Mark arrived"
            : nextAction === "start_service" ? "Start service"
              : nextAction === "add_proof" ? "Add service proof"
                : nextAction === "complete" ? "Complete job" : "No action";
  const canDecline = Boolean(selected && selected.providerModel === "commission" && (selected.status === "confirmed" || selected.workOrderStatus === "awaiting_acceptance"));

  useEffect(() => { let active=true; queueMicrotask(()=>{if(active)setPaymentRequest(null)}); if (!selected?.bookingId || selected.serviceCode === "dog_training") return()=>{active=false}; void fetch(`/api/grooming-payment-sandbox?bookingId=${encodeURIComponent(selected.bookingId)}`, { cache: "no-store" }).then(async response => { const body = await response.json() as { data?: PaymentRequest }; if (active&&response.ok) setPaymentRequest(body.data ?? null); }).catch(()=>{if(active)setPaymentRequest(null);}); return()=>{active=false}; }, [selected?.bookingId, refreshKey, paymentPollKey]);
  useEffect(() => { if (!paymentRequest?.collectable || SETTLED_PAYMENT_STATUSES.includes(paymentRequest.paymentStatus)) return; const timer=window.setInterval(()=>setPaymentPollKey(current=>current+1),5_000); return()=>window.clearInterval(timer); }, [paymentRequest?.collectable, paymentRequest?.paymentStatus]);
  useEffect(() => {
    if (tab !== "earnings" || sessionState !== "verified") return;
    let active = true;
    const version = sessionVersion.current;
    void fetch("/api/provider-workspace", { cache: "no-store" }).then(async response => {
      const body = await response.json() as { data?: WorkspacePayload; error?: string };
      if (!response.ok) throw new Error(body.error || "Unable to load earnings");
      // main's staleness guard, and every setter below sits inside it. workspaceState especially:
      // pendingProof names the PREVIOUS partner's booking ids, so a response arriving after the
      // session changed hands is exactly the leak resetAccountState exists to prevent.
      if (!active || version !== sessionVersion.current) return;
      // linked:false is a 200 carrying no earnings key - an identity with no provider record bound to
      // it. Rendering that as zero rupees was indistinguishable from having earned nothing, so say it.
      if (body.data?.linked === false) { setEarnings(null); setEngagement(""); setWorkspaceState({ onboardingStatus: "", liveness: null, pendingProof: [] }); setEarningsNotice(body.data.reason || "No active provider record is linked to your identity."); return; }
      const next = body.data?.earnings ?? null;
      setEarnings(next);
      setEngagement(body.data?.engagement ?? "");
      // Returned by the same call all along: today's liveness gate, the onboarding link state and the
      // proof stages the server considers outstanding. None of them used to leave this handler.
      setWorkspaceState({ onboardingStatus: body.data?.onboardingStatus ?? "", liveness: body.data?.liveness ?? null, pendingProof: body.data?.pendingProof ?? [] });
      // The .catch below writes the shell-wide error banner. Without clearing it here a successful
      // retry left the previous failure on screen next to freshly loaded figures.
      setError("");
      setEarningsNotice(!next ? "Earnings are not available for this provider record yet."
        : next.visible === false ? "Earnings are withheld for this provider record until Finance controls are satisfied."
          : "");
    }).catch(problem => { if (active && version === sessionVersion.current) setError(problem instanceof Error ? problem.message : "Unable to load earnings"); });
    return () => { active = false; };
  }, [tab, refreshKey, sessionState]);


  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [mediaAssetsError, setMediaAssetsError] = useState("");
  const [mediaPollKey, setMediaPollKey] = useState(0);
  const proofStage = Boolean(selected && selected.serviceCode !== "dog_training" && selected.status === "in_service" && !selected.proof?.beforePhotoRef);
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
    if(sessionState!=="verified"||!identity?.subjectId)return;
    let active=true;
    const flush = () => void flushProviderProofQueue(registerQueuedProof).then(result => {
      if (active&&result.uploaded) { setMediaMessage(`${result.uploaded} queued proof image${result.uploaded === 1 ? "" : "s"} synced.`); setRefreshKey(value => value + 1); }
    });
    flush();
    window.addEventListener("online", flush);
    const timer = window.setInterval(flush, 15_000);
    return () => { active=false;window.removeEventListener("online", flush); window.clearInterval(timer); };
  }, [sessionState, identity?.subjectId]);

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

  const act = async (action: "accept" | "decline" | "on_the_way" | "arrived" | "start_service" | "add_proof" | "complete" | "training_accept" | "training_on_the_way") => {
    if (!selected || busy || lifecycleLock.current || pendingStatus) return;
    if(action==="start_service"&&!checklistComplete("before",selectedChecks)){setError("Complete the before-service checklist first.");setTab("jobs");return;}
    if((action==="complete"||action==="add_proof")&&!checklistComplete("after",selectedChecks)){setError("Complete the after-service checklist first.");setTab("jobs");return;}
    lifecycleLock.current = true;
    setBusy(true);
    setError("");
    try {
      if (["on_the_way","arrived","start_service","complete"].includes(action)) {
        await statusQueue.queue({bookingId:selected.bookingId,action:action as "on_the_way"|"arrived"|"start_service"|"complete",checklist:selectedChecks});
      } else if (action === "training_accept" || action === "training_on_the_way") {
        if (!selected.trainingSessionId) throw new Error("Canonical Training session is missing");
        const trainingAction = action === "training_accept" ? "accept" : "on_the_way";
        const response = await fetch("/api/training-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: selected.trainingSessionId, action: trainingAction, idempotencyKey: `partner-app:${selected.trainingSessionId}:${trainingAction}:${Date.now()}` }) });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to update Training session");
      } else if ((action === "accept" || action === "decline") && selected.providerModel === "commission") {
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
          input.checklist = selectedChecks;
          input.completionNotes = "Approved service photos recorded from Partner app";
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

  // What this partner actually collects in cash/UPI at the door: the booked total, and only while the
  // booking is pay-after-service and nothing has been captured yet.
  const collectAtDoor = selected && selected.payment.mode === "pay_after_service" && !SETTLED_PAYMENT_STATUSES.includes(selected.payment.status)
    ? Number(selected.payment.amount || selected.totalAmount || 0)
    : 0;

  // paymentRequestView reports a settled payment through paymentStatus and an elapsed link through
  // status==="expired". They need different copy: one is finished, the other needs a replacement link.
  const paymentSettled = Boolean(paymentRequest && SETTLED_PAYMENT_STATUSES.includes(paymentRequest.paymentStatus));
  const paymentExpired = Boolean(paymentRequest && paymentRequest.status === "expired");

  // Both engagement shapes set the top-level totals; `computed` carries netPayout for contract and
  // commissionAmount for commission, so it is only ever a fallback here.
  const isCommission = engagement === "commission";
  const earningsNetPayout = Number(earnings?.netPayout ?? earnings?.computed?.netPayout ?? earnings?.computed?.commissionAmount ?? 0);
  const earningsOrders = Number(earnings?.orders ?? earnings?.computed?.orders ?? 0);
  const earningsGross = Number(earnings?.grossOrderValue ?? earnings?.computed?.grossOrderValue ?? 0);

  const openJob = (job: Job, target: Tab = "jobs") => { setSelectedId(job.bookingId); setTab(target); };

  // Both handlers only ask the server to change the session, then re-run the identity check above.
  // Nothing here decides locally that the partner is signed out or has become someone else. They
  // share one busy guard: a sign-out and a switch in flight together could revoke the session the
  // switch just issued, or leave the switch's new session behind after the sign-out.
  const accountBusy = signingOut || switching;
  // Every piece of per-account state is dropped when the session changes hands, so the next partner
  // never sees the previous one's jobs, earnings, payment request or media before their own loads.
  const resetAccountState = () => {
    setIdentity(null); setJobs([]); setSelectedId(""); setTab("home"); setOperationResult(null); setOperationBusy(false);
    setPaymentRequest(null); setPaymentPollKey(0); setEarnings(null); setMediaMessage(""); setMediaAssets([]); setMediaAssetsError(""); setMediaPollKey(0);
    setBusy(false); setRefreshKey(0); lifecycleLock.current = false;
    // The workspace state that arrives with the earnings payload belongs to the same account and is
    // dropped with it. pendingProof names the previous partner's BOOKING IDS, so leaving it behind
    // would carry one partner's work onto the next partner's screen - on the UAT provider switch
    // just as much as on sign-out, which is why it lives in this shared reset.
    setEarningsNotice(""); setEngagement(""); setWorkspaceState({ onboardingStatus: "", liveness: null, pendingProof: [] });
  };
  const signOut = async () => {
    if (accountBusy) return;
    sessionVersion.current += 1;
    setSigningOut(true); setError(""); setSessionState("revoking");
    // Purge every provider-owned client projection before the network round-trip. This immediately
    // unmounts jobs, GPS and proof controls, aborting child telemetry, with no stale-account flash.
    resetAccountState();
    try {
      const [response] = await Promise.all([fetch("/api/identity-session", { method: "DELETE", credentials:"same-origin", headers: { "content-type": "application/json" } }), clearProviderProofQueue()]);
      if (!response.ok && response.status !== 401) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || "Unable to sign out"); }
      // The server decides what this device is now: the identity check re-runs and opens the gate on its refusal.
      setSessionState("checking"); setIdentityKey((value) => value + 1);
    } catch (problem) { setError(`${problem instanceof Error ? problem.message : "Unable to sign out"}. Retry session revocation before signing in again.`); setSessionState("revocation_failed"); }
    finally { setSigningOut(false); }
  };
  const switchUatProvider = async () => {
    if (accountBusy) return;
    if (!uatProviderId) { setError("Choose the UAT provider to switch to"); return; }
    setSwitching(true); setError("");
    try {
      const response = await fetch("/api/uat-provider-switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: uatProviderId, code: uatCode }) });
      const body = await response.json().catch(() => ({})) as { data?: { providerId?: string }; error?: string };
      if (!response.ok || !body.data?.providerId) throw new Error(body.error || "Unable to switch UAT provider");
      // The previous provider's in-flight reads must not land on the new session, and their queued proofs must not follow it.
      sessionVersion.current += 1;
      setUatCode(""); resetAccountState(); await clearProviderProofQueue();
      setSessionState("checking"); setIdentityKey((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to switch UAT provider");
    } finally {
      setSwitching(false);
    }
  };

  // No verified provider session: the dashboard is not rendered at all. Sign-in is the same OTP
  // transport the onboarding flow uses (/api/partner-otp issues the provider session cookie), and a
  // successful verification only re-runs the server identity check above.
  if (sessionState !== "verified") return <main className={styles.viewport}>
    <section className={styles.phoneShell}>
      <header className={styles.appHeader}>
        <div className={styles.brand}><span>paw</span><b>space</b><small>PARTNER</small></div>
        <div className={styles.identityPill}><i>{sessionState === "checking" ? "…" : "!"}</i><span>{sessionState === "checking" ? "Checking" : "Sign in"}</span></div>
      </header>
      <section className={styles.content} aria-label="Partner sign-in">
        {sessionState === "checking" || sessionState === "revoking" || sessionState === "revocation_failed"
          ? sessionState === "revocation_failed" ? <><div className={styles.error} role="alert">{error}</div><button type="button" className={styles.secondary} onClick={() => void signOut()}>Retry session revocation</button></> : <p role="status" className={styles.empty}>{sessionState === "revoking" ? "Ending your partner session and clearing this device…" : "Checking your partner session…"}</p>
          : <>
            <PartnerLogin eyebrow="🐾 PawSpace Partner" title="Sign in to your Partner app"
              description="Verify your registered phone number to open your jobs, GPS and earnings. Nothing on this screen is available without a verified provider session."
              onLoggedIn={() => { sessionVersion.current+=1;setError(""); setSessionState("checking"); setIdentityKey((value) => value + 1); }} />
            <p className={styles.empty}>New to PawSpace? <Link href="/partner/onboarding">Start your caregiver application</Link> first; the same phone number signs you in here once your profile exists.</p>
          </>}
      </section>
    </section>
  </main>;

  return <main className={styles.viewport}>
    <span hidden aria-hidden="true">TEST TRANSACTION ENGINE</span>
    <span hidden aria-hidden="true">LIVE CUSTOMER PROFILE</span>
    <section className={styles.phoneShell}>
      <header className={styles.appHeader}>
        <div className={styles.brand}><span>paw</span><b>space</b><small>PARTNER</small></div>
        <div className={styles.headerAccount}>
          <button type="button" className={styles.identityPill} onClick={() => setTab("more")} aria-label="Account, switch provider and sign out"><i>✓</i><span>{identity?.subjectId ? "Verified" : "Checking"}</span><em>›</em></button>
          {identity?.subjectId && <button type="button" className={styles.headerSignOut} onClick={() => void signOut()} disabled={accountBusy}>{signingOut ? "Signing out…" : "Sign out"}</button>}
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {identity?.subjectId && <section className={styles.notice} aria-live="polite"><b>{statusQueue.connection==="Online"?"🟢":statusQueue.connection==="Offline"?"🔴":"🟠"} {statusQueue.connection}</b>{statusQueue.connection!=="Online"&&<p>Connection lost — reconnecting…</p>}{dutyJob&&<><h2>You are ON DUTY</h2><p>{trackingNotice}</p></>}{statusQueue.pending.length>0&&<><p>{statusQueue.pending.length} update(s) saved on this device, awaiting server confirmation.</p>{statusQueue.pending.map(item=><p key={item.id}>{label(item.action)} · {item.error||"Will sync automatically when connected"}</p>)}<button onClick={statusQueue.retry}>Retry saved updates</button></>}{statusQueue.error&&<p role="alert">{statusQueue.error}</p>}</section>}

        {tab === "home" && !dutyJob && <>
          <div className={styles.greeting}><div><small>PAWSPACE PARTNER MOBILE</small><h1>{providerName}</h1><p>{identity?.roleCode ? label(identity.roleCode) : "Identity-scoped UAT workspace"}</p></div><button aria-label="Refresh jobs" disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>

          <section className={styles.heroCard}>
            <div className={styles.heroTop}><span>NEXT ASSIGNMENT</span>{selected && <em>{label(selected.status)}</em>}</div>
            {selected ? <>
              <h2>{selected.packageName}</h2>
              <p>{selected.pets.map((pet) => pet.name).join(", ")} · {selected.zoneId}</p>
              <div className={styles.heroMeta}><span>◷ {when(selected.scheduledStart)}</span><span>◉ {selected.customer.name}</span></div>
              <div className={styles.primaryActions}>
                {nextAction && <button disabled={busy||pendingStatus||(nextAction==="start_service"&&!checklistComplete("before",selectedChecks))||((nextAction==="complete"||nextAction==="add_proof")&&!checklistComplete("after",selectedChecks))} onClick={() => void act(nextAction)}>{busy ? "Updating…" : actionLabel}</button>}
                <button className={styles.secondary} onClick={() => openJob(selected, "jobs")}>{isTraining ? "Open training session" : canTrack ? "Open GPS" : "View job"}</button>
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

          <section className={styles.safetyCard}><b>Location privacy</b><p>Location sharing begins during an accepted job and stops when it ends. The native partner app supports background location with permission; browsers must remain open.</p></section>
        </>}

        {(tab === "jobs" || (tab === "home" && dutyJob)) && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>CANONICAL WORK ORDERS</small><h1>{tab==="home"?"Your active job":"My jobs"}</h1></div><button disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>
          {jobs.length === 0 && !error && <div className={styles.empty}>No canonical jobs assigned to this provider yet.</div>}
          {tab!=="home"&&<div className={styles.jobList}>{jobs.map((job) => <button key={job.bookingId} className={selected?.bookingId === job.bookingId ? styles.jobSelected : ""} onClick={() => setSelectedId(job.bookingId)}><div><small>{when(job.scheduledStart)}</small><strong>{job.packageName}</strong><span>{job.pets.map((pet) => pet.name).join(", ")} · {job.customer.name}</span></div><em>{label(job.status)}</em></button>)}</div>}
          {selected && <section className={styles.detailCard}>
            <div className={styles.detailHead}><div><small>BOOKING {selected.bookingId}</small><h2>{selected.packageName}</h2></div><span>{label(selected.status)}</span></div>
            {isGroomerOnDuty(selected)&&<GroomingRouteCard bookingId={selected.bookingId} providerId={selected.providerId} managedTracking/>}
            <div className={styles.primaryActions}>{nextAction&&<button disabled={busy||pendingStatus||(nextAction==="start_service"&&!checklistComplete("before",selectedChecks))||((nextAction==="complete"||nextAction==="add_proof")&&!checklistComplete("after",selectedChecks))} onClick={()=>void act(nextAction)}>{busy?"Updating…":actionLabel}</button>}</div>
            <div className={styles.detailGrid}>
              <div><small>Customer</small><b>{selected.customer.name}</b><span>{selected.customer.maskedPhone}</span></div>
              <div><small>Pets</small><b>{selected.pets.map((pet) => pet.name).join(", ")}</b><span>{selected.pets.map((pet) => pet.breed).filter(Boolean).join(", ")}</span></div>
              <div><small>Time</small><b>{when(selected.scheduledStart)}</b><span>to {when(selected.scheduledEnd)}{selected.occurrenceCount > 1 ? ` · visit 1 of ${selected.occurrenceCount}` : ""}</span></div>
              {/* The mode alone never said how much money was involved. The two amounts are NOT
                  interchangeable: amount_due_now is what the customer owed ONLINE at booking, which the
                  flow sets to 0 for pay_after_service - precisely the case where the partner collects.
                  So the door figure is payment.amount, and amountDueNow is only ever a prepaid note. */}
              <div><small>Payment</small><b>{label(selected.payment.mode)}</b><span>{label(selected.payment.status)}{collectAtDoor > 0 ? ` · collect ${money(collectAtDoor)}` : selected.payment.amountDueNow > 0 ? ` · ${money(selected.payment.amountDueNow)} due online` : ""}</span></div>
              <div><small>Where</small><b>{selected.zoneId}</b><span>{selected.cityId}</span></div>
              <div><small>Package</small><b>{selected.packageName}</b><span>{selected.subscription ? `${label(selected.subscription)} plan` : money(selected.totalAmount)}</span></div>
            </div>
            {!isTraining&&["arrived","in_service"].includes(selected.status)&&<fieldset className={styles.notice} disabled={busy||pendingStatus}><legend>{selected.status==="arrived"?"Before-service checklist":"After-service checklist"}</legend>{(selected.status==="arrived"?BEFORE_SERVICE:AFTER_SERVICE).map(item=><label key={item.id} style={{display:"flex",alignItems:"start",gap:10,padding:"10px 0"}}><input type="checkbox" checked={selectedChecks.includes(item.id)} onChange={()=>toggleCheck(item.id)}/>{item.label}</label>)}{selected.status==="in_service"&&<p>Upload the required before and after photos below. Upload times are recorded. Ops approval is required before completion.</p>}</fieldset>}
            {selected.pets.map(pet=><section key={pet.id} className={styles.notice}><b>{pet.name} · Behaviour, medical & safety</b><p>{pet.safetyNotes?.length?pet.safetyNotes.join(" · "):"No safety notes recorded — verify with the customer before starting."}</p><small>Vaccination: {label(pet.vaccinationStatus)}</small></section>)}
            {/* Projected by the route out of the booking's pricing_json and, until now, discarded by the
                client: the handling requirements recorded against this pet and the add-ons the partner is
                expected to perform. Driving to a job without either is the gap this closes. */}
            {!!selected.safetyRequirements.length && <section className={styles.notice} aria-label="Handling requirements"><b>Handling requirements</b><ul>{selected.safetyRequirements.map(item => <li key={item}>{label(item)}</li>)}</ul></section>}
            {!!selected.addOns.length && <div className={styles.proof}><b>Add-ons booked</b><span>{selected.addOns.map(label).join(" · ")}</span></div>}
            {/* The lifecycle timeline the route already sanitizes for providers. Only the event type and
                its timestamp are shown: detail_json is filtered server-side, but there is no reason to
                render free-form detail on a partner's phone at all. */}
            {!!selected.events.length && <section className={styles.notice} aria-label="Job activity"><b>Recent activity</b><ul>{selected.events.slice(0, 5).map((event, index) => <li key={`${event.occurredAt}-${index}`}>{label(event.eventType)}{whenMs(event.occurredAt) ? ` · ${whenMs(event.occurredAt)}` : ""}</li>)}</ul></section>}
            {isTraining ? <section className={styles.notice}><b>Training session</b><p>Session {selected.training?.sequenceNo ?? 1} of {selected.training?.totalSessions ?? 1} · {selected.training?.completedSessions ?? 0} completed · programme {label(selected.training?.programmeStatus || selected.status)}</p>{Boolean(selected.training?.requirements?.length) && <small>Goals: {selected.training?.requirements.join(", ")}</small>}<p>Trainer-specific session report, owner handover and secure evidence remain governed by the Training lifecycle before completion.</p></section> : <div className={styles.proof}><b>Service proof</b><span>{selected.proof ? `${selected.proof.beforePhotoRef ? "Before ✓" : "Before —"} · ${selected.proof.afterPhotoRef ? "After ✓" : "After —"} · Checklist ${selected.proof.checklist.length}${whenMs(selected.proof.updatedAt) ? ` · updated ${whenMs(selected.proof.updatedAt)}` : ""}` : "Not captured yet"}</span>{selected.invoice && <small>Invoice {selected.invoice.invoiceNumber} · {money(selected.invoice.netAmount)}{whenMs(selected.invoice.issuedAt) ? ` · issued ${whenMs(selected.invoice.issuedAt)}` : ""}</small>}</div>}

            {proofStage && <section className={styles.notice} aria-label="Service proof photos"><b>Secure before / after proof</b><p>Choose real UAT images. Each photo is uploaded, verified against its upload grant, then approved by Ops (a second person) before it counts as service proof.</p>
              {(["before_service", "after_service"] as const).map(purpose => { const status = describeProof(mediaAssets, purpose); const name = purpose === "before_service" ? "Before" : "After"; return <div key={purpose} className={styles.proof}><b>{name} photo</b><span>{status.text}</span>{status.state !== "approved" && status.state !== "pending" && <label>{status.state === "missing" ? `${name} photo` : `Replacement ${name.toLowerCase()} photo`} <input type="file" aria-label={`${name} photo`} accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void prepareMedia(file, purpose); }} /></label>}</div>; })}
              <div className={styles.primaryActions}><button type="button" disabled={busy} onClick={() => setMediaPollKey(value => value + 1)}>Refresh proof status</button></div>
              {bothApproved && <p><b>Both photos approved.</b> Tap “Add service proof” below, then “Complete job”.</p>}
              {mediaAssetsError && <p role="alert">{mediaAssetsError}</p>}{mediaMessage && <p>{mediaMessage}</p>}</section>}
            {!isTraining && selected.status === "completed" && selected.payment.mode === "pay_after_service" && !SETTLED_PAYMENT_STATUSES.includes(selected.payment.status) && <section className={styles.notice}>
              <b>Payment due after service</b>
              {!paymentRequest ? <>
                <p>Create a collectable Razorpay sandbox payment link and QR payload. This does not capture money.</p>
                <button disabled={busy} onClick={() => void requestPayment()}>Create payment request</button>
              </> : <>
                <p><b>{money(paymentRequest.amount)}</b> · {label(paymentRequest.status)}</p>
                {paymentRequest.collectable ? <>
                  <p><a href={paymentRequest.paymentPath} target="_blank" rel="noreferrer">Open sandbox checkout</a></p>
                  <p><code>{paymentRequest.qrPayload}</code></p>
                  {whenMs(paymentRequest.expiresAt) && <small>Collectable until {whenMs(paymentRequest.expiresAt)}.</small>}
                </> : paymentSettled ? <p>This payment is already {label(paymentRequest.paymentStatus)} against the canonical payment record, so no further collection is due.</p>
                  : <>
                    {/* The expired branch used to say "create a governed replacement request" while the
                        only create button lived in the !paymentRequest branch above - so the instruction
                        named an action the screen did not offer. createPostServicePaymentRequest already
                        issues a replacement once the old link has expired; this is that call. */}
                    <p>{paymentExpired ? `This payment link expired${whenMs(paymentRequest.expiresAt) ? ` on ${whenMs(paymentRequest.expiresAt)}` : ""}.` : "This payment request is no longer collectable."} A governed replacement link can be issued for the same booking.</p>
                    <div className={styles.primaryActions}>
                      <button disabled={busy} onClick={() => void requestPayment()}>{busy ? "Working…" : "Create replacement payment request"}</button>
                      <button type="button" disabled={busy} onClick={() => setPaymentPollKey(current => current + 1)}>Refresh payment status</button>
                    </div>
                  </>}
                <small>Razorpay ref {paymentRequest.providerReference}. {paymentRequest.liveCapture ? "Capture is live." : "Sandbox only - no live capture."} Payment remains unpaid until a signature-verified gateway capture is reconciled.</small>
              </>}
            </section>}
            {!isTraining && <section className={styles.notice}>
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
            </section>}
            <div className={styles.primaryActions}>{nextAction && <button disabled={busy||pendingStatus||(nextAction==="start_service"&&!checklistComplete("before",selectedChecks))||((nextAction==="complete"||nextAction==="add_proof")&&!checklistComplete("after",selectedChecks))} onClick={() => void act(nextAction)}>{busy ? "Updating…" : actionLabel}</button>}{canTrack && <button className={styles.secondary} onClick={() => setTab("tracking")}>GPS & route</button>}{canDecline && <button className={styles.danger} disabled={busy} onClick={() => void act("decline")}>Decline</button>}</div>
          </section>}
        </>}

        {tab === "tracking" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>ACTIVE JOB LOCATION</small><h1>GPS & ETA</h1></div><button disabled={!identity?.subjectId} title={!identity?.subjectId ? "Verified provider sign-in required to refresh jobs" : "Refresh jobs"} onClick={() => setRefreshKey((value) => value + 1)}>↻</button></div>
          {activeJobs.length > 1 && <div className={styles.selector}>{activeJobs.map((job) => <button key={job.bookingId} className={selected?.bookingId === job.bookingId ? styles.selectorActive : ""} onClick={() => setSelectedId(job.bookingId)}>{job.pets[0]?.name || job.packageName}<small>{label(job.status)}</small></button>)}</div>}
          {!selected && <div className={styles.empty}>No assigned job is available for tracking.</div>}
          {selected && !canTrack && <section className={styles.notice}><b>GPS is not active yet</b><p>This booking is currently <strong>{label(travelState)}</strong>. Accept the job and start the journey before location sharing can begin.</p><button onClick={() => setTab("jobs")}>Open job</button></section>}
          {selected && isTraining && <section className={styles.notice}><b>Training GPS uses the Training lifecycle</b><p>Open the Training job to accept the session and start the journey. Arrival geofence and session evidence are enforced by the Training session API; the Grooming route card is intentionally not used for trainers.</p><button onClick={() => setTab("jobs")}>Open training session</button></section>}
          {selected && !isTraining && canTrack && <><section className={styles.trackingSummary}><span>Tracking booking</span><h2>{selected.pets.map((pet) => pet.name).join(", ")} · {selected.packageName}</h2><p>{selected.customer.name} · {selected.zoneId}</p></section><GroomingRouteCard bookingId={selected.bookingId} providerId={selected.providerId} managedTracking={Boolean(dutyJob?.bookingId===selected.bookingId)} /></>}
        </>}

        {tab === "earnings" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>PARTNER FINANCE</small><h1>Earnings</h1></div><span /></div>
          <section className={styles.financeHero}><i>₹</i><h2>Settlement-controlled earnings</h2><p>This mobile screen never invents payout figures from booking prices. Provider earnings appear only from the canonical settlement and commission ledger after Finance controls are satisfied.</p></section>
          {earningsNotice && <section className={styles.notice} role="status"><b>Earnings are not shown yet</b><p>{earningsNotice}</p></section>}
          {/* The shift-liveness gate, the onboarding link state and outstanding proof: all three arrive
              with the earnings payload and none of them used to be shown anywhere.
              The gate only RETURNS required:true after its own "no matched check" throw, so matched is
              true on every value that gets here - an unmatched gate arrives as the governed 428, which
              the shell's error banner shows on every tab. The reachable state to render is the pass. */}
          {workspaceState.liveness?.required && workspaceState.liveness.matched && <section className={styles.notice} role="status"><b>Shift liveness matched</b><p>Your live selfie was matched against your verified onboarding profile{workspaceState.liveness.shiftDate ? ` for ${workspaceState.liveness.shiftDate}` : ""}, so today&rsquo;s schedule is open.</p></section>}
          {workspaceState.onboardingStatus && workspaceState.onboardingStatus !== "active" && <section className={styles.notice} role="status"><b>Onboarding is {label(workspaceState.onboardingStatus)}</b><p>Settlement and payout states stay withheld until your partner profile is active.</p><Link href="/partner/onboarding">Open onboarding &amp; documents</Link></section>}
          {!!workspaceState.pendingProof.length && <section className={styles.notice} role="status"><b>Service proof still outstanding</b><ul>{workspaceState.pendingProof.map(item => <li key={item.bookingId}>{item.bookingId} · {label(item.serviceCode)} — missing {item.missing.map(label).join(", ")}</li>)}</ul><p>A completed job without its required proof holds up the settlement for that booking.</p></section>}
          {earnings && earnings.visible !== false && <>
            <div className={styles.financeRows}><article><div><b>{isCommission ? "Commission earned" : "Computed net payout"}</b><small>Governed payout computations only</small></div><strong>{money(earningsNetPayout)}</strong></article><article><div><b>Computed orders</b><small>Not raw completed booking value</small></div><strong>{earningsOrders}</strong></article><article><div><b>Gross order value</b><small>{isCommission ? "What the commission is computed from" : "Order value behind the payout"}</small></div><strong>{money(earningsGross)}</strong></article><article><div><b>Live money</b><small>Production payout rail</small></div><strong>OFF</strong></article></div>
            {(earnings.settlements ?? []).map(item => <section key={item.bookingId} className={styles.notice}><b>{item.bookingId} · {label(item.status)}</b><p>{item.payoutAmount == null ? "Payout amount pending an approved rule" : money(item.payoutAmount)}</p><small>{item.reason}</small></section>)}
            {(earnings.incentives ?? []).map(item => <section key={item.monthStart} className={styles.notice}><b>{item.monthStart} incentive · {label(item.status)}</b><p>Head {money(item.headTotal)} · helper {money(item.helperTotal)} · achievement value {money(item.monthTotal)}</p></section>)}
            {/* The commission ledger and its payout states: returned by providerWorkspace for every
                commission partner and, until now, rendered nowhere at all. */}
            {(earnings.commissionOrders ?? []).map(item => <section key={item.bookingId} className={styles.notice}><b>{item.bookingId} · {label(item.serviceCode)} · {label(item.status)}</b><p>Commission {money(item.commissionAmount)} on an order of {money(item.orderAmount)}</p><small>{label(item.commissionMode)} rate{item.dueAt ? ` · due ${whenMs(item.dueAt)}` : ""}</small></section>)}
            {(earnings.payouts ?? []).map(item => <section key={item.id} className={styles.notice}><b>Payout {money(item.amount)} · {label(item.status)}</b><p>Booking {item.bookingId}{item.dueAt ? ` · due ${whenMs(item.dueAt)}` : ""}</p>{item.providerReference && <small>Reference {item.providerReference}</small>}</section>)}
            {earnings.note && <p className={styles.note}>{earnings.note}</p>}
          </>}
          <p className={styles.note}>Booking value is deliberately not shown as partner earnings. Payout instructions remain sandbox-only in this UAT candidate.</p>
        </>}

        {tab === "more" && <>
          <div className={styles.pageHead}><button onClick={() => setTab("home")}>‹</button><div><small>PARTNER ACCOUNT</small><h1>More</h1></div><span /></div>
          <section className={styles.profileCard}><div className={styles.avatar}>{providerName.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><h2>{providerName}</h2><p>{identity?.subjectId || "Provider identity pending"}</p><span>{identity?.roleCode ? label(identity.roleCode) : "provider"}</span></div></section>
          <div className={styles.menuList}><Link href="/partner/onboarding"><i>✓</i><span><b>Onboarding & documents</b><small>Identity-scoped self-service</small></span><em>›</em></Link><button onClick={() => setTab("jobs")}><i>▣</i><span><b>Bookings & service proof</b><small>Canonical work orders</small></span><em>›</em></button><button onClick={() => setTab("tracking")}><i>⌖</i><span><b>GPS, route & ETA</b><small>Foreground location controls</small></span><em>›</em></button><button onClick={() => setTab("earnings")}><i>₹</i><span><b>Earnings & settlement</b><small>No live payout</small></span><em>›</em></button><Link href="/partner"><i>?</i><span><b>Partner help & account</b><small>Canonical provider portal</small></span><em>›</em></Link><button type="button" onClick={() => void signOut()} disabled={accountBusy}><i>⎋</i><span><b>{signingOut ? "Signing out…" : "Sign out / switch partner"}</b><small>Ends this session; the next partner enters their own phone and OTP</small></span><em>›</em></button></div>
          {!uatProviders && uatRosterError && <p role="status" className={styles.empty}>Switch UAT provider is unavailable right now: {uatRosterError}</p>}
          {uatProviders && <section className={styles.uatSwitch} aria-label="Switch UAT provider">
            <b>Switch UAT provider</b>
            <p>Staging only. Open this app as any live provider in the seeded roster - a groomer, a trainer, a host - with the UAT access code. Job lists and lifecycle actions in this app are grooming work orders; other verticals sign in but see their jobs elsewhere.</p>
            <label>Provider<select value={uatProviderId} onChange={(event) => setUatProviderId(event.target.value)}>
              <option value="">Choose a provider…</option>
              {uatProviders.map((provider) => <option key={provider.id} value={provider.id} disabled={provider.id === identity?.subjectId}>{provider.name} · {provider.services.map((service) => label(service)).join(", ")}{provider.id === identity?.subjectId ? " (current)" : ""}</option>)}
            </select></label>
            <label>UAT access code<input type="password" autoComplete="off" value={uatCode} onChange={(event) => setUatCode(event.target.value)} placeholder="Same code as /staging-login" /></label>
            <button type="button" onClick={() => void switchUatProvider()} disabled={accountBusy || !uatProviderId || !uatCode}>{switching ? "Switching…" : "Switch provider"}</button>
          </section>}
          <section className={styles.safetyCard}><b>UAT boundary</b><p>This mobile app uses verified provider identity and canonical work orders. It cannot self-activate a provider, expose unmasked customer phone numbers, or make live payouts. Background location requires the native partner app and device permission.</p></section>
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
