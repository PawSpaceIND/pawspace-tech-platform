"use client";
import { apiErrorMessage } from "../../../lib/api-error-message";
import Link from "next/link";
import { useEffect, useState } from "react";
import PartnerLogin, { type LoggedInProvider } from "../partner-login";
import styles from "./onboarding.module.css";
import shell from "../../components/marketing/premium-marketing.module.css";

type Row = Record<string, unknown>;
type Snapshot = {
  providerId?: string;
  applications?: Array<{
    application?: Row;
    documents?: Row[];
    verification?: Row | null;
    attempt?: Row | null;
    quiz?: Row | null;
    interview?: Row | null;
    agreement?: Row | null;
    agreementContent?: Row | null;
    profile?: Row | null;
    media?: Row[];
  }>;
  productionReady?: boolean;
  marketplaceLive?: boolean;
  orderEligible?: boolean;
  agreementAcceptance?: { mode?: string; action?: string; available?: boolean };
};

const MEDIA_TYPES = [
  { value: "provider_photo", label: "A photo of you" },
  { value: "home_photo", label: "Your home" },
  { value: "facility_photo", label: "Your facility" },
  { value: "business_photo", label: "Your business" },
  { value: "reference", label: "A reference" },
] as const;

/** Read a picked file as the base64 the secure upload boundary expects. */
function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read. Try choosing it again."));
    reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^;]+;base64,/, ""));
    reader.readAsDataURL(file);
  });
}

const text = (v: unknown) => String(v ?? "");

/**
 * Exactly which controls this screen offers for a given snapshot. [W2-F]
 *
 * Exported so a test can ask the SCREEN what an applicant can do at each point of the funnel, with a
 * snapshot the real route produced, instead of re-deciding it. Every one of these was previously
 * absent or wrong: there was no document control at all (so nobody could submit), no media control
 * (so a policy that required a photo could never be satisfied), the agreement action was hard-coded to
 * the UAT one (so a production applicant could not accept), and after activation the only control
 * still posted `save_profile`, which records no reason and flags nothing for review.
 */
export function partnerOnboardingControls(data: Snapshot | null) {
  const current = data?.applications?.[0];
  const app = current?.application;
  const status = text(app?.status);
  const agreementAccepted = text(current?.agreement?.status) === "accepted";
  const approvedAndAccepted = text(app?.human_decision) === "approved" && agreementAccepted;
  return {
    canStartApplication: !current,
    canUploadDocument: Boolean(current) && status === "draft",
    canSubmit: Boolean(current) && status === "draft",
    canTakeQuiz: Array.isArray(current?.quiz?.questions) && (current?.quiz?.questions as unknown[]).length > 0,
    canAcceptAgreement: text(current?.agreement?.status) === "awaiting_acceptance",
    acceptAction: text(data?.agreementAcceptance?.action) || "accept_sla_uat",
    acceptAvailable: data?.agreementAcceptance?.available !== false,
    canSaveProfile: approvedAndAccepted,
    canAddMedia: approvedAndAccepted,
    canEditActivatedProfile: ["activated_uat", "post_activation_review"].includes(status),
  };
}
const STEPS = ["Application", "Verification", "Qualification", "Interview", "Agreement", "Profile", "Activation"];

