"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "./partner.module.css";
import TestSyncPanel from "../components/test-sync-panel";

const roles = [
  "Groomer",
  "Dog Trainer",
  "Boarding Host",
  "Pet Sitter",
  "Dog Walker",
  "Taxi Driver",
];
const nav = [
  "Home",
  "Onboarding",
  "Bookings",
  "Calendar",
  "Tracking",
  "Earnings",
  "Quality",
  "Learning",
  "Support",
  "Profile",
];

const jobs = [
  {
    time: "9:00–11:00 AM",
    title: "Bath & Basic Grooming",
    pet: "Bruno · Golden Retriever",
    area: "Indiranagar",
    pay: "₹760",
    state: "Next",
  },
  {
    time: "11:00 AM–1:00 PM",
    title: "Complete Makeover",
    pet: "Milo · Shih Tzu",
    area: "Koramangala",
    pay: "₹960",
    state: "Confirmed",
  },
  {
    time: "3:00–5:00 PM",
    title: "Bath & Basic · 2 pets",
    pet: "Oreo & Coco",
    area: "HSR Layout",
    pay: "₹1,420",
    state: "Confirmed",
  },
];

const onboarding = [
  ["Mobile & language", "OTP verified · English"],
  ["Role and skills", "Grooming · 4 years"],
  ["Identity documents", "PAN, Aadhaar and photo"],
  ["Address & emergency", "Verified"],
  ["Bank account", "Payout account verified"],
  ["Police verification", "Approved"],
  ["Zones & availability", "East Bengaluru · 9 AM–7 PM"],
  ["Training & assessment", "92% · Passed"],
  ["Agreement", "Digitally signed"],
];

