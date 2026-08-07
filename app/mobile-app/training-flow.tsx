"use client";
import { useEffect, useState } from "react";
import baseStyles from "./training.module.css";
import extraStyles from "./training-extra.module.css";
import planStyles from "./training-plans.module.css";
import { createTestTransaction } from "../../lib/test-transaction";
import ProviderTrackingCard from "./provider-tracking-card";
import CouponField from "./coupon-field";
import { reserveUatSchedule } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";
import { materializeTrainingProgramme } from "../../lib/training-programme-client";
const styles = { ...baseStyles, ...extraStyles };
type Plan = {
  name: string;
  sessions: number;
  sessionLabel: string;
  validity: string;
  price: number;
  detail: string;
  bonus: boolean;
  level: string;
  idealFor: string;
  outcomes: string[];
  recommended?: boolean;
};
const fallbackGoals = [
  "Toilet routine",
  "Biting & chewing",
  "Leash walking",
  "Recall",
  "Basic obedience",
  "Socialisation",
  "Excess barking",
  "Separation anxiety",
];
const trainingPets = [
  { name: "Bruno", detail: "Golden Retriever · 4 years", icon: "🐕" },
  { name: "Milo", detail: "Beagle · 2 years", icon: "🐶" },
  { name: "Luna", detail: "Indie · 3 years", icon: "🐕" },
  { name: "Toby", detail: "Shih Tzu · 1 year", icon: "🐶" },
];
const plans: Plan[] = [
  {
    name: "Starter Plan",
    sessions: 2,
    sessionLabel: "2 sessions",
    validity: "1 month",
    price: 3500,
    detail:
      "Professional guidance and a clear starting structure for dogs of any age.",
    bonus: false,
    level: "Assessment start",
    idealFor: "Parents who need a professional plan before committing long-term",
    outcomes: ["Behaviour assessment", "Home routine", "Action plan"],
  },
  {
    name: "Puppy Training Plan",
    sessions: 4,
    sessionLabel: "4 sessions",
    validity: "1 month",
    price: 6000,
    detail:
      "Early habits, confidence, socialisation and essential puppy foundations.",
    bonus: false,
    level: "Puppy foundation",
    idealFor: "Puppies up to 8 months building their first routines",
    outcomes: ["Toilet routine", "Biting control", "Social confidence"],
  },
  {
    name: "Basic Obedience Plan",
    sessions: 8,
    sessionLabel: "8 sessions",
    validity: "2 months",
    price: 12000,
    detail: "Obedience, impulse control, home manners and communication.",
    bonus: true,
    level: "Core programme",
    idealFor: "Everyday manners, focus and reliable basic commands",
    outcomes: ["Sit, stay and recall", "Impulse control", "Home manners"],
    recommended: true,
  },
  {
    name: "Leash Obedience Plan · 8",
    sessions: 8,
    sessionLabel: "8 sessions",
    validity: "2 months",
    price: 12000,
    detail:
      "Pulling, reactivity, heel positioning and real-world walking control.",
    bonus: true,
    level: "Leash focus",
    idealFor: "Dogs who pull, lunge or lose focus outdoors",
    outcomes: ["Loose-leash walk", "Heel position", "Calm passing"],
  },
  {
    name: "Leash Obedience Plan · 12",
    sessions: 12,
    sessionLabel: "12 sessions",
    validity: "3 months",
    price: 16500,
    detail: "Extended leash, recall and distraction-control programme.",
    bonus: true,
    level: "Leash intensive",
    idealFor: "Persistent pulling or reactivity needing more practice",
    outcomes: ["Leash control", "Outdoor recall", "Distraction work"],
  },
  {
    name: "Advanced Obedience Plan",
    sessions: 12,
    sessionLabel: "10–12 sessions",
    validity: "3 months",
    price: 16500,
    detail: "Reliable commands, impulse control and real-world manners.",
    bonus: true,
    level: "Advanced",
    idealFor: "Dogs ready to work reliably around real-world distractions",
    outcomes: ["Distance commands", "Advanced recall", "Public manners"],
  },
  {
    name: "Pro Training Plan",
    sessions: 16,
    sessionLabel: "14–16 sessions",
    validity: "3 months",
    price: 20000,
    detail:
      "High-level obedience, heel work, distance control and complex behaviour.",
    bonus: true,
    level: "Professional",
    idealFor: "Families seeking the most complete obedience programme",
    outcomes: ["Off-leash control", "Complex behaviour", "Handler mastery"],
  },
];
const trainers = [
  {
    name: "Kiran S.",
    score: "4.9",
    jobs: "1,180 dogs",
    match: "98% match",
    model: "Commission partner",
  },
  {
    name: "Ramesh P.",
    score: "4.8",
    jobs: "860 dogs",
    match: "94% match",
    model: "Commission partner",
  },
];
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
export default function TrainingFlow() {
  const [stage, setStage] = useState(1),
    [goals, setGoals] = useState(fallbackGoals),
    [selectedGoals, setSelectedGoals] = useState([
      "Basic obedience",
      "Leash walking",
    ]),
    [selectedPets, setSelectedPets] = useState(["Bruno"]),
    [plan, setPlan] = useState(plans[2]),
    [trainer, setTrainer] = useState(trainers[0]),
    [frequency, setFrequency] = useState("Tue & Sat"),
    [time, setTime] = useState("5:00 PM"),
    [attendanceMode, setAttendanceMode] = useState<"parent" | "trainer-led">("parent"),
    [meet, setMeet] = useState(true),
    [meetSlot, setMeetSlot] = useState("7 Aug · 6:00 PM"),
    [meetBookingId, setMeetBookingId] = useState(""),
    [paymentMode, setPaymentMode] = useState<"half" | "full">("half"),
    [discount, setDiscount] = useState(0),
    [couponCode, setCouponCode] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(true),
    [bookingId, setBookingId] = useState(""),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [customGoal, setCustomGoal] = useState(""),
    [addingGoal, setAddingGoal] = useState(false),
    [view, setView] = useState<"plan" | "homework" | "progress">("plan");
  useEffect(() => {
    void fetch("/api/training-requirements")
      .then((response) => response.json())
      .then((body: { data?: Array<{ label: string; active: number }> }) => {
        const activeGoals = body.data?.filter((item) => item.active).map((item) => item.label);
        if (activeGoals?.length) setGoals(activeGoals);
      })
      .catch(() => undefined);
  }, []);
  const directTrainingMinutes = selectedPets.length * 45;
  const closeoutMinutes = selectedPets.length * 15;
  const serviceMinutes = directTrainingMinutes + closeoutMinutes;
  const meetFee = meet ? 500 : 0;
  const packagePayable = Math.max(0, plan.price - discount);
  const payableNow = paymentMode === "full" ? packagePayable + meetFee : plan.price / 2 + meetFee;
  const togglePet = (pet: string) =>
    setSelectedPets((current) =>
      current.includes(pet)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== pet)
        : current.length < 4
          ? [...current, pet]
          : current,
    );
  const toggle = (goal: string) =>
      setSelectedGoals((x) =>
        x.includes(goal) ? x.filter((i) => i !== goal) : [...x, goal],
      ),
    addCustomGoal = () => {
      const value = customGoal.trim();
      if (value.length < 3) return;
      if (!goals.some((goal) => goal.toLowerCase() === value.toLowerCase())) setGoals((current) => [...current, value]);
      if (!selectedGoals.some((goal) => goal.toLowerCase() === value.toLowerCase())) setSelectedGoals((current) => [...current, value]);
      setCustomGoal("");
      setAddingGoal(false);
    },
    confirmMeetFirst = async () => {
      setScheduling(true);setScheduleError("");
      try {
        const start=new Date("2026-08-07T12:30:00.000Z");
        const end=new Date(start.getTime()+45*60_000);
        const requestId=`training-meet-TST101-${trainer.name.replaceAll(" ","")}-${meetSlot.replaceAll(" ","")}`;
        const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:"TST-101",petIds:selectedPets,serviceCode:"dog_training",zoneId:"blr-east",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),occurrences:1,preferredProviderId:trainer.name==="Kiran S."?"train_kiran":"train_ramesh"});
        const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:"TST-101",name:"Karthik P.",primaryPhone:"9996999505",secondaryPhone:"9880222741"},pets:selectedPets.map(name=>({sourceId:name,name,species:"dog"})),cityId:"blr",zoneId:"blr-east",serviceCode:"dog_training",packageCode:"trainer-meet-greet",packageName:"Trainer Meet & Greet",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:decision.provider,totalAmount:500,amountDueNow:500,payment:{method:"upi",mode:"prepaid",status:"captured",detail:"UAT trainer Meet & Greet payment"},pricing:{discount:0}});
        setMeetBookingId(canonical.bookingId);setMeet(false);
      } catch(error){setScheduleError(error instanceof Error?error.message:"This Meet & Greet slot is no longer available");} finally {setScheduling(false);}
    },
    confirm = async () => {
      setScheduling(true);setScheduleError("");
      try {
      const hour=time.startsWith("9")?9:time.startsWith("3")?15:17;const start=new Date(Date.UTC(2026,7,9,hour-5,30));const end=new Date(start.getTime()+serviceMinutes*60_000);const weekdayMap:Record<string,number[]>={"Tue & Sat":[2,6],"Wed & Sun":[3,0],"Every Saturday":[6]};const requestId=`training-TST101-${plan.sessions}-${hour}-${frequency.replaceAll(" ","")}`;const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:"TST-101",petIds:selectedPets,serviceCode:"dog_training",zoneId:"blr-east",scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),occurrences:plan.sessions,weekdays:weekdayMap[frequency],cadenceDays:frequency==="Choose each session myself"?7:undefined,preferredProviderId:trainer.name==="Kiran S."?"train_kiran":"train_ramesh"});
      const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:"TST-101",name:"Karthik P.",primaryPhone:"9996999505",secondaryPhone:"9880222741"},pets:selectedPets.map(name=>({sourceId:name,name,species:"dog"})),cityId:"blr",zoneId:"blr-east",serviceCode:"dog_training",packageCode:`training-${plan.sessions}`,packageName:plan.name,scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:decision.provider,totalAmount:packagePayable+meetFee,amountDueNow:payableNow,payment:{method:"upi",mode:paymentMode==="full"?"prepaid":"split",status:"captured",detail:`UAT ${paymentMode} training payment`},pricing:{discount,couponCode:couponCode||undefined,subscription:`${plan.sessions} sessions`,requirements:selectedGoals}});
      await materializeTrainingProgramme({bookingId:canonical.bookingId,meetBookingId:meetBookingId||undefined});
      const booking = createTestTransaction({
        customerId: "TST-101",
        customerName: "Karthik P.",
        primary: "9996999505",
        secondary: "9880222741",
        pets: selectedPets.join(", "),
        petCount: selectedPets.length,
        service: "Dog Training",
        packageName: plan.name,
        area: "Bengaluru",
        slot: `${frequency} · ${time}`,
        duration: `${plan.sessions} sessions · ${serviceMinutes} min/session (${selectedPets.length} × 60 min; each pet receives 45 min training + 15 min coaching/report) · ${plan.validity}`,
        amount: packagePayable + meetFee,
        offerCode: couponCode || undefined,
        discount,
        payment: `${paymentMode === "full" ? "100% package paid upfront" : "50% package paid upfront · no discount"}${meet ? " + ₹500 trainer Meet & Greet" : ""}${couponCode ? ` · Coupon ${couponCode}` : ""}`,
        provider: decision.provider.name,
        providerModel: "Commission",
        subscription: `${plan.name} · ${plan.sessions} sessions`,
        creditsBefore: plan.sessions,
        crmOwner: "Rahul",
        crmNextAction:
          attendanceMode === "parent"
            ? "Trainer acceptance; parent/caretaker coaching required"
            : "Trainer acceptance; confirm package allows trainer-led outdoor practice",
        reminder: "Session reminders queued",
      },canonical.bookingId);
      setBookingId(booking.id);
      setConfirmed(true);
      } catch(error){setScheduleError(error instanceof Error?error.message:"No trainer can cover the full programme calendar");} finally {setScheduling(false);}
    };
  if (confirmed)
    return (
      <TrainingDashboard
        bookingId={bookingId}
        plan={plan}
        trainer={trainer}
        pets={selectedPets}
        serviceMinutes={serviceMinutes}
        view={view}
        setView={setView}
      />
    );
  return (
    <>
      <div className={styles.trainingSteps}>
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={stage >= n ? styles.active : ""}>
            {n}
          </span>
        ))}
      </div>
      {stage === 1 && (
        <section>
          <div className={styles.head}>
            <h3>Tell us about Bruno</h3>
            <small>Assessment · 1 of 5</small>
          </div>
          <article className={styles.assessmentPet}>
            <i>🐕</i>
            <div>
              <b>Bruno</b>
              <span>Golden Retriever · 4 years</span>
            </div>
            <button>Change</button>
          </article>
          <div className={styles.trainingPetGrid}>
            {trainingPets.map((pet) => (
              <button
                key={pet.name}
                className={selectedPets.includes(pet.name) ? styles.selected : ""}
                onClick={() => togglePet(pet.name)}
              >
                <i>{pet.icon}</i>
                <span>
                  <b>{pet.name}</b>
                  <small>{pet.detail}</small>
                </span>
                <em>{selectedPets.includes(pet.name) ? "✓" : "＋"}</em>
              </button>
            ))}
          </div>
          <p className={styles.durationRule}>
            {selectedPets.length} {selectedPets.length === 1 ? "pet" : "pets"} · {serviceMinutes} minutes per session
            <span>
              Every pet receives 45 minutes of direct training + 15 minutes
              for coaching, homework, video and the app update.
            </span>
          </p>
          <div className={styles.attendanceChoice}>
            <b>Who will join the session?</b>
            <button
              className={attendanceMode === "parent" ? styles.selected : ""}
              onClick={() => setAttendanceMode("parent")}
            >
              <i>{attendanceMode === "parent" ? "✓" : ""}</i>
              <span>
                <strong>Pet parent or caretaker will join</strong>
                <small>Each pet&apos;s final 15 minutes teaches the handler, assigns homework and records the reference video.</small>
              </span>
            </button>
            <button
              className={attendanceMode === "trainer-led" ? styles.selected : ""}
              onClick={() => setAttendanceMode("trainer-led")}
            >
              <i>{attendanceMode === "trainer-led" ? "✓" : ""}</i>
              <span>
                <strong>No parent or caretaker available</strong>
                <small>If the selected package supports it, the trainer uses the session for outdoor leash walking and toilet-routine practice, then uploads video and homework.</small>
              </span>
            </button>
          </div>
          <label className={styles.field}>
            Training category
            <select defaultValue="obedience">
              <option value="puppy">Puppy training</option>
              <option value="obedience">Basic & advanced obedience</option>
              <option value="behaviour">Behaviour correction</option>
            </select>
          </label>
          <div className={styles.goalGrid}>
            {goals.map((goal) => (
              <button
                type="button"
                key={goal}
                className={selectedGoals.includes(goal) ? styles.selected : ""}
                onClick={() => toggle(goal)}
                aria-pressed={selectedGoals.includes(goal)}
              >
                <i>{selectedGoals.includes(goal) ? "✓" : "＋"}</i>
                <span>{goal}</span>
                {selectedGoals.includes(goal) && <b>Selected</b>}
              </button>
            ))}
          </div>
          <div className={styles.requirementActions}>
            {!addingGoal ? (
              <button type="button" onClick={() => setAddingGoal(true)}>＋ Add another requirement</button>
            ) : (
              <div>
                <input
                  autoFocus
                  value={customGoal}
                  maxLength={80}
                  placeholder="Describe your pet’s requirement"
                  onChange={(event) => setCustomGoal(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && addCustomGoal()}
                />
                <button type="button" disabled={customGoal.trim().length < 3} onClick={addCustomGoal}>Add & select</button>
                <button type="button" onClick={() => { setAddingGoal(false); setCustomGoal(""); }}>Cancel</button>
              </div>
            )}
            <small>{selectedGoals.length} requirement{selectedGoals.length === 1 ? "" : "s"} selected · Tap any highlighted option to remove it.</small>
          </div>
          <label className={styles.field}>
            Home routine, behaviour and trainer notes
            <textarea defaultValue="Pulls on walks and gets excited when guests arrive." />
          </label>
          <label className={styles.field}>
            Health and safety
            <select>
              <option>No aggression or medical concern</option>
              <option>Anxious or fearful</option>
              <option>Bite or aggression history</option>
              <option>Medical restriction</option>
            </select>
          </label>
          <button
            disabled={!selectedGoals.length}
            className={styles.primary}
            onClick={() => setStage(2)}
          >
            See PawSpace plans
          </button>
        </section>
      )}
      {stage === 2 && (
        <section>
          <div className={styles.head}>
            <h3>Bruno&apos;s training options</h3>
            <small>Package · 2 of 5</small>
          </div>
          <article className={styles.planRecommendation}>
            <div>
              <span>PAWSPACE RECOMMENDS</span>
              <h4>Basic Obedience Plan</h4>
              <p>
                Best match for the goals you selected:
                {selectedGoals.slice(0, 2).join(" + ")}.
              </p>
            </div>
            <b>8 sessions</b>
          </article>
          <div className={styles.goalSummary}>
            <b>Selected requirements</b>
            {selectedGoals.map((goal) => (
              <span key={goal}><i>✓</i> {goal}</span>
            ))}
          </div>
          <div className={styles.planGuide}>
            <span><i>1</i><b>Pick by goal</b><small>Puppy, obedience, leash or advanced</small></span>
            <span><i>2</i><b>Compare effort</b><small>Sessions, validity and price together</small></span>
            <span><i>3</i><b>See outcomes</b><small>Tap a plan to expand inclusions</small></span>
          </div>
          <div className={styles.planListHead}>
            <b>All training programmes</b>
            <span>{plans.length} options · select to compare</span>
          </div>
          <div className={planStyles.grid} data-testid="training-plan-grid">
            {plans.map((item) => (
              <article
                key={item.name}
                className={`${planStyles.card} ${plan.name === item.name ? planStyles.selected : ""}`}
                onClick={() => setPlan(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPlan(item);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-pressed={plan.name === item.name}
                aria-label={`${plan.name === item.name ? "Selected" : "Select"} ${item.name}, ${item.sessionLabel}, ${item.validity}, ${money(item.price)}`}
              >
                <header className={planStyles.header}>
                  <div>
                    <span className={planStyles.badge}>
                      {item.recommended
                        ? "BEST MATCH"
                        : item.bonus
                          ? "GROOMING BONUS"
                          : item.level.toUpperCase()}
                    </span>
                    <h4>{item.name}</h4>
                  </div>
                  <strong className={planStyles.price}>{money(item.price)}</strong>
                </header>
                <p className={planStyles.description}>{item.detail}</p>
                <div className={planStyles.metrics}>
                  <span><b>{item.sessionLabel}</b><small>at home</small></span>
                  <span><b>{item.validity}</b><small>validity</small></span>
                  <span><b>60 minutes</b><small>per pet session</small></span>
                  <span><b>Video + homework</b><small>after every session</small></span>
                </div>
                <small className={planStyles.includes}>
                  Includes trainer notes, parent practice tasks, milestone tracking,
                  two-session feedback and replacement protection.
                </small>
                {plan.name === item.name ? (
                  <div className={planStyles.expanded}>
                    <p><b>Best for:</b> {item.idealFor}</p>
                    <div className={planStyles.outcomes}>
                      {item.outcomes.map((outcome) => (
                        <em key={outcome}>✓ {outcome}</em>
                      ))}
                    </div>
                    {item.bonus && (
                      <small>
                        GIFT · 1 complimentary Bath & Basic grooming
                      </small>
                    )}
                  </div>
                ) : null}
                <span className={planStyles.action}>
                  <i>{plan.name === item.name ? "✓" : ""}</i>
                  {plan.name === item.name ? "Selected programme" : "Select this programme"}
                </span>
              </article>
            ))}
          </div>
          <p className={styles.editable}>
            Validity starts from the first service date. Final goals are
            confirmed during the first trainer session.
          </p>
          <button className={styles.back} onClick={() => setStage(1)}>
            ← Assessment
          </button>
          <button className={styles.primary} onClick={() => setStage(3)}>
            Choose trainer
          </button>
        </section>
      )}
      {stage === 3 && (
        <section>
          <div className={styles.head}>
            <h3>Your trainer matches</h3>
            <small>Trainer · 3 of 5</small>
          </div>
          <div className={styles.trainers}>
            {trainers.map((item) => (
              <button
                key={item.name}
                className={trainer.name === item.name ? styles.selected : ""}
                onClick={() => setTrainer(item)}
              >
                <i>
                  {item.name
                    .split(" ")
                    .map((x) => x[0])
                    .join("")}
                </i>
                <div>
                  <span>{item.match}</span>
                  <h4>
                    {item.name} · {item.score} ★
                  </h4>
                  <p>{item.jobs} trained · English, Kannada, Hindi</p>
                  <small>{item.model} · accepts before confirmation</small>
                </div>
                <em>{trainer.name === item.name ? "✓" : ""}</em>
              </button>
            ))}
          </div>
          <article className={styles.protection}>
            <i>↻</i>
            <div>
              <b>Protected trainer matching</b>
              <span>
                If the trainer declines or cancels, PawSpace recommends a
                replacement and reopens the customer calendar. Session credit
                remains protected.
              </span>
            </div>
          </article>
          <article className={styles.protection}>
            <i>◎</i>
            <div>
              <b>One shared session plan</b>
              <span>
                Customer goals, home routine, safety notes and selected
                milestones are automatically displayed in the trainer app.
              </span>
            </div>
          </article>
          <section className={styles.meetTrainer}>
            <div className={styles.meetPitch}>
              <span>NOT READY TO BUY A PACKAGE?</span>
              <h4>Meet the trainer first. Book only when you feel confident.</h4>
              <p>Understand the trainer&apos;s technique, experience and approach with your dog before committing to a programme.</p>
            </div>
            <label>
              <input
                type="checkbox"
                checked={meet}
                onChange={(e) => setMeet(e.target.checked)}
              />
              <span>
                <b>45-minute trainer Meet & Greet · ₹500</b>
                <small>
                  A separate, no-pressure appointment. Meet the trainer, discuss goals and see how they communicate before booking training.
                </small>
              </span>
            </label>
            {meet && (
              <>
                <div className={styles.meetSlots}>
                  {["7 Aug · 6:00 PM", "8 Aug · 11:00 AM", "8 Aug · 5:00 PM"].map(
                    (slot) => (
                      <button
                        key={slot}
                        className={meetSlot === slot ? styles.selected : ""}
                        onClick={() => setMeetSlot(slot)}
                      >
                        {slot}
                        <small>{meetSlot === slot ? "Selected" : "Available"}</small>
                      </button>
                    ),
                  )}
                </div>
                <p>
                  Trainer availability is checked before the slot is offered. If you continue now, the ₹500 meeting is collected with the programme checkout.
                </p>
                <button className={styles.meetOnly} onClick={confirmMeetFirst} disabled={scheduling}>
                  {scheduling ? "Reserving Meet & Greet…" : "Book only the Meet & Greet"}
                </button>
              </>
            )}
            {meetBookingId && <article className={styles.meetConfirmed}><b>✓ Meet & Greet booked</b><span>{meetSlot} · {trainer.name} · {meetBookingId}</span><small>You can decide on the training package after the meeting.</small></article>}
            {scheduleError && <p role="alert">{scheduleError}</p>}
          </section>
          <button className={styles.back} onClick={() => setStage(2)}>
            ← Package
          </button>
          <button className={styles.primary} onClick={() => setStage(4)}>
            Build session calendar
          </button>
        </section>
      )}
      {stage === 4 && (
        <section>
          <div className={styles.head}>
            <h3>Plan your sessions</h3>
            <small>Calendar · 4 of 5</small>
          </div>
          <label className={styles.field}>
            Service start date
            <select>
              <option>Saturday, 9 August</option>
              <option>Sunday, 10 August</option>
              <option>Tuesday, 12 August</option>
            </select>
          </label>
          <label className={styles.field}>
            Repeat schedule
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
            >
              <option>Tue & Sat</option>
              <option>Wed & Sun</option>
              <option>Every Saturday</option>
              <option>Choose each session myself</option>
            </select>
          </label>
          <div className={styles.trainingTimes}>
            {["9:00 AM", "3:00 PM", "5:00 PM"].map((item) => (
              <button
                key={item}
                className={time === item ? styles.selected : ""}
                onClick={() => setTime(item)}
              >
                {item}
                <small>{item === time ? "Recommended" : "Available"}</small>
              </button>
            ))}
          </div>
          <article className={styles.calendarPreview}>
            <b>First four sessions</b>
            {["Sat, 9 Aug", "Tue, 12 Aug", "Sat, 16 Aug", "Tue, 19 Aug"].map(
              (d, i) => (
                <span key={d}>
                  <i>{i + 1}</i>
                  {d}
                  <em>{time} · {serviceMinutes} min</em>
                </span>
              ),
            )}
          </article>
          <article className={styles.sessionLogic}>
            <b>
              {selectedPets.length} {selectedPets.length === 1 ? "pet" : "pets"} · {serviceMinutes}-minute calendar block
            </b>
            <span>
              Every pet has one paid 60-minute session: 45 minutes of hands-on
              training plus its own 15-minute closeout for parent/caretaker
              coaching, homework, a short reference video and the app update.
            </span>
            <span>
              {attendanceMode === "parent"
                ? "The pet parent or caretaker joins the closeout and practises the assigned technique."
                : "No handler attending: where the selected package supports it, the trainer uses the visit for outdoor leash walking and toilet-routine practice, then uploads the reference video and homework."}
            </span>
            <span>
              A 30–45 minute travel buffer is blocked before the trainer&apos;s
              next bookable appointment.
            </span>
          </article>
          <p className={styles.editable}>
            Book every session now or keep dates flexible. App reminders go 24
            hours and 2 hours before each session; expiry alerts start 15 days
            before validity ends.
          </p>
          <button className={styles.back} onClick={() => setStage(3)}>
            ← Trainer
          </button>
          <button className={styles.primary} onClick={() => setStage(5)}>
            Review & pay
          </button>
        </section>
      )}
      {stage === 5 && (
        <section>
          <div className={styles.head}>
            <h3>Review your programme</h3>
            <small>Payment · 5 of 5</small>
          </div>
          <article className={styles.review}>
            <div>
              <span>Pets</span>
              <b>{selectedPets.join(" + ")}</b>
            </div>
            <div>
              <span>Programme</span>
              <b>
                {plan.name} · {plan.sessionLabel}
              </b>
            </div>
            <div>
              <span>Trainer</span>
              <b>{trainer.name} · acceptance required</b>
            </div>
            <div>
              <span>Schedule</span>
              <b>
                {frequency} · {time} · {serviceMinutes} min
              </b>
            </div>
            <div>
              <span>Parent/caretaker participation</span>
              <b>
                {attendanceMode === "parent"
                  ? "Joining · 15-minute coaching and homework handoff"
                  : "Unavailable · eligible trainer-led outdoor practice"}
              </b>
            </div>
            <div>
              <span>Trainer Meet & Greet</span>
              <b>{meet ? `${meetSlot} · 45 min · ₹500` : "Skipped"}</b>
            </div>
            <div>
              <span>Validity</span>
              <b>{plan.validity} from service start</b>
            </div>
            <div>
              <span>Complimentary care</span>
              <b>{plan.bonus ? "Bath & Basic grooming" : "Not included"}</b>
            </div>
          </article>
          <div className={styles.paymentOptions}>
            <button className={paymentMode === "half" ? styles.selected : ""} onClick={() => {
              setPaymentMode("half");
              setDiscount(0);
              setCouponCode("");
            }}>
              <i>{paymentMode === "half" ? "✓" : ""}</i>
              <div>
                <b>Pay 50% upfront · no discount</b>
                <span>
                  {money(plan.price / 2 + meetFee)} now · {money(plan.price / 2)} after{" "}
                  {Math.ceil(plan.sessions / 2)} sessions
                </span>
              </div>
            </button>
            <button className={paymentMode === "full" ? styles.selected : ""} onClick={() => setPaymentMode("full")}>
              <i>{paymentMode === "full" ? "✓" : ""}</i>
              <div>
                <b>Pay 100% upfront · coupon eligible</b>
                <span>{money(plan.price + meetFee)} before an eligible coupon</span>
              </div>
            </button>
          </div>
          <CouponField
            eligible={paymentMode === "full"}
            service="Dog Training"
            orderValue={plan.price}
            customerKind="existing"
            paymentMode={paymentMode === "full" ? "full" : "partial"}
            onDiscountChange={(value, code) => {
              setDiscount(value);
              setCouponCode(code);
            }}
          />
          {discount > 0 && <article className={styles.couponSaving}>Coupon saving <b>−{money(discount)}</b></article>}
          <article className={styles.policy}>
            <b>Cancellation and refund</b>
            <p>
              Cancellation requests go for PawSpace approval. Once approved, the
              unused-session value is refunded after completed sessions and
              adjustments are reconciled.
            </p>
          </article>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />{" "}
            I agree to training, attendance, rescheduling, safety, media and
            refund terms.
          </label>
          <button className={styles.back} onClick={() => setStage(4)}>
            ← Calendar
          </button>
          <button
            disabled={!agreed || scheduling}
            className={styles.primary}
            onClick={confirm}
          >
            {scheduling ? "Reserving all sessions…" : `Pay ${money(payableNow)} & request trainer approval`}
          </button>
          {scheduleError && <p role="alert">{scheduleError}</p>}
        </section>
      )}
    </>
  );
}
function TrainingDashboard({
  bookingId,
  plan,
  trainer,
  pets,
  serviceMinutes,
  view,
  setView,
}: {
  bookingId: string;
  plan: Plan;
  trainer: (typeof trainers)[number];
  pets: string[];
  serviceMinutes: number;
  view: "plan" | "homework" | "progress";
  setView: (v: "plan" | "homework" | "progress") => void;
}) {
  const halfway = Math.ceil(plan.sessions / 2);
  return (
    <section>
      <article className={styles.trainingSuccess}>
        <i>✓</i>
        <div>
          <small>PROGRAMME ACTIVE · {bookingId}</small>
          <h3>{pets.join(" + ")}&apos;s plan is ready.</h3>
          <p>
            {plan.sessionLabel} · {plan.validity} · {trainer.name}
          </p>
        </div>
      </article>
      <div className={styles.trainingSummary}>
        <div>
          <span>
            Completed<b>2</b>
          </span>
          <span>
            Remaining<b>{plan.sessions - 2}</b>
          </span>
          <span>
            Next session<b>9 Aug</b>
          </span>
        </div>
        <progress max={plan.sessions} value={2} />
        <small>
          Session 2 of {plan.sessions} · validity begins on first service date
        </small>
      </div>
      <article className={styles.balance}>
        <div>
          <b>50% paid</b>
          <span>
            Balance {money(plan.price / 2)} will be requested after Session{" "}
            {halfway}
          </span>
        </div>
        <em>{halfway - 2} sessions until reminder</em>
      </article>
      {plan.bonus && (
        <article className={styles.bonus}>
          <i>✦</i>
          <div>
            <b>Complimentary grooming unlocked</b>
            <span>
              1 Bath & Basic session · book anytime within plan validity
            </span>
          </div>
          <button>Book</button>
        </article>
      )}
      <div className={styles.trainingTabs}>
        <button
          className={view === "plan" ? styles.selected : ""}
          onClick={() => setView("plan")}
        >
          Plan
        </button>
        <button
          className={view === "homework" ? styles.selected : ""}
          onClick={() => setView("homework")}
        >
          Homework
        </button>
        <button
          className={view === "progress" ? styles.selected : ""}
          onClick={() => setView("progress")}
        >
          Progress
        </button>
      </div>
      {view === "plan" && (
        <>
          <article className={styles.nextSession}>
            <span>NEXT SESSION · 3 OF {plan.sessions}</span>
            <h4>Loose-leash walking</h4>
            <p>
              Sat, 9 Aug · 5:00 PM · {serviceMinutes} min · {trainer.name}
            </p>
            <div>
              <button>Reschedule</button>
              <button>Message trainer</button>
            </div>
          </article>
          <ProviderTrackingCard role="Trainer" name={trainer.name} eta="22 min" />
          <article className={styles.trainerChecklist}>
            <b>Trainer must close every session with</b>
            <span>✓ Attendance and session notes</span>
            <span>✓ One video, maximum 30 seconds</span>
            <span>✓ Homework assigned to customer</span>
            <span>✓ Milestone and behaviour update</span>
          </article>
          <article className={styles.feedback}>
            <i>★</i>
            <div>
              <b>Two-session feedback is due</b>
              <span>
                Rate trainer, progress and experience after Session 2.
              </span>
            </div>
            <button>Share</button>
          </article>
          <article className={styles.cancelRule}>
            <b>Reschedule, cancellation and refund protection</b>
            <span>
              Trainer cancellation opens the same-trainer or replacement
              calendar. Customer cancellation requires approval; unused-session
              value is refunded after reconciliation.
            </span>
          </article>
          <div className={styles.sessionList}>
            {[
              "Name response & focus",
              "Sit, stay and release",
              "Loose-leash walking",
              "Recall with distractions",
            ].map((s, i) => (
              <span key={s}>
                <i>{i < 2 ? "✓" : i + 1}</i>
                <b>{s}</b>
                <em>{i < 2 ? "Video + notes" : "Scheduled"}</em>
              </span>
            ))}
          </div>
        </>
      )}
      {view === "homework" && (
        <>
          <article className={styles.homework}>
            <span>ASSIGNED AFTER SESSION 2</span>
            <h4>Five-minute focus routine</h4>
            <p>
              Practise “look at me” twice daily before meals. Reward calm eye
              contact within two seconds.
            </p>
            <div>
              <button>▶ Trainer video · 00:24</button>
              <button>＋ Upload practice video</button>
            </div>
            <label className={styles.task}>
              <input type="checkbox" /> Mark today’s practice complete
            </label>
          </article>
          <article className={styles.homework}>
            <span>7-DAY PRACTICE STREAK</span>
            <h4>Customer task tracker</h4>
            <div className={styles.practiceDays}>
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <i key={i} className={i < 4 ? styles.checked : ""}>
                  {i < 4 ? "✓" : d}
                </i>
              ))}
            </div>
            <p>
              4 of 7 practice tasks closed. The trainer sees this status before
              the next session.
            </p>
          </article>
        </>
      )}
      {view === "progress" && (
        <>
          <div className={styles.milestones}>
            {[
              ["Focus & engagement", 72],
              ["Leash manners", 48],
              ["Recall", 36],
              ["Home behaviour", 65],
            ].map((m) => (
              <article key={m[0] as string}>
                <div>
                  <b>{m[0]}</b>
                  <span>{m[1]}%</span>
                </div>
                <progress max="100" value={m[1] as number} />
              </article>
            ))}
          </div>
          <article className={styles.report}>
            <b>Trainer’s latest note</b>
            <p>
              Bruno responds well to food rewards. Family consistency is
              improving; continue short sessions near mild distractions.
            </p>
            <span>2 mandatory videos · session notes updated</span>
          </article>
          <article className={styles.certificate}>
            <i>♛</i>
            <div>
              <b>Completion certificate</b>
              <span>
                After the final session, PawSpace generates Bruno’s named
                certificate with Karthik’s signature and the trainer’s
                signature, then sends it by email and WhatsApp.
              </span>
            </div>
          </article>
          <section className={styles.crossSell}>
            <b>Continue Bruno’s care</b>
            <div>
              <button>Bath & Basic</button>
              <button>Fresh Food</button>
              <button>Pet Boarding</button>
            </div>
          </section>
          <button className={styles.primary}>View full progress report</button>
          <button className={styles.renew}>Renew or upgrade programme</button>
        </>
      )}
    </section>
  );
}