export default function PartnerOnboardingUatPage() {
  const [session, setSession] = useState<Row | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", displayName: "", businessName: "", bio: "", providerModel: "commission", workEmail: "" });
  const [docType, setDocType] = useState("government_id");
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");
  const [uploading, setUploading] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [mediaType, setMediaType] = useState<string>("provider_photo");
  const [editReason, setEditReason] = useState("");

  /*
   * Document upload, for real. [W2-F]
   *
   * This button was hard-disabled behind "Document upload isn't available yet - it needs dedicated
   * secure file storage to be provisioned first". That was no longer true: `upload_document` on
   * /api/provider-onboarding-self-service puts the bytes through storeProviderDocumentSecurely into
   * the private PAWSPACE_MEDIA_BUCKET, which stage-config.mjs and prod-config.mjs both bind, and it
   * verifies magic bytes, size and MIME before it writes anything. Meanwhile the active onboarding
   * policy requires a government_id, and transitionProviderApplication("submit") refuses without one -
   * so the disabled button was the first hard stop in the funnel: no applicant could submit at all.
   */
  async function uploadDocument(kind: "document" | "media", file: File | null | undefined) {
    if (!file || !appId) return;
    setUploading(kind);
    setError("");
    setUploadNotice("");
    try {
      const fileBase64 = await fileToBase64(file);
      /* Both actions take the bytes; the server stores them and keeps the only file reference. */
      const payload = kind === "document"
        ? { action: "upload_document", applicationId: appId, documentType: docType, mimeType: file.type, fileBase64 }
        : { action: "add_profile_media", applicationId: appId, mediaType, mimeType: file.type, fileBase64 };
      const r = await fetch("/api/provider-onboarding-self-service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(await apiErrorMessage(r));
      setUploadNotice(kind === "document" ? "Uploaded. Our team will check it." : "Photo added to your profile.");
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setUploading("");
    }
  }

  async function draftBioWithAi() {
    setBioBusy(true);
    setBioError("");
    try {
      const r = await fetch("/api/provider-onboarding-self-service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "generate_profile_bio_ai", verticalKey: text(app?.vertical_key) || form.verticalKey, cityCode: text(app?.city_code) || form.cityCode, displayName: form.displayName, businessName: form.businessName }) });
      const b = await r.json() as { bio?: string; error?: string; connected?: boolean };
      if (!r.ok) throw new Error(b.error || "Unable to draft a bio right now");
      setForm(f => ({ ...f, bio: b.bio || "" }));
    } catch (e) {
      setBioError(e instanceof Error ? e.message : "Unable to draft a bio right now");
    } finally {
      setBioBusy(false);
    }
  }

  function refresh() {
    return fetch("/api/provider-onboarding-self-service", { cache: "no-store" }).then(async r => { if (!r.ok) throw new Error(await apiErrorMessage(r)); return r.json(); }).then(v => setData(v.data));
  }

  useEffect(() => {
    let active = true;
    fetch("/api/identity-session", { cache: "no-store" })
      .then(async r => { if (!r.ok) return null; return r.json(); })
      .then(v => {
        if (!active) return;
        setSessionChecked(true);
        if (!v) return;
        setSession(v.data);
        // Only a provider identity session (partner OTP) can read/onboard here. A leftover customer
        // session must NOT attempt the provider snapshot — it would 403; we route them to partner login.
        if (text(v.data?.subjectType) !== "provider") return;
        return fetch("/api/provider-onboarding-self-service", { cache: "no-store" });
      })
      .then(async r => { if (!r) return; if (!r.ok) throw new Error(await apiErrorMessage(r)); return r.json(); })
      .then(v => { if (active && v) setData(v.data); })
      .catch(e => { if (active) setError(String((e as Error)?.message || e)); });
    return () => { active = false; };
  }, []);

  function onLoggedIn(provider: LoggedInProvider) {
    setSession({ subjectType: "provider", roleCode: "service_provider", subjectId: provider.providerId, identitySource: "partner_otp" });
    void refresh();
  }

  async function post(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/provider-onboarding-self-service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      /* The body is JSON like {"error":"..."}. Printing it raw showed a caregiver a brace-wrapped
       * blob with no idea what to do; take the message out of it, and never show the envelope. */
      if (!r.ok) throw new Error(await apiErrorMessage(r));
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const current = data?.applications?.[0];
  const app = current?.application;
  const appId = text(app?.id);
  const questions = Array.isArray(current?.quiz?.questions) ? current?.quiz?.questions as Row[] : [];
  const agreementAccepted = text(current?.agreement?.status) === "accepted";
  const approvedAndAccepted = text(app?.human_decision) === "approved" && agreementAccepted;
  const controls = partnerOnboardingControls(data);
  const activated = controls.canEditActivatedProfile;
  const acceptance = { action: controls.acceptAction, available: controls.acceptAvailable };

  let stepIndex = 0;
  if (current) stepIndex = 1;
  if (text(current?.verification?.status) === "verified") stepIndex = 2;
  if (questions.length && text(app?.quiz_status) === "completed") stepIndex = 3;
  if (current?.interview) stepIndex = 4;
  if (current?.agreement) stepIndex = 5;
  if (agreementAccepted) stepIndex = 6;
  if (approvedAndAccepted) stepIndex = 6;

  if (!sessionChecked) return <main className={styles.page} />;

  // Onboarding is provider-only: every /api/provider-onboarding-self-service call requires a provider
  // identity session (partner OTP). A brand-new applicant arrives with no session, or with a leftover
  // customer session that does not own a provider scope — both must complete partner login first, or
  // the very first "create_application" call is refused ("does not own this customer/provider scope").
  const isProviderSession = text(session?.subjectType) === "provider";
  if (!isProviderSession) {
    return (
      <main className={styles.page}>
        <div className={styles.topBar}>
          <Link className={styles.brand} href="/discover">🐾 PawSpace</Link>
          <Link className={styles.backLink} href="/careers">← Back to Careers</Link>
        </div>
        {session ? <p className={styles.errorBox} role="status">You&apos;re signed in with a customer account. Verify your partner phone number below to start your caregiver application.</p> : null}
        <PartnerLogin onLoggedIn={onLoggedIn} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.topBar}>
        <Link className={styles.brand} href="/discover">🐾 PawSpace</Link>
        <Link className={styles.backLink} href="/careers">← Back to Careers</Link>
      </div>

      <div className={styles.hero}>
        <span className={shell.eyebrow}>Caregiver application</span>
        <h1>Your PawSpace caregiver application</h1>
        <p>This application uses your verified identity and canonical onboarding state. It does not display synthetic approvals, verification outcomes, signed agreements, or booking eligibility.</p>
      </div>

      <div className={styles.stepper}>
        {STEPS.map((label, i) => (
          <div key={label} className={`${styles.step} ${i < stepIndex ? styles.stepDone : ""} ${i === stepIndex ? styles.stepActive : ""}`}>
            <b>{i < stepIndex ? "✓" : i + 1}</b>
            {label}
          </div>
        ))}
      </div>

      <div className={styles.notice}>
        <b>PRODUCTION READY = FALSE.</b> We&apos;re in a supervised pilot phase: Production KYC, live e-sign, marketplace admission, order eligibility and live money are not enabled. A real member of our Ops team personally reviews every verification, qualification and interview.
      </div>

      {error ? <p className={styles.errorBox} role="alert">{error}</p> : null}

      {controls.canStartApplication ? (
        <div className={styles.card}>
          <h2>Start your application</h2>
          <p>Tell us where you&apos;d like to provide care. Your application is tied to your verified phone number, not this form.</p>
          <label className={styles.field}><span>Service</span>
            <select value={form.verticalKey} onChange={e => setForm({ ...form, verticalKey: e.target.value })}>
              <option value="grooming">Grooming</option>
              <option value="dog_training">Dog Training</option>
              <option value="boarding">Boarding</option>
              <option value="pet_sitting">Pet Sitting</option>
              <option value="dog_walking">Dog Walking</option>
            </select>
          </label>
          <label className={styles.field}><span>City</span>
            <select value={form.cityCode} onChange={e => setForm({ ...form, cityCode: e.target.value })}>
              <option value="BLR">Bengaluru (supported pilot)</option>
            </select>
          </label>
          <p>Provider onboarding is currently open only for the explicitly supported Bengaluru pilot coverage. Other cities fail closed until their launch configuration and service zones are approved.</p>
          <button className={styles.btn} disabled={busy || !isProviderSession} onClick={() => void post({ action: "create_application", payload: { verticalKey: form.verticalKey, countryCode: form.countryCode, regionCode: form.regionCode, cityCode: form.cityCode, localeCode: form.localeCode, basicInfo: {} } })}>
            {busy ? "Saving…" : "Start application"}
          </button>
        </div>
      ) : (
        <>
          <div className={styles.card}>
            <h2>Application {appId}</h2>
            <div className={styles.statusRow}>
              <span>Verification: <b>{text(app?.verification_status) || "Not started"}</b></span>
              <span>Qualification: <b>{text(app?.quiz_status) || "Not started"}</b></span>
              <span>Interview: <b>{text(app?.interview_status) || "Not started"}</b></span>
              <span>Decision: <b>{text(app?.human_decision) || "Pending"}</b></span>
            </div>
            <p>Documents on file: {current?.documents?.length || 0}</p>
            {controls.canUploadDocument ? (
              <>
                <label className={styles.field}><span>Document type</span>
                  <select value={docType} onChange={e => setDocType(e.target.value)}>
                    <option value="government_id">Government ID</option>
                    <option value="address_proof">Address proof</option>
                    <option value="provider_photo">Your photo</option>
                  </select>
                </label>
                <label className={styles.field}><span>Choose a file (PDF, JPG, PNG or WebP, up to 10 MB)</span>
                  <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy || uploading === "document"} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void uploadDocument("document", file); }} />
                </label>
                <p style={{ fontSize: 12, color: "var(--ps-muted)" }}>Your document goes straight into private storage that only our verification team can open. It is never shown on your public profile.</p>
                {uploading === "document" ? <p role="status">Uploading…</p> : null}
                {uploadNotice ? <p role="status" className={styles.statusRow}>{uploadNotice}</p> : null}
                <button className={styles.btnGhost} disabled={busy || uploading !== ""} onClick={() => void post({ action: "submit_application", applicationId: appId })}>Submit application</button>
                <p style={{ fontSize: 12, color: "var(--ps-muted)" }}>Submitting checks that every document we ask for is on file and still current — if one is missing, we&apos;ll say which.</p>
              </>
            ) : null}
          </div>

          <div className={styles.card}>
            <h2>Verification</h2>
            <p>{text(current?.verification?.status) || "Waiting to begin."}</p>
            <p>You can&apos;t mark yourself as verified — a real member of our team checks this personally.</p>
          </div>

          {controls.canTakeQuiz ? (
            <div className={styles.card}>
              <h2>20-question qualification</h2>
              <p>Answer all {questions.length} questions. This score is deterministic and never the final decision on its own.</p>
              {questions.map((q, i) => {
                const questionId = text(q.questionId);
                return (
                  <fieldset key={questionId || String(i)} className={styles.question}>
                    <legend>{i + 1}. {text(q.prompt)}</legend>
                    {(Array.isArray(q.options) ? q.options : []).map((o, j) => {
                      const option = o as Row;
                      const value = text(option.value || option.id || o);
                      return (
                        <label key={`${value}-${j}`} className={styles.option}>
                          <input type="radio" name={questionId} checked={answers[questionId] === value} onChange={() => setAnswers({ ...answers, [questionId]: value })} />
                          {text(option.label || o)}
                        </label>
                      );
                    })}
                  </fieldset>
                );
              })}
              <button className={styles.btn} disabled={busy || Object.keys(answers).length !== questions.length} onClick={() => void post({ action: "score_quiz", applicationId: appId, quizVersionId: text(current?.quiz?.id), answers })}>
                Submit answers
              </button>
            </div>
          ) : null}

          <div className={styles.card}>
            <h2>15-minute Ops interview</h2>
            <p>Status: {text(current?.interview?.status) || "Not scheduled yet"}</p>
            {current?.interview ? <p>{text(current.interview.start_at)} · {text(current.interview.duration_minutes)} minutes</p> : null}
            <p>Our Ops team schedules this personally once your qualification is submitted — we&apos;ll reach out with a time.</p>
          </div>

          {current?.agreement ? (
            <div className={styles.card}>
              <h2>Service agreement</h2>
              <p>Version {text(current.agreement.agreement_version)} · {text(current.agreement.status)}</p>
              {current.agreementContent ? <div className={styles.agreementText}>{text(current.agreementContent.contentText)}</div> : null}
              {controls.canAcceptAgreement ? (
                acceptance.available ? (
                  <button className={styles.btn} disabled={busy} onClick={() => void post({ action: acceptance.action, applicationId: appId, agreementId: text(current.agreement?.id) })}>
                    Accept agreement
                  </button>
                ) : <p className={styles.errorBox} role="status">Agreement acceptance is switched off until our signing setup is completed. Nothing is wrong with your application — we&apos;ll come back to you.</p>
              ) : null}
            </div>
          ) : null}

          {controls.canSaveProfile ? (
            <div className={styles.card}>
              <h2>Your profile</h2>
              <label className={styles.field}><span>Display name</span>
                <input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />
              </label>
              <label className={styles.field}><span>Business name</span>
                <input value={form.businessName} onChange={e => setForm({ ...form, businessName: e.target.value })} />
              </label>
              <label className={styles.field}><span>Engagement model</span>
                <select value={form.providerModel} onChange={e => setForm({ ...form, providerModel: e.target.value })}>
                  <option value="commission">Commission based</option>
                  <option value="full_time">Full-time contract partner</option>
                </select>
              </label>
              {form.providerModel === "full_time" ? <label className={styles.field}><span>Work email for People access</span>
                <input type="email" value={form.workEmail} onChange={e => setForm({ ...form, workEmail: e.target.value })} placeholder="name@pawspace.in" />
              </label> : null}
              <label className={styles.field}><span>Your bio</span>
                <textarea rows={4} style={{ width: "100%", padding: "11px 13px", borderRadius: 10, border: "1px solid var(--ps-border)", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" }} value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} placeholder="A short, friendly line about you - or draft one with AI below and edit it." />
              </label>
              <button className={styles.btnGhost} disabled={bioBusy || !form.displayName} onClick={() => void draftBioWithAi()}>
                {bioBusy ? "Drafting…" : "✨ Draft with AI"}
              </button>
              {bioError ? <p className={styles.errorBox} role="alert" style={{ marginTop: 10 }}>{bioError}</p> : null}
              <p style={{ fontSize: 12, color: "var(--ps-muted)" }}>AI can suggest a starting point, but it&apos;s only ever a draft - review and edit it before saving, and it&apos;s never shown to customers until you save your profile yourself.</p>
              <button className={styles.btn} disabled={busy || !form.displayName || !form.businessName || (form.providerModel === "full_time" && !form.workEmail.trim())} onClick={() => void post({ action: "save_profile", applicationId: appId, payload: { displayName: form.displayName, businessName: form.businessName, bio: form.bio, services: [text(app?.vertical_key)], serviceAreas: [text(app?.city_code)], languages: [text(app?.locale_code) || "en"], businessDetails: { providerModel: form.providerModel, workEmail: form.providerModel === "full_time" ? form.workEmail.trim() : null }, packageDetails: [], facilityDetails: {}, references: [] } })}>
                Save profile
              </button>
              <p>Home or facility photos stay private by default. Saving your profile alone doesn&apos;t start bringing you bookings yet.</p>

              <h3>Photos and references</h3>
              <p>{current?.media?.length || 0} on file. Your onboarding policy may require some of these before our team can complete your activation.</p>
              <label className={styles.field}><span>What is this?</span>
                <select value={mediaType} onChange={e => setMediaType(e.target.value)}>
                  {MEDIA_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className={styles.field}><span>Choose a photo</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uploading === "media"} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void uploadDocument("media", file); }} />
              </label>
              {uploading === "media" ? <p role="status">Uploading…</p> : null}
              <p style={{ fontSize: 12, color: "var(--ps-muted)" }}>Home and facility photos are treated as sensitive location data and are not published without a separate approval.</p>
            </div>
          ) : null}

          {activated ? (
            /*
             * After activation, "Save profile" was still the only control on this screen - and
             * saveProviderProfile writes an audit row with review_required=0 and
             * reverification_required=0, so a live provider could quietly change the services and
             * service areas their matching scope is built from with nothing flagged for review.
             * updateActivatedProviderProfile is the governed path: it demands a reason, refuses the
             * protected identity and compliance fields outright, and flags a service-area change for
             * re-verification. [W2-F]
             */
            <div className={styles.card}>
              <h2>Update your live profile</h2>
              <p>You&apos;re activated, so changes here are recorded with a reason and reviewed. Changing your services or service areas needs our team to re-check your verification.</p>
              <label className={styles.field}><span>Display name</span>
                <input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />
              </label>
              <label className={styles.field}><span>Your bio</span>
                <textarea rows={4} style={{ width: "100%", padding: "11px 13px", borderRadius: 10, border: "1px solid var(--ps-border)", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" }} value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} />
              </label>
              <label className={styles.field}><span>Why are you changing this?</span>
                <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="e.g. corrected my business name" />
              </label>
              <button className={styles.btn} disabled={busy || editReason.trim().length < 5 || !form.displayName.trim()} onClick={() => void post({ action: "update_activated_profile", applicationId: appId, changes: { displayName: form.displayName, bio: form.bio }, reason: editReason })}>
                Save change for review
              </button>
            </div>
          ) : null}

          <div className={styles.card}>
            <h2>Activation</h2>
            <p>Marketplace live: <b>No</b> · Order eligible: <b>No</b>.</p>
            <p>Only staff can run deterministic UAT activation after all gates. Provider self-service cannot activate itself.</p>
          </div>
        </>
      )}

      <p style={{ marginTop: 24, textAlign: "center" }}><Link className={styles.backLink} href="/partner">← Back to Partner app</Link></p>
    </main>
  );
}
