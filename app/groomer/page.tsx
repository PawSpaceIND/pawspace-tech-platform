"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { ChangeEvent, useMemo, useState } from "react";
import styles from "./groomer.module.css";
import { recordBookingOperation, type BookingOperationResult } from "../../lib/booking-operations-client";

type Screen = "today" | "earnings" | "profile";
type JobStatus = "Confirmed" | "Accepted" | "On the way" | "Arrived" | "In service" | "Completed";

const jobs = [
  { id: "PS-2841", time: "9:00–11:00 AM", customer: "Ananya Rao", phone: "••••• 48102", secondary: "••••• 22741", pet: "Bruno", petMeta: "Golden Retriever · 4 years", package: "Bath & Basic Grooming", zone: "Koramangala", address: "5th Block, Koramangala", amount: 1899, pay: "Paid online", pets: 1, notes: "Friendly dog. Use hypoallergenic shampoo.", status: "In service" as JobStatus },
  { id: "PS-2847", time: "1:00–3:00 PM", customer: "Rohit Iyer", phone: "••••• 99318", secondary: "••••• 10426", pet: "Simba & Coco", petMeta: "2 Persian cats · family booking", package: "Bath & Basic Grooming", zone: "Koramangala", address: "Ejipura Main Road", amount: 3298, pay: "Pay after service", pets: 2, notes: "Coco is nervous around the dryer. Start with Simba.", status: "Accepted" as JobStatus },
  { id: "PS-2853", time: "5:00–7:00 PM", customer: "Nisha Patel", phone: "••••• 87001", secondary: "••••• 33098", pet: "Milo", petMeta: "Shih Tzu · 8 months", package: "Complete Makeover", zone: "Indiranagar", address: "12th Main, Indiranagar", amount: 1399, pay: "Pay after service", pets: 1, notes: "Puppy package. Ask about doorstep training.", status: "Confirmed" as JobStatus },
];

const progress: JobStatus[] = ["Confirmed", "Accepted", "On the way", "Arrived", "In service", "Completed"];
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

