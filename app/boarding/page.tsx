"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "./stay.module.css";

type Service = "boarding" | "sitting";
type Host = { id: string; name: string; initials: string; area: string; rating: string; reviews: number; repeat: number; price: number; response: string; badge: string; tags: string[]; pets: string; home: string; tone: string };

const hosts: Host[] = [
  { id: "maya", name: "Maya & Rohan", initials: "MR", area: "Indiranagar", rating: "4.9", reviews: 184, repeat: 63, price: 1299, response: "Replies in 8 min", badge: "PawSpace Elite", tags: ["24/7 supervision", "Fenced terrace", "Senior care"], pets: "Dogs up to 30 kg · 2 guests max", home: "Calm, pet-only home", tone: "violet" },
  { id: "sana", name: "Sana F.", initials: "SF", area: "HSR Layout", rating: "5.0", reviews: 96, repeat: 41, price: 1499, response: "Replies in 5 min", badge: "Top repeat host", tags: ["Medication", "No resident pets", "Pickup available"], pets: "Dogs & cats · one family at a time", home: "Quiet independent home", tone: "green" },
  { id: "arjun", name: "Arjun & Tara", initials: "AT", area: "Koramangala", rating: "4.8", reviews: 212, repeat: 78, price: 1099, response: "Replies in 14 min", badge: "Great for social pets", tags: ["Daily long walks", "Resident beagle", "Camera updates"], pets: "Dogs up to 20 kg · 3 guests max", home: "Lively home with a garden", tone: "orange" },
];

const careEvents = [
  { time: "7:42 AM", icon: "🍲", title: "Breakfast finished", note: "Ate the full portion · fresh water topped up" },
  { time: "8:25 AM", icon: "🦮", title: "Morning walk", note: "32 minutes · pee ✓ · poop ✓" },
  { time: "10:10 AM", icon: "📸", title: "Happy update", note: "Bruno is relaxing after playtime with Maya" },
  { time: "12:30 PM", icon: "💊", title: "Medication given", note: "1 tablet after food · confirmed by host" },
];

