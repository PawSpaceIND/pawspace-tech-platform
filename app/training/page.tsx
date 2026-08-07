"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useState } from "react";
import styles from "./training.module.css";

const challenges = ["Puppy basics", "Toilet training", "Leash pulling", "Biting & jumping", "Barking", "Separation anxiety", "Reactivity", "Advanced obedience"];
const plans = [
  { name: "Puppy Foundation", sessions: "6 private sessions", detail: "Toilet routine, biting, socialisation, name response and home manners", badge: "Best for puppies" },
  { name: "Everyday Obedience", sessions: "12 private sessions", detail: "Sit, stay, recall, leash walking, impulse control and public manners", badge: "Most popular" },
  { name: "Behaviour Transformation", sessions: "Custom roadmap", detail: "Assessment-led plan for fear, reactivity, guarding or separation distress", badge: "Specialist plan" },
];

export default function TrainingPage() {
  const [view, setView] = useState<"book" | "journey">("book");
  const [pet, setPet] = useState("Bruno");
  const [challenge, setChallenge] = useState("Puppy basics");
  const [selectedPlan, setSelectedPlan] = useState(1);
  const [confirmed, setConfirmed] = useState(false);
  const [toast, setToast] = useState("");

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }

  return <main className={styles.shell}>
    <header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /></Link><nav><button className={view === "book" ? styles.active : ""} onClick={() => setView("book")}>Find training</button><button className={view === "journey" ? styles.active : ""} onClick={() => setView("journey")}>Bruno’s journey</button><Link href="/account">My PawSpace</Link></nav><span>Doorstep dog training · Bengaluru</span></header>

    {view === "book" && !confirmed && <>
      <section className={styles.hero}>
        <div><span className={styles.eyebrow}>REWARD-BASED · PRIVATE · AT HOME</span><h1>A calmer dog.<br/><em>A happier home.</em></h1><p>Get a personalised doorstep training roadmap, a verified trainer and visible progress after every session.</p><div className={styles.trust}><span>✓ Background verified</span><span>✓ 10,000+ dogs trained</span><span>✓ Session-by-session reports</span></div></div>
        <aside><span className={styles.step}>START WITH YOUR DOG</span><label>Which pet needs training?<select value={pet} onChange={(event) => setPet(event.target.value)}><option>Bruno · Golden Retriever</option><option>Milo · Shih Tzu</option><option>＋ Add another dog</option></select></label><label>What would you like help with?<select value={challenge} onChange={(event) => setChallenge(event.target.value)}>{challenges.map((item) => <option key={item}>{item}</option>)}</select></label><div className={styles.slotPick}><span>Preferred consultation</span><button className={styles.selectedSlot}>Today · 6:00 PM</button><button>Tomorrow · 10:00 AM</button></div><button className={styles.primary} onClick={() => notify("Free trainer consultation reserved")}>Check trainer availability →</button><small>No payment required for consultation</small></aside>
      </section>

      <section className={styles.how}><article><i>1</i><div><strong>Understand</strong><span>Tell us your dog’s behaviour, routine and goals.</span></div></article><article><i>2</i><div><strong>Meet your trainer</strong><span>Assessment at home with a verified specialist.</span></div></article><article><i>3</i><div><strong>Follow the roadmap</strong><span>Sessions, homework, videos and progress in PawSpace.</span></div></article></section>

      <section className={styles.plans}><div className={styles.sectionTitle}><span>PERSONALISED PROGRAMMES</span><h2>Choose a starting direction</h2><p>Your trainer confirms the final plan after understanding {pet.split(" ·")[0]}.</p></div><div className={styles.planGrid}>{plans.map((plan, index) => <button key={plan.name} className={selectedPlan === index ? styles.selectedPlan : ""} onClick={() => setSelectedPlan(index)}><span>{plan.badge}</span><h3>{plan.name}</h3><strong>{plan.sessions}</strong><p>{plan.detail}</p><i>{selectedPlan === index ? "✓ Selected" : "Choose plan"}</i></button>)}</div></section>

      <section className={styles.match}><div className={styles.trainerAvatar}>AK</div><div><span>MATCHED FOR {challenge.toUpperCase()}</span><h2>Meet Arjun Kumar</h2><p>Certified canine behaviour trainer · 7 years · 4.9 ★ · 680 families</p><div><b>Reward-based</b><b>Puppy specialist</b><b>English · Hindi · Kannada</b></div></div><aside><strong>Next available</strong><span>Today · 6:00 PM</span><button onClick={() => setConfirmed(true)}>Book free consultation</button></aside></section>
    </>}

    {confirmed && <section className={styles.confirmed}><div className={styles.check}>✓</div><span>CONSULTATION CONFIRMED</span><h1>Arjun will meet {pet.split(" ·")[0]}.</h1><p>Today, 6:00–6:45 PM · At your saved address</p><div className={styles.confirmCard}><div><span>Training goal</span><strong>{challenge}</strong></div><div><span>Suggested direction</span><strong>{plans[selectedPlan].name}</strong></div><div><span>Trainer</span><strong>Arjun Kumar · 4.9 ★</strong></div></div><div className={styles.confirmActions}><button onClick={() => setView("journey")}>Open training journey</button><button onClick={() => notify("Consultation added to calendar")}>Add to calendar</button></div></section>}

    {view === "journey" && <section className={styles.journey}>
      <div className={styles.journeyHero}><div><span>BRUNO’S TRAINING JOURNEY</span><h1>Everyday Obedience</h1><p>Trainer: Arjun Kumar · Started 20 July 2026</p></div><div className={styles.score}><strong>68%</strong><span>Overall progress</span></div></div>
      <div className={styles.journeyGrid}><section className={styles.roadmap}><div className={styles.sectionTitle}><span>12-SESSION ROADMAP</span><h2>Progress that you can see</h2></div>{[
        ["1", "Assessment & foundations", "Completed", "Baseline: 42%"], ["2", "Name response & focus", "Completed", "Improved to 68%"], ["3", "Leash walking indoors", "Next · 5 Aug", "Homework ready"], ["4", "Outdoor distractions", "Upcoming", "Locked"], ["5–12", "Recall, stay & public manners", "Planned", "Personalised"]
      ].map((row, index) => <article key={row[0]} className={index < 2 ? styles.doneSession : index === 2 ? styles.nextSession : ""}><i>{index < 2 ? "✓" : row[0]}</i><div><strong>{row[1]}</strong><span>{row[2]}</span></div><small>{row[3]}</small></article>)}</section>
        <aside className={styles.homework}><span>THIS WEEK’S HOMEWORK</span><h2>Focus before session 3</h2><div className={styles.video}>▶<small>Trainer demo · 01:18</small></div><ul><li>5-minute name-response drill, twice daily</li><li>Reward calm behaviour before meals</li><li>Indoor leash practice without pulling</li></ul><button onClick={() => notify("Homework marked complete")}>✓ Mark today’s practice</button><p>3-day practice streak 🔥</p></aside></div>
      <section className={styles.report}><div><span>LATEST SESSION REPORT</span><h2>Session 2 · Name response & focus</h2><p>Bruno responded consistently indoors and recovered quickly after distractions.</p></div><div className={styles.skills}><span>Focus <b>8/10</b></span><span>Recall <b>6/10</b></span><span>Impulse control <b>7/10</b></span><span>Parent practice <b>9/10</b></span></div><button onClick={() => notify("Full session report opened")}>View notes & media →</button></section>
    </section>}
    {toast && <div className={styles.toast}>✓ {toast}</div>}
  </main>;
}
