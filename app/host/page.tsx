"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useState } from "react";
import styles from "./host.module.css";

const requests = [
  {
    id: "BR",
    pet: "Bruno",
    detail: "Golden Retriever · 4 yrs",
    dates: "24–27 Aug · 3 nights",
    value: "₹3,897",
    match: "98% match",
    note: "Friendly, medication after breakfast",
    distance: "3.2 km away",
    service: "24-hour Home Boarding",
    offer: "Flexible offer allowed",
  },
  {
    id: "CO",
    pet: "Coco",
    detail: "Persian cat · 3 yrs",
    dates: "29–31 Aug · 2 nights",
    value: "₹2,998",
    match: "95% match",
    note: "One-family stay · indoor only",
    distance: "8.6 km away",
    service: "12-hour Pet Sitting",
    offer: "Fixed PawSpace rate",
  },
];

export default function HostPage() {
  const [tab, setTab] = useState<
    "today" | "requests" | "calendar" | "earnings" | "profile"
  >("today");
  const [selected, setSelected] = useState(requests[0]);
  const [toast, setToast] = useState("");
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2300);
  };
  return (
    <main className={styles.shell}>
      <aside>
        <Link href="/boarding">
          <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        </Link>
        <div className={styles.host}>
          <span>MR</span>
          <div>
            <strong>Maya & Rohan</strong>
            <small>Elite host · 4.9 ★</small>
          </div>
        </div>
        <nav>
          {[
            ["today", "⌂", "Today"],
            ["requests", "▤", "Requests"],
            ["calendar", "▦", "Availability"],
            ["earnings", "₹", "Earnings"],
            ["profile", "♙", "Home profile"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={tab === id ? styles.active : ""}
              onClick={() => setTab(id as typeof tab)}
            >
              <i>{icon}</i>
              {label}
              {id === "requests" && <b>2</b>}
            </button>
          ))}
        </nav>
        <div className={styles.sideFoot}>
          <Link href="/boarding">← Customer marketplace</Link>
          <button onClick={() => notify("PawSpace Host Support opened")}>
            ◎ Host support
          </button>
        </div>
      </aside>
      <section className={styles.main}>
        <header>
          <div>
            <p>MONDAY · 3 AUGUST</p>
            <h1>
              {tab === "today"
                ? "Good morning, Maya"
                : tab === "requests"
                  ? "Booking requests"
                  : tab === "calendar"
                    ? "Your availability"
                    : tab === "earnings"
                      ? "Earnings & payouts"
                      : "Your home profile"}
            </h1>
          </div>
          <span className={styles.live}>● Accepting bookings</span>
        </header>
        {tab === "today" && (
          <>
            <section className={styles.metrics}>
              <article>
                <span>Current guests</span>
                <strong>2</strong>
                <small>Bruno & Pixel</small>
              </article>
              <article>
                <span>Next update due</span>
                <strong>12:30 PM</strong>
                <small>Bruno · medication</small>
              </article>
              <article>
                <span>August earnings</span>
                <strong>₹28,740</strong>
                <small>₹12,480 upcoming</small>
              </article>
              <article>
                <span>Care score</span>
                <strong>96 / 100</strong>
                <small>Elite host standard</small>
              </article>
            </section>
            <section className={styles.todayGrid}>
              <div className={styles.panel}>
                <div className={styles.panelHead}>
                  <div>
                    <span>LIVE STAY · PSB-1039</span>
                    <h2>Bruno&apos;s Care Card</h2>
                  </div>
                  <button
                    onClick={() => notify("Photo and update composer opened")}
                  >
                    ＋ Add update
                  </button>
                </div>
                <div className={styles.petHero}>
                  <span>BR</span>
                  <div>
                    <h3>Bruno</h3>
                    <p>Golden Retriever · Day 2 of 4</p>
                  </div>
                  <button onClick={() => notify("Secure customer chat opened")}>
                    Message Ananya
                  </button>
                </div>
                <div className={styles.tasks}>
                  {[
                    ["✓", "Breakfast", "Completed 7:42 AM"],
                    ["✓", "Morning walk", "32 min · toilet logged"],
                    ["!", "Medication", "Due 12:30 PM"],
                    ["○", "Photo update", "Due before 2 PM"],
                    ["○", "Evening walk", "6:30 PM"],
                  ].map((item) => (
                    <button
                      key={item[1]}
                      onClick={() => notify(`${item[1]} logged to Care Card`)}
                    >
                      <i>{item[0]}</i>
                      <div>
                        <strong>{item[1]}</strong>
                        <small>{item[2]}</small>
                      </div>
                      <span>›</span>
                    </button>
                  ))}
                </div>
                <div className={styles.quick}>
                  <button onClick={() => notify("Meal recorded")}>
                    🍲 Log meal
                  </button>
                  <button onClick={() => notify("Walk timer started")}>
                    🦮 Start walk
                  </button>
                  <button onClick={() => notify("Medication recorded")}>
                    💊 Medication
                  </button>
                  <button onClick={() => notify("Camera opened")}>
                    📷 Photo
                  </button>
                </div>
              </div>
              <aside className={styles.panel}>
                <div className={styles.panelHead}>
                  <div>
                    <span>TODAY</span>
                    <h2>Stay timeline</h2>
                  </div>
                </div>
                {[
                  ["9:30 AM", "Pixel · Drop-off", "Care plan reviewed"],
                  ["12:30 PM", "Bruno · Medication", "Reminder set"],
                  ["4:00 PM", "Meet & Greet", "Coco · new request"],
                  ["6:30 PM", "Both pets · Walk", "Separate routes"],
                ].map((item) => (
                  <article className={styles.timeline} key={item[0]}>
                    <b>{item[0]}</b>
                    <div>
                      <strong>{item[1]}</strong>
                      <small>{item[2]}</small>
                    </div>
                  </article>
                ))}
                <button
                  className={styles.emergency}
                  onClick={() => notify("Safety & incident flow opened")}
                >
                  ⚠ Report a concern
                </button>
              </aside>
            </section>
          </>
        )}
        {tab === "requests" && (
          <section className={styles.requestLayout}>
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <div>
                  <span>15 KM MARKETPLACE · RESPOND WITHIN 30 MIN</span>
                  <h2>Commission booking requests</h2>
                </div>
              </div>
              {requests.map((request) => (
                <button
                  key={request.pet}
                  className={`${styles.request} ${selected.pet === request.pet ? styles.selected : ""}`}
                  onClick={() => setSelected(request)}
                >
                  <span>{request.id}</span>
                  <div>
                    <strong>{request.pet}</strong>
                    <small>
                      {request.detail} · {request.dates}
                      <br />{request.distance} · {request.service}
                    </small>
                  </div>
                  <b>{request.match}</b>
                </button>
              ))}
            </div>
            <aside className={styles.panel}>
              <span className={styles.match}>{selected.match}</span>
              <h2>{selected.pet}&apos;s stay request</h2>
              <p>
                {selected.detail}
                <br />
                {selected.dates}
              </p>
              <div className={styles.careNotes}>
                <strong>Care notes</strong>
                <span>{selected.note}</span>
                <span>✓ Pickup/drop, three walks and medication requested</span>
                <span>✓ Veg/non-veg food preference shared</span>
                <span>✓ 1-hour play time and special request shared</span>
                <span>✓ Pet profile complete</span>
                <span>✓ Emergency contact added</span>
                <span>✓ Vet details verified</span>
              </div>
              <dl>
                <div>
                  <dt>Your earnings</dt>
                  <dd>{selected.value}</dd>
                </div>
                <div>
                  <dt>Pricing</dt>
                  <dd>{selected.offer}</dd>
                </div>
                <div>
                  <dt>Payout</dt>
                  <dd>48 hrs after checkout</dd>
                </div>
              </dl>
              <div className={styles.actions}>
                <button onClick={() => notify("Secure in-app chat opened")}>
                  Chat with parent
                </button>
                <button onClick={() => notify("Flexible price offer sent")}>
                  Send price offer
                </button>
                <button
                  onClick={() => notify("Suggested Meet & Greet times sent")}
                >
                  Suggest Meet & Greet
                </button>
                <button
                  onClick={() => notify("Booking approved and calendar blocked")}
                >
                  Approve booking
                </button>
              </div>
            </aside>
          </section>
        )}
        {tab === "calendar" && (
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <div>
                <span>AUGUST 2026</span>
                <h2>Capacity & availability</h2>
              </div>
              <button onClick={() => notify("Availability saved")}>
                Save changes
              </button>
            </div>
            <div className={styles.calendar}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                <button
                  key={day}
                  className={
                    day >= 6 && day <= 10
                      ? styles.booked
                      : day === 18
                        ? styles.blocked
                        : day > 23 && day < 28
                          ? styles.pending
                          : ""
                  }
                >
                  <span>{day}</span>
                  <small>
                    {day >= 6 && day <= 10
                      ? "2 guests"
                      : day === 18
                        ? "Blocked"
                        : day > 23 && day < 28
                          ? "1 guest"
                          : "Available"}
                  </small>
                </button>
              ))}
            </div>
            <div className={styles.legend}>
              <span>● Available</span>
              <span>● Booked</span>
              <span>● Pending</span>
              <span>● Personal block</span>
            </div>
          </section>
        )}
        {tab === "earnings" && (
          <>
            <section className={styles.metrics}>
              <article>
                <span>Available balance</span>
                <strong>₹18,420</strong>
                <small>Next payout 5 Aug</small>
              </article>
              <article>
                <span>August booked</span>
                <strong>₹41,220</strong>
                <small>12 stay nights</small>
              </article>
              <article>
                <span>Average nightly</span>
                <strong>₹1,374</strong>
                <small>After service fee</small>
              </article>
              <article>
                <span>Repeat earnings</span>
                <strong>₹16,180</strong>
                <small>39% from repeat families</small>
              </article>
            </section>
            <section className={styles.panel}>
              <div className={styles.panelHead}>
                <div>
                  <span>TRANSPARENT PAYOUTS</span>
                  <h2>Recent earnings</h2>
                </div>
                <button onClick={() => notify("Payout statement downloaded")}>
                  Download statement
                </button>
              </div>
              {[
                ["PSB-1028", "Milo · 4 nights", "Paid · 28 Jul", "₹5,196"],
                ["PSB-1032", "Coco · 2 nights", "Paid · 31 Jul", "₹2,998"],
                ["PSB-1039", "Bruno · 4 nights", "In progress", "₹5,196"],
                ["PSB-1048", "Bruno · 3 nights", "Upcoming", "₹3,897"],
              ].map((row) => (
                <div className={styles.earning} key={row[0]}>
                  <b>{row[0]}</b>
                  <span>{row[1]}</span>
                  <small>{row[2]}</small>
                  <strong>{row[3]}</strong>
                </div>
              ))}
            </section>
          </>
        )}
        {tab === "profile" && (
          <section className={styles.profileGrid}>
            <div className={styles.panel}>
              <div className={styles.panelHead}>
                <div>
                  <span>PUBLIC PROFILE · LIVE IN CUSTOMER MARKETPLACE</span>
                  <h2>Your PawSpace home</h2>
                </div>
                <button onClick={() => notify("Profile editor opened")}>
                  Edit profile
                </button>
              </div>
              <div className={styles.photos}>
                <figure>
                  <img
                    src="/assets/stays/maya-rohan-profile.webp"
                    alt="Maya and Rohan test profile"
                  />
                  <figcaption>Host profile</figcaption>
                </figure>
                <figure>
                  <img
                    src="/assets/stays/indiranagar-home.webp"
                    alt="Test boarding home"
                  />
                  <figcaption>Living room & terrace</figcaption>
                </figure>
                <figure>
                  <img
                    src="/assets/stays/pet-guest-room.webp"
                    alt="Test pet guest room"
                  />
                  <figcaption>Pet guest room</figcaption>
                </figure>
              </div>
              <h3>A calm, pet-only home in Indiranagar</h3>
              <p>
                We host a maximum of two pets and one family at a time. Both of
                us work from home, so guests have 24/7 supervision.
              </p>
              <div className={styles.badges}>
                <span>✓ 24/7 supervision</span>
                <span>✓ One family at a time</span>
                <span>✓ Daily photo updates</span>
                <span>✓ Vet within 2 km</span>
                <span>✓ Identity verified</span>
                <span>✓ Home inspected</span>
                <span>✓ First aid trained</span>
                <span>✓ Background checked</span>
              </div>
              <div className={styles.marketSync}>
                <b>Customer profile is connected</b>
                <span>
                  Photos, amenities, home rules, prices, reviews, calendar and
                  capacity published here are shown in the customer booking
                  journey.
                </span>
                <button onClick={() => notify("Customer profile preview opened")}>
                  Preview as pet parent
                </button>
              </div>
            </div>
            <aside className={styles.panel}>
              <span>PROFILE PERFORMANCE</span>
              <h2>Families trust you</h2>
              <dl>
                <div>
                  <dt>Rating</dt>
                  <dd>4.9 ★</dd>
                </div>
                <div>
                  <dt>Repeat families</dt>
                  <dd>63</dd>
                </div>
                <div>
                  <dt>Response time</dt>
                  <dd>8 min</dd>
                </div>
                <div>
                  <dt>Acceptance</dt>
                  <dd>92%</dd>
                </div>
                <div>
                  <dt>Care Card completion</dt>
                  <dd>98%</dd>
                </div>
              </dl>
            </aside>
          </section>
        )}
      </section>
      {toast && <div className={styles.toast}>✓ {toast}</div>}
    </main>
  );
}