export default function BoardingPage() {
  const [service, setService] = useState<Service>("boarding");
  const [petCount, setPetCount] = useState(1);
  const [selectedHost, setSelectedHost] = useState(hosts[0]);
  const [stage, setStage] = useState<"search" | "profile" | "care" | "confirmed">("search");
  const [meet, setMeet] = useState(true);
  const [toast, setToast] = useState("");
  const [filters, setFilters] = useState<string[]>(["24/7 supervision"]);
  const nights = 3;
  const total = useMemo(() => selectedHost.price * nights + Math.max(0, petCount - 1) * 699 * nights + 249, [selectedHost, petCount]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };
  const toggleFilter = (filter: string) => setFilters((current) => current.includes(filter) ? current.filter((item) => item !== filter) : [...current, filter]);

  if (stage === "confirmed") return <main className={styles.shell}>
    <header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /></Link><span className={styles.safe}>✓ Protected booking</span></header>
    <section className={styles.confirmed}>
      <span className={styles.success}>✓</span><p className={styles.kicker}>Stay PSB-1048 confirmed</p><h1>Bruno&apos;s stay is all set.</h1>
      <p>24–27 August · {selectedHost.name} · {selectedHost.area}</p>
      <div className={styles.confirmHost}><span className={`${styles.avatar} ${styles[selectedHost.tone]}`}>{selectedHost.initials}</span><div><strong>{selectedHost.name}</strong><small>{selectedHost.badge} · {selectedHost.rating} ★</small></div><button onClick={() => notify("Secure chat opened")}>Message host</button></div>
      <div className={styles.confirmGrid}><article><span>Next step</span><strong>{meet ? "Meet & Greet · 20 Aug, 5 PM" : "Share final care notes"}</strong><small>We&apos;ll remind both sides</small></article><article><span>Payment protected</span><strong>₹{total.toLocaleString("en-IN")}</strong><small>Released after check-in</small></article><article><span>Emergency support</span><strong>24/7 PawSpace Care</strong><small>One-tap escalation</small></article></div>
      <div className={styles.careCard}><div><p className={styles.kicker}>PawSpace Care Card</p><h2>Every detail, while you&apos;re away.</h2></div>{careEvents.map((event) => <article key={event.time}><span>{event.icon}</span><div><strong>{event.title}</strong><small>{event.time} · {event.note}</small></div></article>)}</div>
      <div className={styles.confirmActions}><Link href="/account">View in My PawSpace</Link><button onClick={() => setStage("search")}>Book another stay</button></div>
    </section>{toast && <div className={styles.toast}>✓ {toast}</div>}
  </main>;

  return <main className={styles.shell}>
    <header className={styles.header}><Link href="/"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /></Link><nav><Link href="/sitting">Pet Sitting</Link><Link href="/">Grooming</Link><Link href="/training">Dog training</Link><Link href="/account">My PawSpace</Link><Link href="/host">Become a host</Link></nav><button onClick={() => notify("Login opens only when you book")}>Log in</button></header>

    <section className={styles.hero}>
      <div><span className={styles.trust}>PAWSPACE STAYS · VERIFIED CARE</span><h1>A second home,<br/><em>chosen by you.</em></h1><p>Compare trusted caregivers, meet them first and follow every meal, walk and happy moment while you&apos;re away.</p><div className={styles.proof}><span>✓ Identity & home verified</span><span>✓ Secure payments</span><span>✓ 24/7 care support</span></div></div>
      <aside><div className={styles.heroPet}>🐕</div><div className={styles.updateBubble}><span>New update from Maya</span><strong>Bruno finished breakfast ✓</strong><small>Photo added · 2 min ago</small></div></aside>
    </section>

    <section className={styles.searchCard}>
      <div className={styles.serviceSwitch}><button className={service === "boarding" ? styles.active : ""} onClick={() => setService("boarding")}><span>🏡</span><strong>Home Boarding</strong><small>Your pet stays in a host&apos;s home</small></button><button className={service === "sitting" ? styles.active : ""} onClick={() => setService("sitting")}><span>🛋️</span><strong>Pet Sitting</strong><small>A sitter cares for pets at your home</small></button></div>
      <div className={styles.searchFields}><label><span>Where in Bangalore?</span><select><option>Indiranagar</option><option>Koramangala</option><option>HSR Layout</option><option>Whitefield</option><option>JP Nagar</option></select></label><label><span>Drop-off</span><input type="date" defaultValue="2026-08-24" /></label><label><span>Pick-up</span><input type="date" defaultValue="2026-08-27" /></label><label><span>Pets</span><select value={petCount} onChange={(event) => setPetCount(Number(event.target.value))}><option value="1">Bruno · 1 pet</option><option value="2">Bruno + Milo · 2 pets</option><option value="3">3 registered pets</option><option value="4">4 registered pets</option></select></label><button onClick={() => document.getElementById("matches")?.scrollIntoView({ behavior: "smooth" })}>Find trusted care →</button></div>
      <p>No pincode needed · Browse homes and availability before OTP</p>
    </section>

    <section className={styles.flow}><span><b>1</b> Compare verified hosts</span><i></i><span><b>2</b> Meet before booking</span><i></i><span><b>3</b> Book securely</span><i></i><span><b>4</b> Get live Care Cards</span></section>

    <section className={styles.market} id="matches">
      <aside className={styles.filters}><p className={styles.kicker}>MATCH BRUNO&apos;S NEEDS</p><h2>Care preferences</h2>{["24/7 supervision", "No resident pets", "Fenced outdoor space", "Medication support", "Pickup & drop", "One family at a time"].map((filter) => <button key={filter} className={filters.includes(filter) ? styles.filterOn : ""} onClick={() => toggleFilter(filter)}><i>{filters.includes(filter) ? "✓" : ""}</i>{filter}</button>)}<div><strong>Bruno&apos;s profile</strong><span>Golden Retriever · 4 years</span><span>Friendly · daily medication</span><Link href="/account">Edit care profile →</Link></div></aside>
      <div className={styles.results}><div className={styles.resultsHead}><div><p className={styles.kicker}>12 AVAILABLE MATCHES</p><h2>Homes selected for Bruno</h2></div><select><option>Best match</option><option>Top rated</option><option>Lowest price</option></select></div>
        {hosts.map((host, index) => <article className={styles.hostCard} key={host.id}><div className={`${styles.hostVisual} ${styles[host.tone]}`}><span>{host.initials}</span><small>{index === 0 ? "98% care match" : `${95-index * 3}% care match`}</small></div><div className={styles.hostInfo}><div><span className={styles.hostBadge}>{host.badge}</span><h3>{host.name}</h3><p>📍 {host.area} · {host.response}</p></div><div className={styles.rating}><strong>{host.rating} ★</strong><small>{host.reviews} reviews</small></div><p>{host.home} · {host.pets}</p><div className={styles.tags}>{host.tags.map((tag) => <span key={tag}>✓ {tag}</span>)}</div><div className={styles.hostFoot}><span><b>{host.repeat}</b> repeat families</span><strong>₹{host.price.toLocaleString("en-IN")}<small> / night</small></strong><button onClick={() => { setSelectedHost(host); setStage("profile"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>View home</button></div></div></article>)}
      </div>
    </section>

    {stage === "profile" && <div className={styles.modalBack} onMouseDown={() => setStage("search")}><section className={styles.modal} onMouseDown={(event) => event.stopPropagation()}><button className={styles.close} onClick={() => setStage("search")}>×</button><div className={styles.profileHero}><div className={`${styles.profilePortrait} ${styles[selectedHost.tone]}`}>{selectedHost.initials}</div><div><span className={styles.hostBadge}>{selectedHost.badge}</span><h2>{selectedHost.name}</h2><p>{selectedHost.rating} ★ · {selectedHost.reviews} reviews · {selectedHost.repeat} repeat families</p></div></div><div className={styles.gallery}><span>Sunny pet room</span><span>Secure balcony</span><span>Daily walks</span></div><div className={styles.profileCols}><div><h3>Why pets feel at home</h3><p>{selectedHost.home}. A calm routine, supervised play and updates tailored to your preferences.</p><h3>A typical day</h3><ul><li>7:30 AM · Breakfast and medication</li><li>8:15 AM · Neighbourhood walk</li><li>Afternoon · Rest, enrichment and photo update</li><li>6:30 PM · Evening walk and dinner</li></ul></div><aside><span>Your stay · 3 nights</span><strong>₹{selectedHost.price.toLocaleString("en-IN")} / night</strong><small>24–27 August · Bruno</small><label><input type="checkbox" checked={meet} onChange={(event) => setMeet(event.target.checked)} /> Meet & Greet before booking</label><button onClick={() => setStage("care")}>Continue with {selectedHost.name.split(" ")[0]} →</button><em>No charge until you confirm</em></aside></div></section></div>}

    {stage === "care" && <div className={styles.modalBack}><section className={`${styles.modal} ${styles.careModal}`}><button className={styles.close} onClick={() => setStage("profile")}>←</button><p className={styles.kicker}>FINAL CARE PLAN</p><h2>Make Bruno feel at home</h2><div className={styles.careForm}><label>Food routine<textarea defaultValue="1 cup dry food at 7:30 AM and 6:30 PM. Treats are okay after walks." /></label><label>Walk & toilet routine<textarea defaultValue="Two 30-minute walks. Toilet break before bedtime." /></label><label>Medication & health<textarea defaultValue="One tablet after breakfast. Vet: Cessna Lifeline, Domlur." /></label><label>Emergency contact<input defaultValue="Rahul · +91 98802 22741" /></label></div><div className={styles.addons}><button>✓ Pickup & drop · ₹499</button><button>＋ Groom before return · from ₹1,349</button><button>＋ Extra long walk · ₹249</button></div><div className={styles.payBox}><div><span>{selectedHost.name} · 3 nights</span><span>PawSpace protection & support</span><strong>Total</strong></div><div><span>₹{(total-249).toLocaleString("en-IN")}</span><span>₹249</span><strong>₹{total.toLocaleString("en-IN")}</strong></div></div><button className={styles.confirmBtn} onClick={() => { setStage("confirmed"); window.scrollTo({ top: 0 }); }}>Verify mobile & confirm securely →</button><small className={styles.otpNote}>OTP is requested only now. Primary and secondary contacts receive the booking and emergency details.</small></section></div>}
    {toast && <div className={styles.toast}>✓ {toast}</div>}
  </main>;
}