export default function PartnerApp() {
  const [role, setRole] = useState("Groomer");
  const [view, setView] = useState("Home");
  const [live, setLive] = useState(true);
  const [stage, setStage] = useState(1);
  const [notice, setNotice] = useState("");
  const active = jobs[0];
  const careRole = role === "Boarding Host" || role === "Pet Sitter";
  const partnerName =
    role === "Boarding Host"
      ? "Maya & Rohan"
      : role === "Pet Sitter"
        ? "Sana F."
        : "Arjun Kumar";
  const roleLabel = useMemo(
    () =>
      role === "Taxi Driver"
        ? "trips"
        : role === "Boarding Host" || role === "Pet Sitter"
          ? "stays"
          : "jobs",
    [role],
  );
  const action = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2600);
  };

  return (
    <div className={styles.shell}>
      <aside className={styles.side}>
        <Link href="/" className={styles.brand}>
          <span>paw</span>
          <b>space</b>
          <small>PARTNER</small>
        </Link>
        <div className={styles.partner}>
          <span>{role === "Boarding Host" ? "MR" : role === "Pet Sitter" ? "SF" : "AK"}</span>
          <div>
            <b>{partnerName}</b>
            <small>{role} · PS-2048</small>
          </div>
        </div>
        <label className={styles.roleLabel}>
          Working as
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <nav>
          {nav.map((n) => (
            <button
              key={n}
              className={view === n ? styles.active : ""}
              onClick={() => setView(n)}
            >
              <i>
                {
                  (
                    {
                      Home: "⌂",
                      Onboarding: "✓",
                      Bookings: "▣",
                      Calendar: "◫",
                      Tracking: "⌖",
                      Earnings: "₹",
                      Quality: "★",
                      Learning: "◇",
                      Support: "?",
                      Profile: "○",
                    } as Record<string, string>
                  )[n]
                }
              </i>
              {n}
            </button>
          ))}
        </nav>
        <Link href="/admin" className={styles.admin}>
          Open Admin OS ↗
        </Link>
      </aside>

      <main className={styles.main}>
        <header>
          <div>
            <small>PAWSPACE PARTNER APP</small>
            <h1>{view}</h1>
          </div>
          <div className={styles.headerActions}>
            <button
              className={live ? styles.live : styles.offline}
              onClick={() => setLive(!live)}
            >
              <span />
              {live ? "Live & available" : "You are offline"}
            </button>
            <button className={styles.bell}>
              ♢<i>3</i>
            </button>
          </div>
        </header>
        <TestSyncPanel surface="provider" />
        {notice && <div className={styles.toast}>✓ {notice}</div>}

        {view === "Home" && (
          <>
            <section className={styles.hero}>
              <div>
                <small>MONDAY, 3 AUGUST</small>
                <h2>Good morning, Arjun 👋</h2>
                <p>
                  You have 3 confirmed {roleLabel} today. Your first assignment
                  starts in 42 minutes.
                </p>
                <button onClick={() => setView("Bookings")}>
                  View today’s schedule
                </button>
              </div>
              <div className={styles.heroScore}>
                <span>94</span>
                <b>Partner score</b>
                <small>Top 8% this month</small>
              </div>
            </section>
            <section className={styles.stats}>
              <article>
                <small>Today’s earnings</small>
                <b>₹3,140</b>
                <em>↑ ₹420 incentives</em>
              </article>
              <article>
                <small>This month</small>
                <b>₹38,640</b>
                <em>18 completed jobs</em>
              </article>
              <article>
                <small>Next payout</small>
                <b>₹12,840</b>
                <em>5 Aug · RazorpayX</em>
              </article>
              <article>
                <small>Customer rating</small>
                <b>4.8 ★</b>
                <em>126 verified reviews</em>
              </article>
            </section>
            <div className={styles.twoCol}>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <small>NEXT ASSIGNMENT</small>
                    <h3>{active.time}</h3>
                  </div>
                  <span className={styles.tag}>Confirmed</span>
                </div>
                <h2>{active.title}</h2>
                <p className={styles.pet}>🐕 {active.pet}</p>
                <div className={styles.details}>
                  <span>⌖ {active.area} · 4.2 km</span>
                  <span>₹ Expected earning {active.pay}</span>
                  <span>💳 Pay after service</span>
                  <span>⚠ Sensitive skin · use oatmeal shampoo</span>
                </div>
                <div className={styles.actions}>
                  <button onClick={() => setView("Tracking")}>Navigate</button>
                  <button
                    className={styles.light}
                    onClick={() => action("Masked call connected")}
                  >
                    Call customer
                  </button>
                  <button
                    className={styles.light}
                    onClick={() => setView("Bookings")}
                  >
                    View details
                  </button>
                </div>
              </section>
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <small>TODAY</small>
                    <h3>Your schedule</h3>
                  </div>
                  <button
                    className={styles.textBtn}
                    onClick={() => setView("Calendar")}
                  >
                    Calendar →
                  </button>
                </div>
                {jobs.map((j) => (
                  <div className={styles.schedule} key={j.time}>
                    <time>{j.time.split("–")[0]}</time>
                    <span />
                    <div>
                      <b>{j.title}</b>
                      <small>
                        {j.pet} · {j.area}
                      </small>
                    </div>
                    <strong>{j.pay}</strong>
                  </div>
                ))}
              </section>
            </div>
            <section className={styles.quick}>
              <button onClick={() => setView("Earnings")}>
                ₹
                <span>
                  <b>Track earnings</b>
                  <small>Payouts and incentives</small>
                </span>
              </button>
              <button onClick={() => setView("Calendar")}>
                ◫
                <span>
                  <b>Update availability</b>
                  <small>Slots, leave and zones</small>
                </span>
              </button>
              <button onClick={() => setView("Learning")}>
                ◇
                <span>
                  <b>Learn & certify</b>
                  <small>Unlock more services</small>
                </span>
              </button>
              <button onClick={() => setView("Support")}>
                ?
                <span>
                  <b>Partner support</b>
                  <small>Urgent help and tickets</small>
                </span>
              </button>
            </section>
          </>
        )}

        {view === "Onboarding" && (
          <section className={styles.pageCard}>
            <div className={styles.titleRow}>
              <div>
                <small>ONE ONBOARDING · EVERY PAWSPACE SERVICE</small>
                <h2>Activation checklist</h2>
                <p>
                  Save progress at every step. Operations reviews only
                  exceptions.
                </p>
              </div>
              <div className={styles.progress}>
                <b>100%</b>
                <span>
                  <i />
                </span>
                <small>Ready to take bookings</small>
              </div>
            </div>
            <div className={styles.stepGrid}>
              {onboarding.map((s, i) => (
                <article key={s[0]}>
                  <span>{i + 1}</span>
                  <div>
                    <b>{s[0]}</b>
                    <small>{s[1]}</small>
                  </div>
                  <em>✓</em>
                </article>
              ))}
            </div>
            <div className={styles.approval}>
              <div>
                <b>Partner activated</b>
                <p>
                  Background, bank and skill checks were approved on 29 July
                  2026.
                </p>
              </div>
              <button onClick={() => action("Digital partner ID opened")}>
                View partner ID
              </button>
            </div>
          </section>
        )}

        {view === "Bookings" && (
          <div className={styles.twoColWide}>
            <section className={styles.pageCard}>
              <div className={styles.titleRow}>
                <div>
                  <small>LIVE BOOKING QUEUE</small>
                  <h2>Today’s assignments</h2>
                </div>
                <span className={styles.tag}>3 confirmed</span>
              </div>
              {jobs.map((j, i) => (
                <button
                  className={`${styles.job} ${i === 0 ? styles.selected : ""}`}
                  key={j.time}
                >
                  <time>{j.time}</time>
                  <div>
                    <b>{j.title}</b>
                    <small>
                      {j.pet} · {j.area}
                    </small>
                    <em>{j.state}</em>
                  </div>
                  <strong>
                    {j.pay}
                    <small>earnings</small>
                  </strong>
                </button>
              ))}
            </section>
            <section className={styles.pageCard}>
              <small>BOOKING PS-GR-8432</small>
              <h2>{active.title}</h2>
              <div className={styles.petProfile}>
                <span>🐕</span>
                <div>
                  <b>Bruno</b>
                  <small>Golden Retriever · Male · 3 years</small>
                  <p>Friendly. Sensitive skin. Vaccinations verified.</p>
                </div>
              </div>
              <div className={styles.infoGrid}>
                <div>
                  <small>Customer</small>
                  <b>Meera S. · 4.9 ★</b>
                </div>
                <div>
                  <small>Contact</small>
                  <b>Masked until accepted</b>
                </div>
                <div>
                  <small>Address</small>
                  <b>Indiranagar · 4.2 km</b>
                </div>
                <div>
                  <small>Payment</small>
                  <b>Pay after service</b>
                </div>
                <div>
                  <small>Package value</small>
                  <b>₹1,899</b>
                </div>
                <div>
                  <small>Your earning</small>
                  <b>₹760 + incentive</b>
                </div>
              </div>
              <div className={styles.actions}>
                <button
                  onClick={() => {
                    setStage(1);
                    setView("Tracking");
                  }}
                >
                  Start journey
                </button>
                <button
                  className={styles.light}
                  onClick={() => action("Admin support ticket created")}
                >
                  Report issue
                </button>
              </div>
            </section>
          </div>
        )}

        {view === "Calendar" && (
          <section className={styles.pageCard}>
            <div className={styles.titleRow}>
              <div>
                <small>AVAILABILITY ENGINE</small>
                <h2>Set when customers can book you</h2>
                <p>
                  Changes instantly update live customer slots and assignment
                  logic.
                </p>
              </div>
              <button onClick={() => action("Availability saved and synced")}>
                Save availability
              </button>
            </div>
            <div className={styles.calendarWeek}>
              {[
                "Mon 3",
                "Tue 4",
                "Wed 5",
                "Thu 6",
                "Fri 7",
                "Sat 8",
                "Sun 9",
              ].map((d, i) => (
                <article key={d} className={i === 0 ? styles.today : ""}>
                  <b>{d}</b>
                  {["9–11", "11–1", "1–3", "3–5", "5–7"].map((t, j) => (
                    <button
                      key={t}
                      className={(i + j) % 4 === 0 ? styles.blocked : ""}
                    >
                      {t}
                      <small>
                        {(i + j) % 4 === 0 ? "Blocked" : "Available"}
                      </small>
                    </button>
                  ))}
                </article>
              ))}
            </div>
            <div className={styles.settings}>
              <label>
                Service zone
                <select>
                  <option>East Bengaluru · 12 km</option>
                </select>
              </label>
              <label>
                Maximum jobs/day
                <select>
                  <option>4 jobs</option>
                </select>
              </label>
              <label>
                Weekly off
                <select>
                  <option>Sunday</option>
                </select>
              </label>
              <button
                className={styles.light}
                onClick={() => action("Leave request sent for approval")}
              >
                Request leave
              </button>
            </div>
          </section>
        )}

        {view === "Tracking" && (
          <div className={styles.twoColWide}>
            <section className={styles.map}>
              <div className={styles.route}>
                <span className={styles.me}>AK</span>
                <i />
                <span className={styles.pin}>⌖</span>
              </div>
              <div className={styles.eta}>
                <b>12 min</b>
                <small>4.2 km · Live route</small>
              </div>
              <div className={styles.mapActions}>
                <button onClick={() => action("Google Maps navigation opened")}>
                  Open navigation
                </button>
                <button
                  onClick={() =>
                    action("Customer notified of a 10-minute delay")
                  }
                >
                  Report delay
                </button>
                <button
                  className={styles.sos}
                  onClick={() => action("SOS sent to PawSpace safety desk")}
                >
                  SOS
                </button>
              </div>
            </section>
            <section className={styles.pageCard}>
              <small>ACTIVE JOB · PS-GR-8432</small>
              <h2>{active.pet}</h2>
              <div className={styles.timeline}>
                {[
                  "Accepted",
                  "On the way",
                  "Arrived",
                  "Service started",
                  "Proof & payment",
                  "Completed",
                ].map((s, i) => (
                  <button
                    key={s}
                    className={i <= stage ? styles.done : ""}
                    onClick={() => setStage(i)}
                  >
                    <span>{i < stage ? "✓" : i + 1}</span>
                    <b>{s}</b>
                  </button>
                ))}
              </div>
              <div className={styles.stageBox}>
                <b>
                  {
                    [
                      "Leave by 8:35 AM",
                      "Share live ETA",
                      "Customer arrival OTP",
                      "Complete safety checklist",
                      "Upload before/after photos",
                      "Job closed",
                    ][stage]
                  }
                </b>
                <p>
                  {stage < 4
                    ? "Customer sees your current status and receives automatic updates."
                    : "Add service notes, approved upgrades and payment evidence."}
                </p>
                <div className={styles.actions}>
                  <button onClick={() => setStage(Math.min(5, stage + 1))}>
                    {stage === 5 ? "View summary" : "Complete step"}
                  </button>
                  <button
                    className={styles.light}
                    onClick={() => action("Masked call connected")}
                  >
                    Call customer
                  </button>
                </div>
              </div>
              <div className={styles.privacy}>
                ⌾ Location is shared only from “On the way” until job closure.
              </div>
            </section>
          </div>
        )}

        {view === "Earnings" && (
          <>
            <section className={styles.moneyHero}>
              <div>
                <small>AVAILABLE BALANCE</small>
                <h2>₹18,420</h2>
                <p>Next automatic RazorpayX payout: 5 Aug 2026</p>
              </div>
              <button onClick={() => action("Payout statement downloaded")}>
                Download statement
              </button>
            </section>
            <section className={styles.stats}>
              <article>
                <small>5-day cooling</small>
                <b>₹6,280</b>
                <em>4 closed orders</em>
              </article>
              <article>
                <small>Scheduled payout</small>
                <b>₹12,840</b>
                <em>Bank •••• 4821</em>
              </article>
              <article>
                <small>Paid this month</small>
                <b>₹25,800</b>
                <em>All reconciled</em>
              </article>
              <article>
                <small>Incentives</small>
                <b>₹2,460</b>
                <em>Quality + upgrades</em>
              </article>
            </section>
            <section className={styles.pageCard}>
              <div className={styles.titleRow}>
                <div>
                  <small>ORDER-WISE LEDGER</small>
                  <h2>Transparent earnings</h2>
                </div>
                <button className={styles.textBtn}>Raise payout dispute</button>
              </div>
              <div className={styles.table}>
                <b>Date</b>
                <b>Order</b>
                <b>Service</b>
                <b>Base</b>
                <b>Incentive</b>
                <b>Status</b>
                {[
                  [
                    "3 Aug",
                    "PS-8432",
                    "Basic Grooming",
                    "₹760",
                    "₹80",
                    "Cooling",
                  ],
                  [
                    "2 Aug",
                    "PS-8391",
                    "Complete Makeover",
                    "₹960",
                    "₹120",
                    "Cooling",
                  ],
                  ["29 Jul", "PS-8104", "Basic Grooming", "₹760", "₹0", "Paid"],
                  [
                    "28 Jul",
                    "PS-8052",
                    "2-pet booking",
                    "₹1,420",
                    "₹150",
                    "Paid",
                  ],
                ].flatMap((r, i) =>
                  r.map((c, j) => (
                    <span
                      key={`${i}-${j}`}
                      className={j === 5 ? styles.status : ""}
                    >
                      {c}
                    </span>
                  )),
                )}
              </div>
            </section>
          </>
        )}

        {view === "Quality" && (
          <div className={styles.twoCol}>
            <section className={styles.scoreCard}>
              <div>
                <span>94</span>
                <b>Excellent</b>
                <small>Partner performance score</small>
              </div>
              <ul>
                <li>
                  <b>4.8 ★</b>
                  <span>Customer rating</span>
                </li>
                <li>
                  <b>96%</b>
                  <span>On-time arrival</span>
                </li>
                <li>
                  <b>41%</b>
                  <span>Repeat customers</span>
                </li>
                <li>
                  <b>0</b>
                  <span>Open incidents</span>
                </li>
              </ul>
            </section>
            <section className={styles.pageCard}>
              <small>MONTHLY TARGETS</small>
              <h2>Performance & rewards</h2>
              {[
                ["Jobs completed", "18 / 24", "75%"],
                ["Approved upgrades", "7 / 10", "70%"],
                ["Add-ons", "12 / 15", "80%"],
                ["Five-star reviews", "14 / 18", "78%"],
              ].map((x) => (
                <div className={styles.target} key={x[0]}>
                  <div>
                    <b>{x[0]}</b>
                    <span>{x[1]}</span>
                  </div>
                  <i>
                    <em style={{ width: x[2] }} />
                  </i>
                </div>
              ))}
              <div className={styles.feedback}>
                <b>Recent praise</b>
                <p>“Arjun was gentle with Bruno and explained every step.”</p>
                <small>— Meera S. · Verified booking</small>
              </div>
            </section>
          </div>
        )}

        {view === "Learning" && (
          <section className={styles.pageCard}>
            <div className={styles.titleRow}>
              <div>
                <small>PAWSPACE ACADEMY</small>
                <h2>Learn, certify and unlock earnings</h2>
              </div>
              <span className={styles.tag}>3 certificates</span>
            </div>
            <div className={styles.courseGrid}>
              {[
                ["Pet safety & handling", "Certified", "100%"],
                ["Service SOP: Grooming", "Certified", "100%"],
                ["Customer communication", "2 lessons left", "68%"],
                ["Ethical upgrades & add-ons", "Start course", "0%"],
                ["Emergency first response", "Renew by Sep", "84%"],
                ["Premium pet care", "Unlocks ₹120/job", "35%"],
              ].map((c) => (
                <article key={c[0]}>
                  <span>◇</span>
                  <b>{c[0]}</b>
                  <small>{c[1]}</small>
                  <i>
                    <em style={{ width: c[2] }} />
                  </i>
                  <button onClick={() => action(`${c[0]} opened`)}>
                    Continue
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {view === "Support" && (
          <div className={styles.twoCol}>
            <section className={styles.pageCard}>
              <small>GET HELP</small>
              <h2>Partner support</h2>
              <div className={styles.supportGrid}>
                {[
                  ["Urgent job help", "Customer unavailable, delay, access"],
                  ["Safety emergency", "24×7 priority response"],
                  ["Payout support", "Missing or incorrect payment"],
                  ["Schedule & leave", "Slots, zone and attendance"],
                  ["HR & documents", "KYC, contract and policies"],
                  ["App support", "Login, GPS and notifications"],
                ].map((s) => (
                  <button
                    key={s[0]}
                    onClick={() => action(`${s[0]} ticket created`)}
                  >
                    <span>?</span>
                    <b>{s[0]}</b>
                    <small>{s[1]}</small>
                  </button>
                ))}
              </div>
            </section>
            <section className={styles.pageCard}>
              <small>YOUR TICKETS</small>
              <h2>Recent support</h2>
              {[
                ["#PA-2104", "Payout clarification", "Resolved · 1 Aug"],
                [
                  "#PA-2072",
                  "Customer requested reschedule",
                  "Resolved · 28 Jul",
                ],
                ["#PA-1988", "App location permission", "Resolved · 22 Jul"],
              ].map((t) => (
                <div className={styles.ticket} key={t[0]}>
                  <span>{t[0]}</span>
                  <b>{t[1]}</b>
                  <small>{t[2]}</small>
                </div>
              ))}
              <button
                className={styles.light}
                onClick={() => action("Support callback requested")}
              >
                Request a callback
              </button>
            </section>
          </div>
        )}

        {view === "Profile" && (
          <div className={styles.twoCol}>
            <section className={styles.pageCard}>
              <div className={styles.profileHead}>
                <span>
                  {role === "Boarding Host"
                    ? "MR"
                    : role === "Pet Sitter"
                      ? "SF"
                      : "AK"}
                </span>
                <div>
                  <h2>{partnerName}</h2>
                  <p>{role} · Active since Mar 2024</p>
                  <b>Verified PawSpace Partner</b>
                </div>
              </div>
              {careRole && (
                <article className={styles.publicProfileSync}>
                  <img
                    src={
                      role === "Boarding Host"
                        ? "/assets/stays/maya-rohan-profile.webp"
                        : "/assets/stays/sitter-profile.webp"
                    }
                    alt={partnerName + " test profile"}
                  />
                  <div>
                    <span>LIVE CUSTOMER PROFILE</span>
                    <h3>
                      {role === "Boarding Host"
                        ? "A calm, pet-only home in Indiranagar"
                        : "Trusted overnight care in the pet parent's home"}
                    </h3>
                    <p>
                      Photos, amenities, care rules, availability, capacity,
                      price and reviews publish to the same customer profile.
                    </p>
                    <button
                      onClick={() => action("Customer marketplace profile opened")}
                    >
                      Preview customer view
                    </button>
                  </div>
                </article>
              )}
              <div className={styles.docs}>
                {[
                  "PAN & Aadhaar",
                  "Bank account",
                  "Police verification",
                  "Skill certificates",
                  "Partner agreement",
                  "Emergency contact",
                ].map((d) => (
                  <button key={d}>
                    <span>✓</span>
                    <b>{d}</b>
                    <small>Verified</small>
                    <em>›</em>
                  </button>
                ))}
              </div>
            </section>
            <section className={styles.pageCard}>
              <small>APP PREFERENCES</small>
              <h2>Privacy & notifications</h2>
              {[
                ["Booking notifications", "Sound, push and WhatsApp"],
                ["Payout updates", "Primary mobile and email"],
                ["Location sharing", "Only during active jobs"],
                ["Language", "English"],
                ["Device security", "PIN + biometric enabled"],
              ].map((x) => (
                <button className={styles.preference} key={x[0]}>
                  <div>
                    <b>{x[0]}</b>
                    <small>{x[1]}</small>
                  </div>
                  <em>›</em>
                </button>
              ))}
              <button
                className={styles.danger}
                onClick={() => action("You are now safely signed out")}
              >
                Sign out of this device
              </button>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
