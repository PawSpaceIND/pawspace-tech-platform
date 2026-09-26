"use client";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { CustomerAccountRecord } from "../../lib/customer-account";
import {
  endV2CustomerSession,
  loadV2CustomerAccount,
  loadV2CustomerSession,
  loadV2ServiceAvailability,
  requestV2CustomerOtp,
  verifyV2CustomerOtp,
  type V2OtpChallenge,
  type V2ServiceAvailability,
} from "../../lib/v2/customer-experience-client";
import styles from "./v2.module.css";
import { AdditionalCareTiles, HomePets } from "./home-care-extras";
import V2ServiceIcon from "./service-icon";

type ServiceCard = {
  code: string;
  name: string;
  eyebrow: string;
  note: string;
  href: string;
  image: string;
  accent: string;
  wash: string;
  size?: "hero" | "regular";
};

const SERVICES: ServiceCard[] = [
  { code: "grooming", name: "Grooming", eyebrow: "Doorstep spa", note: "Salon-quality care, at home.", href: "/v2/grooming", image: "/assets/pawspace-grooming-cartoon.webp", accent: "#f0ad36", wash: "#fff0c9", size: "hero" },
  { code: "boarding", name: "Boarding", eyebrow: "Trusted stays", note: "A second home when you travel.", href: "/v2/boarding", image: "/assets/pawspace-boarding-cartoon.webp", accent: "#cf7c67", wash: "#ffe4db" },
  { code: "dog_training", name: "Training", eyebrow: "Better habits", note: "Kind coaching for calmer days.", href: "/v2/training", image: "/assets/pawspace-training-cartoon.webp", accent: "#6b7ed7", wash: "#e7eaff" },
  { code: "pet_sitting", name: "Pet Sitting", eyebrow: "Care at home", note: "Familiar spaces, loving company.", href: "/v2/sitting", image: "/assets/pawspace-sitting-cartoon.webp", accent: "#c56b9c", wash: "#fde6f2" },
  { code: "dog_walking", name: "Dog Walking", eyebrow: "Happy steps", note: "Reliable walks with real updates.", href: "/v2/walking", image: "/assets/pawspace-walking-cartoon.webp", accent: "#64a36f", wash: "#e3f2df" },
  { code: "food", name: "Fresh Food", eyebrow: "Fresh bowls", note: "Made-for-pets meals, delivered.", href: "/v2/food", image: "/assets/pawspace-food-cartoon.webp", accent: "#df7b3d", wash: "#ffead8" },
  { code: "relocation", name: "Relocation", eyebrow: "Move together", note: "Thoughtful travel support end to end.", href: "/v2/relocation", image: "/assets/pawspace-relocation-cartoon.webp", accent: "#5f8faa", wash: "#deeff8" },
  { code: "pet_taxi", name: "Pet Taxi", eyebrow: "Safe rides", note: "Comfortable pickup and drop support.", href: "/v2/taxi", image: "/assets/pawspace-taxi-cartoon.webp", accent: "#9d7b54", wash: "#f1e5d5" },
];