export default function GroomerPage() {
  const [screen, setScreen] = useState<Screen>("today");
  const [selectedId, setSelectedId] = useState(jobs[0].id);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>(() => Object.fromEntries(jobs.map((job) => [job.id, job.status])));
  const [beforePhotos, setBeforePhotos] = useState(0);
  const [afterPhotos, setAfterPhotos] = useState(0);
  const [addons, setAddons] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);
  const [live, setLive] = useState(true);
  const [toast, setToast] = useState("");
  const [delayMinutes, setDelayMinutes] = useState(30);
  const [operationResult, setOperationResult] = useState<BookingOperationResult | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);

  const job = jobs.find((item) => item.id === selectedId) ?? jobs[0];
  const status = statuses[job.id];
  const addonTotal = addons.reduce((total, item) => total + (item === "Tick & flea treatment" ? 499 : 299), 0);
  const total = job.amount + addonTotal;
  const step = progress.indexOf(status);
  const completed = useMemo(() => Object.values(statuses).filter((value) => value === "Completed").length, [statuses]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }

  function move(next: JobStatus) {
    if (next === "In service" && beforePhotos === 0) return notify("Add at least one before photo first");
    if (next === "Completed" && afterPhotos === 0) return notify("Add at least one after photo first");
    setStatuses((current) => ({ ...current, [job.id]: next }));
    notify(`${job.id} updated to ${next}`);
  }

  function capture(event: ChangeEvent<HTMLInputElement>, type: "before" | "after") {
    const count = event.target.files?.length ?? 0;
    if (type === "before") setBeforePhotos(count); else setAfterPhotos(count);
    if (count) notify(`${count} ${type}-service photo${count > 1 ? "s" : ""} ready`);
  }

  function toggleAddon(name: string) {
    setAddons((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  }

  async function reportOperation(action: "package_upgrade" | "service_overrun" | "running_late" | "vehicle_issue" | "rebook_requested" | "refund_requested") {
    setOperationBusy(true);
    try {
      const result = await recordBookingOperation({
        bookingId: job.id,
        providerId: "groom_arun",
        action,
        reason: action === "package_upgrade" ? "Customer approved Complete Makeover upgrade in the app" : action === "vehicle_issue" ? "Bike issue reported during travel" : action === "service_overrun" ? "Customer-approved package upgrade needs additional service time" : action === "rebook_requested" ? "Delay exceeded the customer comfort window" : action === "refund_requested" ? "Customer requested refund after service disruption" : "Traffic and travel delay reported by groomer",
        impactMinutes: ["package_upgrade", "service_overrun", "running_late", "vehicle_issue"].includes(action) ? delayMinutes : 0,
        upgradedPackageName: action === "package_upgrade" ? "Complete Makeover" : undefined,
        upgradedAmount: action === "package_upgrade" ? Math.max(total, 2399) : undefined,
      });
      setOperationResult(result);
      notify(`${result.notificationsQueued} customer updates queued on the affected orders`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Order update failed");
    } finally {
      setOperationBusy(false);
    }
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.rail}>
        <div className={styles.brand}><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /><span>Groomer partner</span></div>
        <div className={styles.partner}><span>AR</span><div><strong>Arun R.</strong><small>Online · Koramangala</small></div></div>
        <nav>
          <button className={screen === "today" ? styles.active : ""} onClick={() => setScreen("today")}><i>▦</i>Today’s jobs<b>3</b></button>
          <button className={screen === "earnings" ? styles.active : ""} onClick={() => setScreen("earnings")}><i>₹</i>Earnings</button>
          <button className={screen === "profile" ? styles.active : ""} onClick={() => setScreen("profile")}><i>◎</i>My profile</button>
        </nav>
        <div className={styles.railLinks}><Link href="/admin">Admin dashboard</Link><Link href="/">Customer app</Link></div>
      </aside>

      <section className={styles.main}>
        <header className={styles.topbar}>
          <div><p>Monday · 3 August</p><h1>{screen === "today" ? "Good morning, Arun" : screen === "earnings" ? "Earnings & payouts" : "My profile"}</h1></div>
          <button className={live ? styles.online : styles.offline} onClick={() => { setLive((current) => !current); notify(live ? "You are now offline — attendance review may apply" : "You are live for new assignments"); }}><i></i>{live ? "Live for jobs" : "Go live"}</button>
        </header>

        {screen === "today" && <>
          <section className={styles.summary}>
            <article><span>Today’s jobs</span><strong>3</strong><small>1 active · 2 upcoming</small></article>
            <article><span>Expected earnings</span><strong>₹1,690</strong><small>Including incentives</small></article>
            <article><span>Completed</span><strong>{completed} / 3</strong><small>Photos required to close</small></article>
          </section>

          <section className={styles.layout}>
            <div className={styles.jobColumn}>
              <div className={styles.sectionHead}><div><span>MY SCHEDULE</span><h2>Today’s route</h2></div><button onClick={() => notify("Calendar refreshed")}>↻ Refresh</button></div>
              <div className={styles.jobs}>{jobs.map((item, index) => {
                const itemStatus = statuses[item.id];
                return <button key={item.id} className={selectedId === item.id ? styles.selectedJob : ""} onClick={() => { setSelectedId(item.id); setWaiting(false); setPaymentDone(false); setAddons([]); setBeforePhotos(0); setAfterPhotos(0); }}>
                  <span className={styles.routeLine}><i>{index + 1}</i>{index < jobs.length - 1 && <b></b>}</span>
                  <div className={styles.jobTime}><strong>{item.time}</strong><small>{item.zone}</small></div>
                  <div className={styles.jobCopy}><span className={`${styles.status} ${styles[itemStatus.replaceAll(" ", "").toLowerCase()]}`}>{itemStatus}</span><h3>{item.pet} · {item.package}</h3><p>{item.customer} · {item.pets} {item.pets === 1 ? "pet" : "pets"}</p></div>
                  <strong className={styles.jobAmount}>{money(item.amount)}</strong>
                </button>;
              })}</div>
            </div>

            <article className={styles.detail}>
              <div className={styles.detailHead}><div><span>{job.id}</span><h2>{job.pet}</h2><p>{job.petMeta}</p></div><span className={`${styles.bigStatus} ${styles[status.replaceAll(" ", "").toLowerCase()]}`}>{status}</span></div>
              <div className={styles.progress}>{progress.map((item, index) => <div key={item} className={index <= step ? styles.done : ""}><i>{index < step ? "✓" : index + 1}</i><span>{item}</span></div>)}</div>

              <div className={styles.infoGrid}>
                <div><span>Customer</span><strong>{job.customer}</strong><small>Primary {job.phone}<br/>Secondary {job.secondary}</small></div>
                <div><span>Address</span><strong>{job.address}</strong><small>{job.zone}, Bengaluru</small></div>
                <div><span>Package</span><strong>{job.package}</strong><small>{job.pets === 1 ? "Single pet" : `${job.pets}-pet discounted booking`}</small></div>
                <div><span>Payment</span><strong>{job.pay}</strong><small>{money(job.amount)} booked</small></div>
              </div>

              <div className={styles.note}><span>Care note</span><p>{job.notes}</p></div>

              <section className={styles.delayDesk}>
                <header><div><span>LIVE ORDER IMPACT</span><h3>Update this order and the rest of today&apos;s route</h3></div><b>{delayMinutes} min</b></header>
                <p>Package upgrades, longer service time, traffic or a bike issue stay attached to this order. PawSpace recalculates the route and queues updates for every affected customer.</p>
                <label>Expected delay<select value={delayMinutes} onChange={(event) => setDelayMinutes(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={45}>45 minutes</option><option value={60}>60 minutes</option></select></label>
                <div className={styles.delayActions}><button disabled={operationBusy} onClick={() => reportOperation("package_upgrade")}>Package upgraded</button><button disabled={operationBusy} onClick={() => reportOperation("service_overrun")}>Service taking longer</button><button disabled={operationBusy} onClick={() => reportOperation("running_late")}>Running late</button><button disabled={operationBusy} onClick={() => reportOperation("vehicle_issue")}>Bike issue</button></div>
                {operationResult && <article className={styles.impactResult}><b>✓ Order timeline updated</b><span>{operationResult.notificationsQueued} push/WhatsApp messages queued · {operationResult.impactedBookings.length} later booking{operationResult.impactedBookings.length === 1 ? "" : "s"} affected</span>{operationResult.rebookingAvailable && <><small>Delay is 30+ minutes. Customer rebooking is now available.</small><button onClick={() => reportOperation("rebook_requested")}>Open protected rebooking</button></>}</article>}
              </section>

              {step <= 1 && <div className={styles.primaryActions}>
                {status === "Confirmed" && <button className={styles.primaryButton} onClick={() => move("Accepted")}>Accept job</button>}
                {status === "Accepted" && <button className={styles.primaryButton} onClick={() => move("On the way")}>Start travel</button>}
                <button className={styles.secondaryButton} onClick={() => notify("Navigation opened")}>Navigate</button>
              </div>}
              {status === "On the way" && <div className={styles.primaryActions}><button className={styles.primaryButton} onClick={() => move("Arrived")}>I’ve arrived</button><button className={styles.secondaryButton} onClick={() => notify("Customer received ETA update")}>Send ETA</button></div>}

              {status === "Arrived" && <section className={styles.arrivalBox}>
                <div><strong>Customer available?</strong><p>If unreachable, start the waiting timer.</p></div>
                <div className={styles.primaryActions}><button className={styles.primaryButton} onClick={() => notify("Customer arrival confirmed")}>Customer met</button><button className={styles.secondaryButton} onClick={() => setWaiting(true)}>Can’t reach customer</button></div>
                {waiting && <div className={styles.waiting}><span>⏱ 15:00 waiting window started</span><p>At 15 minutes: reminder to customer. At 30 minutes: admin ticket + customer reschedule option.</p><button onClick={() => notify("Reminder sent to primary and secondary numbers")}>Simulate 15-min reminder</button></div>}
              </section>}

              {step >= 3 && step < 5 && <>
                <section className={styles.photoBlock}><div><span>Required proof</span><h3>Before-service photos</h3><p>{beforePhotos ? `✓ ${beforePhotos} photo${beforePhotos > 1 ? "s" : ""} added` : "Add at least one clear photo before starting."}</p></div><label>＋ Add photos<input type="file" accept="image/*" multiple onChange={(event) => capture(event, "before")} /></label></section>
                <section className={styles.addons}><div><span>Customer-approved extras</span><h3>Add-ons</h3></div><label><input type="checkbox" checked={addons.includes("Tick & flea treatment")} onChange={() => toggleAddon("Tick & flea treatment")} /><span>Tick & flea treatment</span><strong>₹499</strong></label><label><input type="checkbox" checked={addons.includes("Oil massage")} onChange={() => toggleAddon("Oil massage")} /><span>Full-body oil massage</span><strong>₹299</strong></label>{addons.length > 0 && <button onClick={() => notify("Approval request sent to primary customer number")}>Send approval request · {money(addonTotal)}</button>}</section>
                {status === "Arrived" && <button className={styles.fullPrimary} onClick={() => move("In service")}>Start service</button>}
                {status === "In service" && <><section className={styles.photoBlock}><div><span>Required proof</span><h3>After-service photos</h3><p>{afterPhotos ? `✓ ${afterPhotos} photo${afterPhotos > 1 ? "s" : ""} added` : "Add the final result before completing."}</p></div><label>＋ Add photos<input type="file" accept="image/*" multiple onChange={(event) => capture(event, "after")} /></label></section><button className={styles.fullPrimary} onClick={() => move("Completed")}>Complete service</button></>}
              </>}

              {status === "Completed" && <section className={styles.paymentCard}><span>Amount to collect</span><strong>{money(total)}</strong><p>Payment details are sent to the customer’s primary number.</p>{job.pay === "Pay after service" && !paymentDone ? <><div className={styles.qr}>▦<small>Razorpay dynamic QR<br/>{job.id}</small></div><div className={styles.primaryActions}><button className={styles.primaryButton} onClick={() => { setPaymentDone(true); notify("Payment marked as received"); }}>Mark paid</button><button className={styles.secondaryButton} onClick={() => notify("Payment link resent to primary number")}>Resend link</button></div></> : <div className={styles.paid}>✓ Payment confirmed and reconciled</div>}</section>}

              <div className={styles.issueActions}><button className={styles.issueButton} onClick={() => notify("Support ticket created for admin")}>⚑ Report an issue to operations</button><button className={styles.issueButton} onClick={() => reportOperation("refund_requested")}>₹ Start refund request</button></div>
            </article>
          </section>
        </>}

        {screen === "earnings" && <section className={styles.earnings}>
          <div className={styles.earningHero}><span>August estimated payout · Full-time model</span><strong>₹34,800</strong><p>84 completed orders · ₹1,48,620 order value</p><button onClick={() => notify("Monthly statement downloaded")}>Download statement</button></div>
          <div className={styles.earningGrid}><article><span>Attendance</span><strong>26 / 26</strong><small>Live on time every working day</small></article><article><span>Add-ons sold</span><strong>18</strong><small>₹630 incentive earned</small></article><article><span>Package upgrades</span><strong>12 / 10</strong><small>Target achieved · ₹1,000 unlocked</small></article></div>
          <section className={styles.incentiveBoard}><div><span>MONTHLY SALES GOAL</span><h2>Upgrade more care, earn more</h2><p>Only recommend what the pet needs. Customer approval is required inside PawSpace.</p></div><div className={styles.goal}><div><span>Package upgrade target</span><strong>12 / 10</strong></div><span><i></i></span><small>✓ ₹1,000 target bonus unlocked</small></div><div className={styles.incentiveItems}><article><span>Add-on incentive</span><strong>₹35 each</strong><small>18 completed · ₹630</small></article><article><span>Package upgrade</span><strong>₹75 each</strong><small>12 completed · ₹900</small></article><article><span>Quality bonus</span><strong>₹2,000</strong><small>4.9 ★ + photo compliance</small></article></div></section>
          <div className={styles.history}><h2>Recent activity</h2><div><span>PS-2814 · Complete Makeover</span><strong>+ ₹720</strong></div><div><span>PS-2808 · Bath & Basic</span><strong>+ ₹560</strong></div><div><span>Cash reconciliation</span><strong className={styles.debit}>− ₹1,899</strong></div></div>
        </section>}

        {screen === "profile" && <section className={styles.profile}>
          <div className={styles.profileHero}><span>AR</span><div><h2>Arun R.</h2><p>Dog & cat groomer · 4.9 ★</p><small>1,248 completed services · Joined 2022</small></div><button onClick={() => notify("Profile edit opened")}>Edit</button></div>
          <div className={styles.profileGrid}><article><span>Working zone</span><strong>Koramangala + 8 km</strong><button onClick={() => notify("Zone preferences opened")}>Change zone</button></article><article><span>Availability</span><strong>9:00 AM–7:00 PM</strong><button onClick={() => notify("Availability calendar opened")}>Manage leave</button></article><article><span>Skills</span><strong>Dogs · Cats · Puppies</strong><button onClick={() => notify("Skill update requested")}>Update skills</button></article><article><span>Documents</span><strong>All verified ✓</strong><button onClick={() => notify("Documents opened")}>View documents</button></article></div>
        </section>}
      </section>

      <nav className={styles.mobileNav}><button className={screen === "today" ? styles.active : ""} onClick={() => setScreen("today")}>▦<span>Jobs</span></button><button className={screen === "earnings" ? styles.active : ""} onClick={() => setScreen("earnings")}>₹<span>Earnings</span></button><button className={screen === "profile" ? styles.active : ""} onClick={() => setScreen("profile")}>◎<span>Profile</span></button></nav>
      {toast && <div className={styles.toast}>✓ {toast}</div>}
    </main>
  );
}
