"use client";
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
};

const text = (v: unknown) => String(v ?? "");
const STEPS = ["Application", "Verification", "Qualification", "Interview", "Agreement", "Profile", "Activation"];

export default function PartnerOnboardingUatPage() {
  const [session, setSession] = useState<Row | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ verticalKey: "grooming", countryCode: "IN", regionCode: "KA", cityCode: "BLR", localeCode: "en", displayName: "", businessName: "", bio: "" });
  const [docType, setDocType] = useState("government_id");
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");

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
    return fetch("/api/provider-onboarding-self-service", { cache: "no-store" }).then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); }).then(v => setData(v.data));
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
      .then(async r => { if (!r) return; if (!r.ok) throw new Error(await r.text()); return r.json(); })
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
      if (!r.ok) throw new Error(await r.text());
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

      {!current ? (
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
            <input value={form.cityCode} onChange={e => setForm({ ...form, cityCode: e.target.value })} />
          </label>
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
            {text(app?.status) === "draft" ? (
              <>
                <label className={styles.field}><span>Document type</span>
                  <select value={docType} onChange={e => setDocType(e.target.value)}>
                    <option value="government_id">Government ID</option>
                    <option value="address_proof">Address proof</option>
                    <option value="provider_photo">Your photo</option>
                  </select>
                </label>
                <div className={styles.warnBox}>
                  ⚠️ Document upload isn&apos;t available yet — it needs dedicated secure file storage to be provisioned first. Uploading a photo directly into the database would put sensitive ID documents somewhere they don&apos;t belong, so we&apos;re holding off until that&apos;s set up properly.
                </div>
                <button className={styles.btn} disabled title="Real document storage is not provisioned yet">Upload document (not yet available)</button>
                <button className={styles.btnGhost} disabled={busy} onClick={() => void post({ action: "submit_application", applicationId: appId })}>Submit application</button>
              </>
            ) : null}
          </div>

          <div className={styles.card}>
            <h2>Verification</h2>
            <p>{text(current?.verification?.status) || "Waiting to begin."}</p>
            <p>You can&apos;t mark yourself as verified — a real member of our team checks this personally.</p>
          </div>

          {questions.length ? (
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
              {text(current.agreement.status) === "awaiting_acceptance" ? (
                <button className={styles.btn} disabled={busy} onClick={() => void post({ action: "accept_sla_uat", applicationId: appId, agreementId: text(current.agreement?.id) })}>
                  Accept agreement
                </button>
              ) : null}
            </div>
          ) : null}

          {approvedAndAccepted ? (
            <div className={styles.card}>
              <h2>Your profile</h2>
              <label className={styles.field}><span>Display name</span>
                <input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} />
              </label>
              <label className={styles.field}><span>Business name</span>
                <input value={form.businessName} onChange={e => setForm({ ...form, businessName: e.target.value })} />
              </label>
              <label className={styles.field}><span>Your bio</span>
                <textarea rows={4} style={{ width: "100%", padding: "11px 13px", borderRadius: 10, border: "1px solid var(--ps-border)", fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" }} value={form.bio} onChange={e => setForm({ ...form, bio: e.target.value })} placeholder="A short, friendly line about you - or draft one with AI below and edit it." />
              </label>
              <button className={styles.btnGhost} disabled={bioBusy || !form.displayName} onClick={() => void draftBioWithAi()}>
                {bioBusy ? "Drafting…" : "✨ Draft with AI"}
              </button>
              {bioError ? <p className={styles.errorBox} role="alert" style={{ marginTop: 10 }}>{bioError}</p> : null}
              <p style={{ fontSize: 12, color: "var(--ps-muted)" }}>AI can suggest a starting point, but it&apos;s only ever a draft - review and edit it before saving, and it&apos;s never shown to customers until you save your profile yourself.</p>
              <button className={styles.btn} disabled={busy || !form.displayName || !form.businessName} onClick={() => void post({ action: "save_profile", applicationId: appId, payload: { displayName: form.displayName, businessName: form.businessName, bio: form.bio, services: [text(app?.vertical_key)], serviceAreas: [text(app?.city_code)], languages: [text(app?.locale_code) || "en"], businessDetails: {}, packageDetails: [], facilityDetails: {}, references: [] } })}>
                Save profile
              </button>
              <p>Home or facility photos stay private by default. Saving your profile alone doesn&apos;t start bringing you bookings yet.</p>
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