const CLOSED_BOOKING_STATES = new Set(["completed", "cancelled", "canceled", "refunded", "closed"]);
const money = (value: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
const dateLabel = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Schedule pending";
  // Service times are Bengaluru times; a device in another time zone must not shift them.
  return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(parsed)} IST`;
};

export default function PawSpaceV2() {
  const [account, setAccount] = useState<CustomerAccountRecord | null>(null);
  const [availability, setAvailability] = useState<V2ServiceAvailability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [serviceError, setServiceError] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [authStage, setAuthStage] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<V2OtpChallenge | null>(null);
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setServiceError("");
    try {
      const [sessionResult, availabilityResult] = await Promise.allSettled([
        loadV2CustomerSession(),
        loadV2ServiceAvailability(),
      ]);
      if (availabilityResult.status === "fulfilled") setAvailability(availabilityResult.value);
      else {
        setAvailability(null);
        setServiceError(availabilityResult.reason instanceof Error ? availabilityResult.reason.message : "Availability is temporarily unavailable");
      }
      if (sessionResult.status === "rejected") throw sessionResult.reason;
      if (!sessionResult.value) {
        setAccount(null);
        return;
      }
      setAccount(await loadV2CustomerAccount());
    } catch (problem) {
      setAccount(null);
      setLoadError(problem instanceof Error ? problem.message : "PawSpace could not load your family right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const enabledByCode = useMemo(() => new Map((availability || []).map(item => [item.code, item.enabled])), [availability]);
  const upcoming = useMemo(() => {
    return (account?.bookings || [])
      .filter(booking => !CLOSED_BOOKING_STATES.has(booking.status.toLowerCase()))
      .sort((a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime())[0] || null;
  }, [account]);
  const firstPet = account?.pets[0] || null;
  const firstName = account?.name?.trim().split(/\s+/)[0] || "Pet parent";
  const availableCount = availability?.filter(item => item.enabled).length ?? 0;

  const requestOtp = async () => {
    setAuthError("");
    if (!/^\d{10}$/.test(phone)) { setAuthError("Enter a valid 10-digit mobile number."); return; }
    setAuthBusy(true);
    try {
      const result = await requestV2CustomerOtp(phone);
      setChallenge(result);
      setAuthStage("code");
    } catch (problem) {
      setAuthError(problem instanceof Error ? problem.message : "We could not send your code.");
    } finally {
      setAuthBusy(false);
    }
  };

  const verifyOtp = async () => {
    setAuthError("");
    if (!challenge?.challengeId) { setAuthStage("phone"); return; }
    if (!/^\d{6}$/.test(code)) { setAuthError("Enter the 6-digit code."); return; }
    setAuthBusy(true);
    try {
      await verifyV2CustomerOtp({ challengeId: challenge.challengeId, code, name: name.trim() || undefined });
      setAuthOpen(false);
      setCode("");
      setChallenge(null);
      await bootstrap();
    } catch (problem) {
      setAuthError(problem instanceof Error ? problem.message : "We could not verify your code.");
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await endV2CustomerSession();
      setAccount(null);
    } catch (problem) {
      setLoadError(problem instanceof Error ? problem.message : "We could not sign you out.");
    } finally {
      setSigningOut(false);
    }
  };

  const resetAuth = () => {
    setAuthStage("phone");
    setChallenge(null);
    setCode("");
    setName("");
    setAuthError("");
  };

  return (
    <main className={styles.page} data-v2-home="true">
      <div className={styles.aurora} aria-hidden="true" />
      <div className={styles.shell}>
        <header className={styles.nav}>
          <Link href="/v2" className={styles.logoLink} aria-label="PawSpace V2 home">
            <img src="/assets/pawspace-official-lockup.png" alt="PawSpace" className={styles.logo} />
          </Link>
          <div className={styles.navCenter}>
            <span className={styles.locationDot} />
            <Link href="/v2/account" aria-label="Manage saved service address">{account?.addresses[0]?.area || account?.addresses[0]?.city || "Bengaluru"}⌄</Link>
            <span className={styles.navDivider} />
            <span>{availability ? `${availableCount} services ready` : "Checking services"}</span>
          </div>
          <div className={styles.navActions}>
            <Link href="/v2/activity" className={styles.aiNav}><span>◎</span> Activity</Link>
            <Link href="/v2/chat" className={styles.aiNav}><span>✦</span> Ask PawSpace AI</Link>
            {account ? (
              <Link href="/v2/account" className={styles.profileButton} title="Open account">
                <span className={styles.avatar}>{account.name.slice(0, 1).toUpperCase()}</span>
                <span className={styles.profileText}><small>Welcome back</small><b>{firstName}</b></span>
              </Link>
            ) : (
              <button className={styles.signIn} onClick={() => setAuthOpen(true)}>Sign in</button>
            )}
          </div>
        </header>

        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.kicker}><i /> PAWSPACE CARE, REIMAGINED</span>
            <h1>Everything your pet needs.<br /><em>Beautifully cared for.</em></h1>
            <p>Trusted people, intelligent care and every service in one delightful PawSpace experience.</p>
            <div className={styles.heroActions}>
              <a href="#services" className={styles.primaryAction}>Explore care <span>↗</span></a>
              <Link href="/v2/chat" className={styles.secondaryAction}><span>✦</span> Plan with PawSpace AI</Link>
            </div>
            <div className={styles.trustRow}>
              <span><b>4.9</b><small>customer love</small></span>
              <span><b>8</b><small>care experiences</small></span>
              <span><b>1</b><small>family record</small></span>
            </div>
          </div>
          <div className={styles.heroVisual}>
            <div className={styles.heroHalo} />
            <div className={styles.petPortrait}>
              <img src="/assets/pawspace-grooming-editorial.webp" alt="Happy pet enjoying PawSpace care" />
            </div>
            <div className={styles.floatingCardTop}>
              <span className={styles.liveDot} />
              <div><small>CARE STATUS</small><b>{upcoming ? "Your next care is planned" : "Ready when you are"}</b></div>
            </div>
            <div className={styles.floatingCardBottom}>
              <span className={styles.spark}>✦</span>
              <div><small>PAWSPACE AI</small><b>{firstPet ? `${firstPet.name}'s care stays connected` : "One brain for your pet's care"}</b></div>
            </div>
          </div>
        </section>

        {(loadError || serviceError) && (
          <div className={styles.notice} role="status">
            <span>●</span>
            <div><b>Live data check</b><p>{loadError || serviceError}</p></div>
            <button onClick={() => void bootstrap()}>Retry</button>
          </div>
        )}

        <HomePets account={account} />
        <section className={styles.familyStrip}>
          <div className={styles.sectionTitleCompact}>
            <span>Your PawSpace</span>
            <b>{loading ? "Bringing your family into view…" : account ? `Good to see you, ${firstName}.` : "A home for every part of pet parenting."}</b>
          </div>
          {account ? (
            <div className={styles.familyFacts}>
              <div className={styles.fact}><span>♥</span><div><b>{account.pets.length || "—"}</b><small>{account.pets.length === 1 ? "pet profile" : "pet profiles"}</small></div></div>
              <div className={styles.fact}><span>⌂</span><div><b>{account.addresses.length || "—"}</b><small>saved places</small></div></div>
              <div className={styles.fact}><span>◎</span><div><b>{account.bookings.length || "—"}</b><small>care records</small></div></div>
            </div>
          ) : (
            <button className={styles.familySignIn} onClick={() => setAuthOpen(true)}><span>＋</span><div><b>Bring your pet family in</b><small>Sign in once for pets, addresses and booking history.</small></div><strong>Continue →</strong></button>
          )}
        </section>

        <div className={styles.contentGrid}>
          <section className={styles.servicesSection} id="services">
            <div className={styles.sectionHeader}>
              <div><span className={styles.eyebrow}>CARE COLLECTION</span><h2>What would make today better?</h2></div>
              <p>Every service checks PawSpace availability before you book.</p>
            </div>
            <div className={styles.servicesGrid}>
              {SERVICES.map(service => {
                const enabled = enabledByCode.get(service.code) === true;
                const availabilityKnown = availability !== null;
                const cardStyle = { "--accent": service.accent, "--wash": service.wash } as CSSProperties;
                const content = (
                  <>
                    <span className={styles.serviceIcon} aria-hidden="true"><V2ServiceIcon code={service.code} /></span>
                    <div className={styles.serviceCopy}>
                      <span>{service.eyebrow}</span>
                      <h3>{service.name}</h3>
                      <p>{service.note}</p>
                      <b className={styles.serviceState}>{availabilityKnown ? (enabled ? "Available" : "Not taking bookings") : "Checking availability"}</b>
                    </div>
                    <div className={styles.serviceArt}><img src={service.image} alt="" /></div>
                    <span className={styles.serviceArrow}>↗</span>
                  </>
                );
                return enabled ? (
                  <Link key={service.code} data-home-care-tile={service.code} href={service.href} className={`${styles.serviceCard} ${service.size === "hero" ? styles.serviceHero : ""}`} style={cardStyle}>{content}</Link>
                ) : (
                  <article key={service.code} data-home-care-tile={service.code} className={`${styles.serviceCard} ${styles.serviceDisabled} ${service.size === "hero" ? styles.serviceHero : ""}`} style={cardStyle} aria-disabled="true">{content}</article>
                );
              })}
              <AdditionalCareTiles availability={availability} />
            </div>
          </section>

          <aside className={styles.rail}>
            <section className={styles.aiCard}>
              <div className={styles.aiTop}><span className={styles.aiOrb}>✦</span><div><small>PAWSPACE AI</small><b>Your pet-care co-pilot</b></div><span className={styles.beta}>AI</span></div>
              <h3>{firstPet ? `A little more ease for ${firstPet.name}.` : "Tell us about your pet. We'll connect the dots."}</h3>
              <p>{account ? (upcoming ? `You have ${upcoming.packageName} coming up. I can help with prep, follow-ups and the next best care step.` : "Your family profile is connected. Ask for care ideas, service guidance or help planning your next booking.") : "Ask what service fits, how to prepare, or what your pet may need next. Booking truth always comes from PawSpace systems."}</p>
              <Link href="/v2/chat" className={styles.aiCta}>Need help? Ask PawSpace <span>↗</span></Link>
              <div className={styles.promptChips}><span>“What does my pet need?”</span><span>“Plan a travel stay”</span><span>“Grooming advice”</span></div>
            </section>

            <section className={styles.bookingCard} data-has-booking={Boolean(upcoming)}>
              <div className={styles.cardLabel}><span>◎</span> NEXT CARE</div>
              {loading ? (
                <>
                  <h3>Checking your bookings…</h3>
                  <p>Your next visit will appear here in a moment.</p>
                </>
              ) : upcoming ? (
                <>
                  <h3>{upcoming.packageName}</h3>
                  <p>{dateLabel(upcoming.scheduledStart)}</p>
                  <div className={styles.bookingMeta}><span>{upcoming.serviceCode.replaceAll("_", " ")}</span><b>{money(upcoming.totalAmount, upcoming.currency)}</b></div>
                  <div className={styles.statusPill}>{upcoming.status.replaceAll("_", " ")}</div>
                </>
              ) : (
                <>
                  <h3>No care booked yet.</h3>
                  <p>When you book, the live PawSpace record will appear here automatically.</p>
                  <a href="#services" className={styles.textLink}>Choose a service →</a>
                </>
              )}
            </section>

            <section className={styles.promiseCard}>
              <span className={styles.promiseMark}>PS</span>
              <div><small>THE PAWSPACE PROMISE</small><b>One family. One care history. No fragmented journeys.</b></div>
            </section>
          </aside>
        </div>

        <footer className={styles.footer}>
          <div><img src="/assets/pawspace-icon.jpeg" alt="" /><span><b>PawSpace</b><small>Happier pets. Calmer humans.</small></span></div>
          <p>V2 foundation · live identity, family and service truth · Bengaluru</p>
        </footer>
      </div>

      <nav className={styles.mobileDock} aria-label="PawSpace mobile navigation">
        <Link href="/v2"><span>⌂</span><b>Home</b></Link>
        <Link href="/v2/activity"><span>◎</span><b>Bookings</b></Link>
        <Link href="/v2/chat" className={styles.mobileAi}><span>✦</span><b>Help</b></Link>
        {account ? <Link href="/v2/account"><span>◉</span><b>Account</b></Link> : <button onClick={() => setAuthOpen(true)}><span>◉</span><b>Sign in</b></button>}
      </nav>

      {authOpen && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Sign in to PawSpace">
          <div className={styles.authModal}>
            <button className={styles.modalClose} aria-label="Close" onClick={() => { setAuthOpen(false); resetAuth(); }}>×</button>
            <div className={styles.authBrand}><span>🐾</span><div><small>WELCOME HOME</small><b>PawSpace knows your family.</b></div></div>
            <h2>{authStage === "phone" ? "One number. Every care journey." : "You're almost in."}</h2>
            <p>{authStage === "phone" ? "Use your mobile number to securely open pets, places and care history." : `Enter the 6-digit code for +91 ${phone}.`}</p>
            {authStage === "phone" ? (
              <>
                <label className={styles.field}><span>Mobile number</span><div className={styles.phoneField}><b>+91</b><input autoFocus inputMode="numeric" value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="98765 43210" aria-label="Mobile number" /></div></label>
                <button className={styles.authPrimary} disabled={authBusy} onClick={() => void requestOtp()}>{authBusy ? "Sending…" : "Continue securely"}<span>→</span></button>
              </>
            ) : (
              <>
                {challenge?.sandboxCode && <div className={styles.sandboxCode}><span>Sandbox code (no real SMS yet)</span><b>{challenge.sandboxCode}</b><small>No real SMS is sent in sandbox.</small></div>}
                <label className={styles.field}><span>Verification code</span><input className={styles.codeInput} autoFocus inputMode="numeric" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="••••••" aria-label="Verification code" /></label>
                {!challenge?.existingCustomer && <label className={styles.field}><span>Your name <em>first visit only</em></span><input value={name} onChange={event => setName(event.target.value)} placeholder="How should PawSpace greet you?" aria-label="Your name" /></label>}
                <button className={styles.authPrimary} disabled={authBusy} onClick={() => void verifyOtp()}>{authBusy ? "Opening PawSpace…" : "Open my PawSpace"}<span>→</span></button>
                <button className={styles.changeNumber} onClick={resetAuth}>← Use a different number</button>
              </>
            )}
            {authError && <div className={styles.authError} role="alert">{authError}</div>}
            <div className={styles.authFoot}><span>◆</span> Secure identity · one canonical PawSpace account</div>
          </div>
        </div>
      )}
    </main>
  );
}
