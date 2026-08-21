"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import baseStyles from "./training.module.css";
import extraStyles from "./training-extra.module.css";
import planStyles from "./training-plans.module.css";
import { createTestTransaction } from "../../lib/test-transaction";
import CouponField from "./coupon-field";
import { reserveUatSchedule } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import { loadTrainingProgramme, materializeTrainingProgramme, type CustomerTrainingProgramme } from "../../lib/training-programme-client";
import { loadTrainingPackages, loadTrainingTrainers, quoteTraining, type TrainingPackage, type TrainingQuote, type TrainingTrainer } from "../../lib/training-commercial-client";
import { requestTrainingCancellation, requestTrainingSessionReschedule } from "../../lib/training-cancellation-client";
import { trainingPreviewCount, trainingSessionPreviewDates } from "../../lib/training-session-preview";
import { resolveServiceCoverage, type ResolvedServiceCoverage } from "../../lib/service-zone-client";
const styles = { ...baseStyles, ...extraStyles };
type Plan = {
  packageCode: string;
  name: string;
  sessions: number;
  sessionLabel: string;
  validity: string;
  validityDays: number;
  price: number;
  directMinutes: number;
  coachingMinutes: number;
  splitDuePercent: number;
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
const petDetail = (pet: CustomerPet) =>
  [pet.profile?.breed || pet.breed, pet.profile?.ageBand, pet.profile?.weightBand].filter(Boolean).join(" · ") ||
  "Profiles, health notes and service history included";
const planMarketing = [
  { packageCode:"training-2-starter",name:"Starter Plan",detail:"Professional guidance and a clear starting structure for dogs of any age.",bonus:false,level:"Assessment start",idealFor:"Parents who need a professional plan before committing long-term",outcomes:["Behaviour assessment","Home routine","Action plan"] },
  { packageCode:"training-4-puppy",name:"Puppy Training Plan",detail:"Early habits, confidence, socialisation and essential puppy foundations.",bonus:false,level:"Puppy foundation",idealFor:"Puppies up to 8 months building their first routines",outcomes:["Toilet routine","Biting control","Social confidence"] },
  { packageCode:"training-8-basic",name:"Basic Obedience Plan",detail:"Obedience, impulse control, home manners and communication.",bonus:true,level:"Core programme",idealFor:"Everyday manners, focus and reliable basic commands",outcomes:["Sit, stay and recall","Impulse control","Home manners"],recommended:true },
  { packageCode:"training-8-leash",name:"Leash Obedience Plan · 8",detail:"Pulling, reactivity, heel positioning and real-world walking control.",bonus:true,level:"Leash focus",idealFor:"Dogs who pull, lunge or lose focus outdoors",outcomes:["Loose-leash walk","Heel position","Calm passing"] },
  { packageCode:"training-12-leash",name:"Leash Obedience Plan · 12",detail:"Extended leash, recall and distraction-control programme.",bonus:true,level:"Leash intensive",idealFor:"Persistent pulling or reactivity needing more practice",outcomes:["Leash control","Outdoor recall","Distraction work"] },
  { packageCode:"training-12-advanced",name:"Advanced Obedience Plan",detail:"Reliable commands, impulse control and real-world manners.",bonus:true,level:"Advanced",idealFor:"Dogs ready to work reliably around real-world distractions",outcomes:["Distance commands","Advanced recall","Public manners"] },
  { packageCode:"training-16-pro",name:"Pro Training Plan",detail:"High-level obedience, heel work, distance control and complex behaviour.",bonus:true,level:"Professional",idealFor:"Families seeking the most complete obedience programme",outcomes:["Off-leash control","Complex behaviour","Handler mastery"] },
] as const;
const emptyPlan:Plan={packageCode:"training-8-basic",name:"Basic Obedience Plan",sessions:0,sessionLabel:"Loading…",validity:"Loading…",validityDays:0,price:0,directMinutes:0,coachingMinutes:0,splitDuePercent:50,detail:"Loading the canonical Training catalogue.",bonus:true,level:"Core programme",idealFor:"Everyday manners, focus and reliable basic commands",outcomes:[],recommended:true};
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
const IST_OFFSET=330*60_000;
const weekdayMap:Record<string,number[]>={"Tue & Sat":[2,6],"Wed & Sun":[3,0],"Every Saturday":[6]};
function futureIst(days:number,hour:number,minute=0){const now=new Date(),shifted=new Date(now.getTime()+IST_OFFSET);return new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()+days,hour,minute)-IST_OFFSET);}
function nextTrainingStarts(frequency:string,time:string,count=3){const hour=time.startsWith("9")?9:time.startsWith("3")?15:17,days=weekdayMap[frequency]||weekdayMap["Tue & Sat"],result:Date[]=[];for(let offset=1;offset<=28&&result.length<count;offset++){const candidate=futureIst(offset,hour),weekday=new Date(candidate.getTime()+IST_OFFSET).getUTCDay();if(days.includes(weekday))result.push(candidate);}return result;}
function slotLabel(value:Date){return new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",weekday:"short",day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(value);}
function previewHour(time:string){return time.startsWith("9")?9:time.startsWith("3")?15:17;}
function buildPlans(packages:TrainingPackage[]):Plan[]{return planMarketing.flatMap(marketing=>{const pkg=packages.find(item=>item.package_code===marketing.packageCode);if(!pkg)return[];return[{...marketing,sessions:Number(pkg.sessions),sessionLabel:`${Number(pkg.sessions)} sessions`,validityDays:Number(pkg.validity_days),validity:`${Number(pkg.validity_days)} days`,price:Number(pkg.base_price),directMinutes:Number(pkg.direct_minutes_per_pet),coachingMinutes:Number(pkg.coaching_minutes_per_pet),splitDuePercent:Number(pkg.split_due_percent),outcomes:[...marketing.outcomes]}];});}
function jsonObject(value:string){try{return JSON.parse(value) as Record<string,unknown>}catch{return{}}}
import type { LoggedInCustomer } from "./customer-login";
export default function TrainingFlow({ customer }: { customer: LoggedInCustomer }) {
  const [plans,setPlans]=useState<Plan[]>([]);
  const [trainers,setTrainers]=useState<TrainingTrainer[]>([]);
  const [trainerId,setTrainerId]=useState("");
  const [confirmedTrainerName,setConfirmedTrainerName]=useState("");
  const [meetTrainerName,setMeetTrainerName]=useState("");
  const [meetPackage,setMeetPackage]=useState<TrainingPackage|null>(null);
  const [checkoutQuote,setCheckoutQuote]=useState<TrainingQuote|null>(null);
  const [startDateIndex,setStartDateIndex]=useState(0);
  const [pincode,setPincode]=useState("");
  const [coverage,setCoverage]=useState<ResolvedServiceCoverage|null>(null);
  const [stage, setStage] = useState(1),
    [goals, setGoals] = useState(fallbackGoals),
    [selectedGoals, setSelectedGoals] = useState([
      "Basic obedience",
      "Leash walking",
    ]),
    [selRaw, setSelectedPets] = useState<string[]>([]),
    [petsState, setPets] = useState<CustomerPet[] | null>(null),
    [petsLoading, setPetsLoading] = useState(true),
    [petsError, setPetsError] = useState(""),
    [showPetManager, setShowPetManager] = useState(false),
    [plan, setPlan] = useState(emptyPlan),
    [frequency, setFrequency] = useState("Tue & Sat"),
    [time, setTime] = useState("3:00 PM"),
    [attendanceMode, setAttendanceMode] = useState<"parent" | "trainer-led">("parent"),
    [meetSlot, setMeetSlot] = useState(() => futureIst(1,11).toISOString()),
    [meetBookingId, setMeetBookingId] = useState(""),
    [meetPetKey, setMeetPetKey] = useState(""),
    [paymentMode, setPaymentMode] = useState<"half" | "full">("half"),
    [couponCode, setCouponCode] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(true),
    [bookingId, setBookingId] = useState(""),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [customGoal, setCustomGoal] = useState(""),
    [addingGoal, setAddingGoal] = useState(false),
    [view, setView] = useState<"plan" | "homework" | "progress">("plan"),
    [toast, setToast] = useState("");
  const pets = petsState ?? [];
  const selectedPets = selRaw.filter((id) => pets.some((p) => p.id === id));
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };
  useEffect(() => {
    void fetch("/api/training-requirements")
      .then((response) => response.json())
      .then((body: { data?: Array<{ label: string; active: number }> }) => {
        const activeGoals = body.data?.filter((item) => item.active).map((item) => item.label);
        if (activeGoals?.length) setGoals(activeGoals);
      })
      .catch(() => undefined);
  }, []);
  useEffect(()=>{let active=true;void loadTrainingPackages().then(result=>{if(!active)return;const next=buildPlans(result.packages);setPlans(next);setMeetPackage(result.packages.find(item=>item.package_code==="trainer-meet-greet")||null);setPlan(current=>next.find(item=>item.packageCode===current.packageCode)||next.find(item=>item.recommended)||next[0]||emptyPlan);}).catch(problem=>{if(active)setScheduleError(problem instanceof Error?problem.message:"Unable to load Training catalogue");});return()=>{active=false;};},[]);

  const startOptions=nextTrainingStarts(frequency,time);
  const selectedStart=startOptions[startDateIndex]||startOptions[0]||futureIst(1,time.startsWith("9")?9:time.startsWith("3")?15:17);
  const selectedStartIso=selectedStart.toISOString();
  const calendarPreview=trainingSessionPreviewDates(selectedStart,weekdayMap[frequency]||weekdayMap["Tue & Sat"],previewHour(time),trainingPreviewCount(plan.sessions));
  const serviceMinutes=selectedPets.length*(plan.directMinutes+plan.coachingMinutes);
  const discount=checkoutQuote?.discount??0;
  const payableNow=checkoutQuote?.amountDueNow??0;
  const recommendedPlan=plans.find(item=>item.packageCode==="training-8-basic")||plan;
  const selectedTrainer=trainers.find(item=>item.id===trainerId)||trainers[0]||null;
  useEffect(()=>{let active=true;if(pincode.length!==6){queueMicrotask(()=>{if(active){setCoverage(null);setTrainers([]);setTrainerId("");}});return()=>{active=false;};}void resolveServiceCoverage(pincode).then(resolved=>{if(!active)return;setCoverage(resolved);return loadTrainingTrainers({cityId:resolved.cityId,zoneId:resolved.zoneId,at:selectedStartIso});}).then(result=>{if(!active||!result)return;setTrainers(result.providers);setTrainerId(current=>result.providers.some(item=>item.id===current)?current:result.providers[0]?.id||"");setScheduleError("");}).catch(problem=>{if(active){setCoverage(null);setTrainers([]);setTrainerId("");setScheduleError(problem instanceof Error?problem.message:"Unable to resolve Training coverage");}});return()=>{active=false;};},[pincode,selectedStartIso]);
  useEffect(()=>{if(stage!==5||!plan.sessions)return;let active=true;const mode=paymentMode==="full"?"prepaid":"split";void quoteTraining({packageCode:plan.packageCode,petCount:selectedPets.length,scheduledStart:selectedStartIso,paymentMode:mode,couponCode:mode==="prepaid"&&couponCode?couponCode:undefined}).then(value=>{if(active){setCheckoutQuote(value);setScheduleError("");}}).catch(problem=>{if(active){setCheckoutQuote(null);setScheduleError(problem instanceof Error?problem.message:"Unable to refresh Training quote");}});return()=>{active=false;};},[stage,plan.packageCode,plan.sessions,selectedPets.length,paymentMode,couponCode,frequency,time,startDateIndex,selectedStartIso]);
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
  const dogs = pets.filter((p) => p.species === "dog");
  const selectedPetObjs = pets.filter((p) => selectedPets.includes(p.id));
  const petKey = [...selectedPets].sort().join(",");
  const meetLinked = Boolean(meetBookingId) && meetPetKey === petKey;
  const selectedPetNames = selectedPetObjs.map((p) => p.name);
  const primaryPet = selectedPetObjs[0] ?? dogs[0];
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setPetsLoading(true);
    });
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        const firstDog = loaded.find((p) => p.species === "dog");
        setPets((prev) => (prev === null ? loaded : prev));
        setSelectedPets((prev) => (prev.length ? prev : firstDog ? [firstDog.id] : []));
        setPetsError("");
      })
      .catch((e) => { if (active) setPetsError(e instanceof Error ? e.message : "Unable to load your pets"); })
      .finally(() => { if (active) setPetsLoading(false); });
    return () => { active = false; };
  }, [customer.customerId]);
  const onPetsChanged = (updated: CustomerPet[]) => {
    setPets(updated);
    setSelectedPets((prev) => {
      const kept = prev.filter((id) => updated.some((p) => p.id === id && p.species === "dog"));
      return kept.length ? kept : updated.find((p) => p.species === "dog") ? [updated.find((p) => p.species === "dog")!.id] : [];
    });
  };
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
      if(selectedPets.length===0){setScheduleError("Select at least one dog to continue.");return;}
      if(pincode.length!==6){setScheduleError("Enter the six-digit service PIN code before booking a Meet & Greet.");return;}
      setScheduling(true);setScheduleError("");
      try {
        const serviceCoverage=await resolveServiceCoverage(pincode);
        const meetTrainers=await loadTrainingTrainers({cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId,at:meetSlot});
        const meetTrainer=meetTrainers.providers.find(item=>item.id===trainerId)||meetTrainers.providers[0]||null;
        if(!meetTrainer)throw new Error("No eligible trainer is available for this Meet & Greet slot");
        const start=new Date(meetSlot),quote=await quoteTraining({packageCode:"trainer-meet-greet",petCount:selectedPets.length,scheduledStart:start.toISOString(),paymentMode:"prepaid"}),end=new Date(start.getTime()+quote.minutesPerSession*60_000);
        const requestId=`training-meet-${customer.customerId}-${meetTrainer.id}-${start.toISOString()}`;
        const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:"dog_training",cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId,scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),occurrences:quote.sessions,preferredProviderId:meetTrainer.id});
        const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:"dog" as const})),cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId,serviceCode:"dog_training",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:start.toISOString(),scheduledEnd:end.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:"prepaid",status:"created",detail:"Awaiting a verified payment event"},pricing:{discount:quote.discount,trainingQuoteId:quote.quoteId}});
        setMeetBookingId(canonical.bookingId);setMeetPetKey(petKey);setMeetTrainerName(decision.provider.name);setCheckoutQuote(null);
      } catch(error){setScheduleError(error instanceof Error?error.message:"This Meet & Greet slot is no longer available");} finally {setScheduling(false);}
    },
    confirm = async () => {
      if(selectedPets.length===0){setScheduleError("Select at least one dog to continue.");return;}
      setScheduling(true);setScheduleError("");
      try {
        const serviceCoverage=await resolveServiceCoverage(pincode);
        const linkedMeetBookingId=meetLinked?meetBookingId:"";
        const mode=paymentMode==="full"?"prepaid":"split",quote=await quoteTraining({packageCode:plan.packageCode,petCount:selectedPets.length,scheduledStart:selectedStart.toISOString(),paymentMode:mode,couponCode:mode==="prepaid"&&couponCode?couponCode:undefined}),end=new Date(selectedStart.getTime()+quote.minutesPerSession*60_000),requestId=`training-TST101-${quote.packageCode}-${selectedStart.toISOString()}-${frequency.replaceAll(" ","")}`;
        const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:"dog_training",cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId,scheduledStart:selectedStart.toISOString(),scheduledEnd:end.toISOString(),occurrences:quote.sessions,weekdays:weekdayMap[frequency],preferredProviderId:selectedTrainer?.id});
        const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:"dog" as const})),cityId:serviceCoverage.cityId,zoneId:serviceCoverage.zoneId,serviceCode:"dog_training",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:selectedStart.toISOString(),scheduledEnd:end.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode,status:"created",detail:"Awaiting a verified payment event"},pricing:{discount:quote.discount,couponCode:couponCode||undefined,subscription:`${quote.sessions} sessions`,requirements:selectedGoals,trainingQuoteId:quote.quoteId}});
        await materializeTrainingProgramme({bookingId:canonical.bookingId,meetBookingId:linkedMeetBookingId||undefined});
        setConfirmedTrainerName(decision.provider.name);
        const booking=createTestTransaction({customerId:customer.customerId,customerName:customer.customerName,primary:customer.phone,secondary:"",pets:selectedPetNames.join(", "),petCount:selectedPets.length,service:"Dog Training",packageName:quote.packageName,area:`${serviceCoverage.area}, ${serviceCoverage.city}`,slot:`${frequency} · ${time}`,duration:`${quote.sessions} sessions · ${quote.minutesPerSession} min/session · ${quote.validityDays} days`,amount:quote.totalAmount,offerCode:couponCode||undefined,discount:quote.discount,payment:`${mode==="prepaid"?"Full payment pending verification":"Split payment pending verification"}${linkedMeetBookingId?` · Meet booking ${linkedMeetBookingId}`:""}`,provider:decision.provider.name,providerModel:"Commission",subscription:`${quote.packageName} · ${quote.sessions} sessions`,creditsBefore:quote.sessions,crmOwner:"Unassigned",crmNextAction:attendanceMode==="parent"?"Trainer acceptance; parent/caretaker coaching required":"Trainer acceptance; confirm package allows trainer-led outdoor practice",reminder:"In-app reminders queued; external delivery not active"},canonical.bookingId);
        setBookingId(booking.id);setConfirmed(true);
      } catch(error){setScheduleError(error instanceof Error?error.message:"No trainer can cover the full programme calendar");} finally {setScheduling(false);}
    };
  if (confirmed)
    return (
      <TrainingDashboard
        bookingId={bookingId}
        plan={plan}
        trainerName={confirmedTrainerName||selectedTrainer?.name||"Assigned trainer"}
        pets={selectedPetNames}
        serviceMinutes={serviceMinutes}
        view={view}
        setView={setView}
      />
    );
  return (
    <>
      {toast && <div className={styles.toast}>{toast}</div>}
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
            <h3>Tell us about {primaryPet?.name ?? "your dog"}</h3>
            <small>Assessment · 1 of 5</small>
          </div>
          <article className={styles.assessmentPet}>
            <i>🐕</i>
            <div>
              <b>{primaryPet?.name ?? "Your dog"}</b>
              <span>{primaryPet ? petDetail(primaryPet) : "Add one of your dogs to begin"}</span>
            </div>
            <button onClick={() => flash("Pet details are managed from My PawSpace → My Pets.")}>Change</button>
          </article>
          <div className={styles.trainingPetGrid}>
            {petsLoading && <p className={styles.durationRule}>Loading your pets…</p>}
            {petsError && <p className={styles.durationRule} role="alert">{petsError}</p>}
            {!petsLoading && !petsError && dogs.length === 0 && <p className={styles.durationRule}>No dogs on your profile yet — add one below to start a training plan.</p>}
            {dogs.map((pet) => (
              <button
                key={pet.id}
                className={selectedPets.includes(pet.id) ? styles.selected : ""}
                onClick={() => togglePet(pet.id)}
              >
                <i>🐕</i>
                <span>
                  <b>{pet.name}</b>
                  <small>{petDetail(pet)}</small>
                </span>
                <em>{selectedPets.includes(pet.id) ? "✓" : "＋"}</em>
              </button>
            ))}
            <button onClick={() => setShowPetManager((v) => !v)}>
              <i>{showPetManager ? "−" : "＋"}</i>
              <span><b>{showPetManager ? "Hide pet details" : "Add or edit pets"}</b></span>
            </button>
          </div>
          {showPetManager && <PetManager customer={customer} onPetsChanged={onPetsChanged} />}
          <p className={styles.durationRule}>
            {selectedPets.length} {selectedPets.length === 1 ? "pet" : "pets"} · {serviceMinutes} minutes per session
            <span>
              Every pet receives {plan.directMinutes} minutes of direct training + {plan.coachingMinutes} minutes
              for coaching, homework, video and the app update.
            </span>
          </p>
          <div className={styles.attendanceChoice}>
            <b>Who will join the session?</b>
            <button className={attendanceMode === "parent" ? styles.selected : ""} onClick={() => setAttendanceMode("parent")}>
              <i>{attendanceMode === "parent" ? "✓" : ""}</i>
              <span><strong>Pet parent or caretaker will join</strong><small>Each pet&apos;s final 15 minutes teaches the handler, assigns homework and records the reference video.</small></span>
            </button>
            <button className={attendanceMode === "trainer-led" ? styles.selected : ""} onClick={() => setAttendanceMode("trainer-led")}>
              <i>{attendanceMode === "trainer-led" ? "✓" : ""}</i>
              <span><strong>No parent or caretaker available</strong><small>If the selected package supports it, the trainer uses the session for outdoor leash walking and toilet-routine practice, then uploads video and homework.</small></span>
            </button>
          </div>
          <label className={styles.field}>
            Training category
            <select defaultValue="obedience"><option value="puppy">Puppy training</option><option value="obedience">Basic & advanced obedience</option><option value="behaviour">Behaviour correction</option></select>
          </label>
          <div className={styles.goalGrid}>
            {goals.map((goal) => (
              <button type="button" key={goal} className={selectedGoals.includes(goal) ? styles.selected : ""} onClick={() => toggle(goal)} aria-pressed={selectedGoals.includes(goal)}>
                <i>{selectedGoals.includes(goal) ? "✓" : "＋"}</i><span>{goal}</span>{selectedGoals.includes(goal) && <b>Selected</b>}
              </button>
            ))}
          </div>
          <div className={styles.requirementActions}>
            {!addingGoal ? <button type="button" onClick={() => setAddingGoal(true)}>＋ Add another requirement</button> : (
              <div><input autoFocus value={customGoal} maxLength={80} placeholder="Describe your pet’s requirement" onChange={(event) => setCustomGoal(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addCustomGoal()} /><button type="button" disabled={customGoal.trim().length < 3} onClick={addCustomGoal}>Add & select</button><button type="button" onClick={() => { setAddingGoal(false); setCustomGoal(""); }}>Cancel</button></div>
            )}
            <small>{selectedGoals.length} requirement{selectedGoals.length === 1 ? "" : "s"} selected · Tap any highlighted option to remove it.</small>
          </div>
          <label className={styles.field}>Home routine, behaviour and trainer notes<textarea defaultValue="Pulls on walks and gets excited when guests arrive." /></label>
          <label className={styles.field}>Health and safety<select><option>No aggression or medical concern</option><option>Anxious or fearful</option><option>Bite or aggression history</option><option>Medical restriction</option></select></label>
          <button disabled={!selectedGoals.length || selectedPets.length === 0} className={styles.primary} onClick={() => setStage(2)}>{selectedPets.length === 0 ? "Select a dog to continue" : "See PawSpace plans"}</button>
        </section>
      )}
      {stage === 2 && (
        <section>
          <div className={styles.head}><h3>Bruno&apos;s training options</h3><small>Package · 2 of 5</small></div>
          <article className={styles.planRecommendation}><div><span>PAWSPACE RECOMMENDS</span><h4>Basic Obedience Plan</h4><p>Best match for the goals you selected: {selectedGoals.slice(0, 2).join(" + ")}.</p></div><b>{recommendedPlan.sessionLabel}</b></article>
          <div className={styles.goalSummary}><b>Selected requirements</b>{selectedGoals.map((goal) => <span key={goal}><i>✓</i> {goal}</span>)}</div>
          <section className={styles.meetTrainer}>
            <div className={styles.meetPitch}><span>MEET A TRAINER FIRST</span><h4>Prefer to meet a trainer before choosing a programme?</h4><p>Book a separate Meet &amp; Greet now. You can return later and choose a training package without mixing the two purchases.</p></div>
            <label className={styles.consent}>Service PIN code<input value={pincode} inputMode="numeric" maxLength={6} onChange={event=>setPincode(event.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Enter six-digit PIN code" /></label>
            <b>{meetPackage?`${Number(meetPackage.direct_minutes_per_pet)+Number(meetPackage.coaching_minutes_per_pet)}-minute Meet & Greet · ${money(Number(meetPackage.base_price))}`:"Loading Meet & Greet…"}</b>
            <div className={styles.meetSlots}>{[futureIst(1,11),futureIst(2,15),futureIst(2,16)].map((date)=>{const slot=date.toISOString();return <button key={slot} className={meetSlot===slot?styles.selected:""} onClick={()=>setMeetSlot(slot)}>{slotLabel(date)}<small>{meetSlot===slot?"Selected":"Available"}</small></button>;})}</div>
            <p>Trainer availability is checked in the governed city and zone before booking. This creates one standalone canonical Meet &amp; Greet with payment awaiting a verified event.</p>
            <button className={styles.meetOnly} onClick={confirmMeetFirst} disabled={scheduling || selectedPets.length === 0 || pincode.length!==6}>{scheduling?"Reserving Meet & Greet…":"Book Meet & Greet only"}</button>
            {meetLinked&&<article className={styles.meetConfirmed}><b>✓ Meet &amp; Greet booked</b><span>{slotLabel(new Date(meetSlot))} · {meetTrainerName||"Assigned trainer"} · {meetBookingId}</span><small>You can continue to a programme now or return after the meeting.</small></article>}
            {meetBookingId&&!meetLinked&&<article className={styles.meetConfirmed}><b>Meet &amp; Greet belongs to another dog selection</b><span>Select the original dogs to link that meeting, or book another Meet &amp; Greet for the current selection.</span></article>}
            {scheduleError&&<p role="alert">{scheduleError}</p>}
          </section>
          <div className={styles.planGuide}><span><i>1</i><b>Pick by goal</b><small>Puppy, obedience, leash or advanced</small></span><span><i>2</i><b>Compare effort</b><small>Sessions, validity and price together</small></span><span><i>3</i><b>See outcomes</b><small>Tap a plan to expand inclusions</small></span></div>
          <div className={styles.planListHead}><b>All training programmes</b><span>{plans.length} options · select to compare</span></div>
          <div className={planStyles.grid} data-testid="training-plan-grid">
            {plans.map((item) => (
              <article key={item.name} className={`${planStyles.card} ${plan.name === item.name ? planStyles.selected : ""}`} onClick={() => setPlan(item)} onKeyDown={(event) => {if (event.key === "Enter" || event.key === " ") {event.preventDefault();setPlan(item);}}} role="button" tabIndex={0} aria-pressed={plan.name === item.name} aria-label={`${plan.name === item.name ? "Selected" : "Select"} ${item.name}, ${item.sessionLabel}, ${item.validity}, ${money(item.price)}`}>
                <header className={planStyles.header}><div><span className={planStyles.badge}>{item.recommended ? "BEST MATCH" : item.bonus ? "GROOMING BONUS" : item.level.toUpperCase()}</span><h4>{item.name}</h4></div><strong className={planStyles.price}>{money(item.price)}</strong></header>
                <p className={planStyles.description}>{item.detail}</p>
                <div className={planStyles.metrics}><span><b>{item.sessionLabel}</b><small>at home</small></span><span><b>{item.validity}</b><small>validity</small></span><span><b>{item.directMinutes+item.coachingMinutes} minutes</b><small>per pet session</small></span><span><b>Video + homework</b><small>after every session</small></span></div>
                <small className={planStyles.includes}>Includes trainer notes, parent practice tasks, milestone tracking, two-session feedback and replacement protection.</small>
                {plan.name === item.name ? <div className={planStyles.expanded}><p><b>Best for:</b> {item.idealFor}</p><div className={planStyles.outcomes}>{item.outcomes.map((outcome) => <em key={outcome}>✓ {outcome}</em>)}</div>{item.bonus && <small>GIFT · 1 complimentary Bath & Basic grooming</small>}</div> : null}
                <span className={planStyles.action}><i>{plan.name === item.name ? "✓" : ""}</i>{plan.name === item.name ? "Selected programme" : "Select this programme"}</span>
              </article>
            ))}
          </div>
          <p className={styles.editable}>Validity starts from the first service date. Final goals are confirmed during the first trainer session.</p>
          <button className={styles.back} onClick={() => setStage(1)}>← Assessment</button>
          <button className={styles.primary} onClick={() => setStage(3)}>Choose trainer</button>
        </section>
      )}
      {stage === 3 && (
        <section>
          <div className={styles.head}><h3>Your trainer matches</h3><small>Trainer · 3 of 5</small></div>
          <div className={styles.trainers}>{trainers.length===0&&<p>{pincode.length===6?"No eligible trainer is currently available for this start date and zone.":"Enter the service PIN code on the previous step to load eligible trainers."}</p>}{trainers.map((item) => <button key={item.id} className={trainerId===item.id?styles.selected:""} onClick={()=>setTrainerId(item.id)}><i>{item.name.split(" ").map((x)=>x[0]).join("")}</i><div><span>Canonical capacity roster</span><h4>{item.name} · {item.rating.toFixed(1)} ★</h4><p>Quality {item.qualityScore}/100 · capacity {item.capacity} · {item.travelBufferMinutes} min travel buffer</p><small>{item.model.replaceAll("_"," ")} · final assignment after whole-calendar conflict checks</small></div><em>{trainerId===item.id?"✓":""}</em></button>)}</div>
          <article className={styles.protection}><i>↻</i><div><b>Protected trainer matching</b><span>If the trainer declines or cancels, PawSpace recommends a replacement and reopens the customer calendar. Session credit remains protected.</span></div></article>
          <article className={styles.protection}><i>◎</i><div><b>One shared session plan</b><span>Customer goals, home routine, safety notes and selected milestones are automatically displayed in the trainer app.</span></div></article>
          <button className={styles.back} onClick={() => setStage(2)}>← Package</button>
          <button className={styles.primary} disabled={!selectedTrainer} onClick={() => setStage(4)}>Build session calendar</button>
        </section>
      )}
      {stage === 4 && (
        <section>
          <div className={styles.head}><h3>Plan your sessions</h3><small>Calendar · 4 of 5</small></div>
          <label className={styles.field}>Service start date<select value={startDateIndex} onChange={(event)=>setStartDateIndex(Number(event.target.value))}>{startOptions.map((date,index)=><option value={index} key={date.toISOString()}>{slotLabel(date)}</option>)}</select></label>
          <label className={styles.field}>Repeat schedule<select value={frequency} onChange={(e) => setFrequency(e.target.value)}><option>Tue & Sat</option><option>Wed & Sun</option><option>Every Saturday</option></select></label>
          <div className={styles.trainingTimes}>{["9:00 AM", "3:00 PM"].map((item) => <button key={item} className={time === item ? styles.selected : ""} onClick={() => setTime(item)}>{item}<small>{item === time ? "Recommended" : "Available"}</small></button>)}</div>
          <article className={styles.calendarPreview}><b>{plan.sessions>0?`Full session calendar · ${plan.sessions} session${plan.sessions===1?"":"s"}`:"Full session calendar"}</b>{calendarPreview.map((date,i)=><span key={date.toISOString()}><i>{i+1}</i>{slotLabel(date)}<em>{serviceMinutes} min</em></span>)}</article>
          <article className={styles.sessionLogic}><b>{selectedPets.length} {selectedPets.length === 1 ? "pet" : "pets"} · {serviceMinutes}-minute calendar block</b><span>Every pet has one paid {plan.directMinutes+plan.coachingMinutes}-minute session: {plan.directMinutes} minutes of hands-on training plus its own {plan.coachingMinutes}-minute closeout for parent/caretaker coaching, homework, a short reference video and the app update.</span><span>{attendanceMode === "parent" ? "The pet parent or caretaker joins the closeout and practises the assigned technique." : "No handler attending: where the selected package supports it, the trainer uses the visit for outdoor leash walking and toilet-routine practice, then uploads the reference video and homework."}</span><span>A 30–45 minute travel buffer is blocked before the trainer&apos;s next bookable appointment.</span></article>
          <p className={styles.editable}>Choose one of the supported repeat schedules above. Every package session is shown before payment, and app reminders go 24 hours and 2 hours before each session; expiry alerts start 15 days before validity ends.</p>
          <button className={styles.back} onClick={() => setStage(3)}>← Trainer</button><button className={styles.primary} onClick={() => setStage(5)}>Review & pay</button>
        </section>
      )}
      {stage === 5 && (
        <section>
          <div className={styles.head}><h3>Review your programme</h3><small>Payment · 5 of 5</small></div>
          <article className={styles.review}>
            <div><span>Pets</span><b>{selectedPetNames.join(" + ")}</b></div>
            <div><span>Programme</span><b>{plan.name} · {plan.sessionLabel}</b></div>
            <div><span>Preferred trainer</span><b>{selectedTrainer?`${selectedTrainer.name} · final assignment checked server-side`:"No eligible trainer selected"}</b></div>
            <div><span>Schedule</span><b>{frequency} · {time} · {serviceMinutes} min</b></div>
            <div><span>Parent/caretaker participation</span><b>{attendanceMode === "parent" ? `Joining · ${plan.coachingMinutes}-minute coaching and homework handoff` : "Unavailable · eligible trainer-led outdoor practice"}</b></div>
            <div><span>Trainer Meet & Greet</span><b>{meetBookingId?`Booked separately · ${meetBookingId}`:"Not booked"}</b></div>
            <div><span>Validity</span><b>{plan.validity} from service start</b></div>
            <div><span>Complimentary care</span><b>{plan.bonus ? "Bath & Basic grooming" : "Not included"}</b></div>
          </article>
          <label className={styles.consent}>Service PIN code<input value={pincode} inputMode="numeric" maxLength={6} onChange={event=>setPincode(event.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Enter six-digit PIN code" /></label>
          <p className={styles.policy}>{coverage?`Coverage confirmed for ${coverage.area || coverage.zoneName}, ${coverage.city}.`:"Enter the service PIN code to resolve the governed city and trainer zone."}</p>
          <div className={styles.paymentOptions}>
            <button className={paymentMode === "half" ? styles.selected : ""} onClick={() => {setPaymentMode("half");setCouponCode("");setCheckoutQuote(null);}}><i>{paymentMode === "half" ? "✓" : ""}</i><div><b>Pay 50% upfront · no discount</b><span>{money(Math.round(plan.price*plan.splitDuePercent/100))} now · {money(plan.price-Math.round(plan.price*plan.splitDuePercent/100))} later under the canonical split schedule</span></div></button>
            <button className={paymentMode === "full" ? styles.selected : ""} onClick={() => {setPaymentMode("full");setCheckoutQuote(null);}}><i>{paymentMode === "full" ? "✓" : ""}</i><div><b>Pay 100% upfront · coupon eligible</b><span>{money(plan.price)} before an eligible coupon</span></div></button>
          </div>
          <CouponField eligible={paymentMode === "full"} service="Dog Training" orderValue={plan.price} customerId={customer.customerId} customerKind="existing" paymentMode={paymentMode === "full" ? "full" : "partial"} onDiscountChange={(_value, code) => {setCouponCode(code);setCheckoutQuote(null);}} />
          {discount > 0 && <article className={styles.couponSaving}>Coupon saving <b>−{money(discount)}</b></article>}
          <article className={styles.policy}><b>Cancellation and refund</b><p>Cancellation requests go for PawSpace approval. Once approved, the unused-session value is refunded after completed sessions and adjustments are reconciled.</p></article>
          <label className={styles.consent}><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />{" "}I agree to training, attendance, rescheduling, safety, media and refund terms.</label>
          <button className={styles.back} onClick={() => setStage(4)}>← Calendar</button>
          <button disabled={!agreed || scheduling || !checkoutQuote || selectedPets.length === 0 || !coverage} className={styles.primary} onClick={confirm}>{scheduling ? "Reserving all sessions…" : !checkoutQuote ? "Refreshing server quote…" : `Pay ${money(payableNow)} & request trainer approval`}</button>
          {scheduleError && <p role="alert">{scheduleError}</p>}
        </section>
      )}
    </>
  );
}
function TrainingDashboard({bookingId,plan,trainerName,pets,serviceMinutes,view,setView}:{bookingId:string;plan:Plan;trainerName:string;pets:string[];serviceMinutes:number;view:"plan"|"homework"|"progress";setView:(v:"plan"|"homework"|"progress")=>void;}) {
  const[ledger,setLedger]=useState<CustomerTrainingProgramme|null>(null),[ledgerError,setLedgerError]=useState(""),[recoveryBusy,setRecoveryBusy]=useState(false),[recoveryStatus,setRecoveryStatus]=useState(""),[toast,setToast]=useState("");
  const flash=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2600);};
  useEffect(()=>{let active=true;void loadTrainingProgramme(bookingId).then(value=>{if(active)setLedger(value);}).catch(problem=>{if(active)setLedgerError(problem instanceof Error?problem.message:"Unable to load programme");});return()=>{active=false;};},[bookingId]);
  const sessions=ledger?.sessions||[],programme=ledger?.programme,completed=sessions.filter(item=>item.status==="completed").length,nextSession=sessions.find(item=>!["completed","cancelled","no_show"].includes(item.status))||null,latestCompleted=[...sessions].reverse().find(item=>item.status==="completed")||null,latestProgress=latestCompleted?jsonObject(latestCompleted.progress_json):{};
  async function requestReschedule(){if(!nextSession)return;const reason=window.prompt("Why do you need to reschedule this Training session?")||"";if(reason.trim().length<8)return;setRecoveryBusy(true);try{const result=await requestTrainingSessionReschedule({bookingId,sessionId:nextSession.id,reason});setRecoveryStatus(`Reschedule request: ${result.status.replaceAll("_"," ")}`);setLedger(await loadTrainingProgramme(bookingId));}catch(problem){setRecoveryStatus(problem instanceof Error?problem.message:"Unable to request reschedule");}finally{setRecoveryBusy(false);}}
  async function requestCancellation(){const reason=window.prompt("Why are you requesting programme cancellation/refund review?")||"";if(reason.trim().length<8)return;setRecoveryBusy(true);try{const result=await requestTrainingCancellation({bookingId,reason});setRecoveryStatus(result.status==="blocked_policy_configuration"?"Cancellation request recorded; Finance policy configuration is required before a refund can be calculated.":`Cancellation case ${result.caseId}: ${result.status.replaceAll("_"," ")}`);}catch(problem){setRecoveryStatus(problem instanceof Error?problem.message:"Unable to request programme cancellation");}finally{setRecoveryBusy(false);}}
  return <section>
    {toast && <div className={styles.toast}>{toast}</div>}
    <article className={styles.trainingSuccess}><i>✓</i><div><small>CANONICAL PROGRAMME · {bookingId}</small><h3>{pets.join(" + ")}&apos;s plan is ready.</h3><p>{programme?`${programme.plan_name} · ${programme.total_sessions} sessions · ${trainerName}`:`Loading canonical programme · ${trainerName}`}</p></div></article>
    {ledgerError&&<article className={styles.cancelRule}><b>Programme ledger unavailable</b><span>{ledgerError}</span></article>}
    <div className={styles.trainingSummary}><div><span>Completed<b>{completed}</b></span><span>Remaining<b>{Math.max(0,(programme?.total_sessions??plan.sessions)-completed)}</b></span><span>Next session<b>{nextSession?slotLabel(new Date(nextSession.scheduled_start)):"None"}</b></span></div><progress max={(programme?.total_sessions??plan.sessions)||1} value={completed}/><small>{programme?`${programme.status.replaceAll("_"," ")} · ${programme.total_sessions} canonical sessions`:"Reading canonical session calendar"}</small></div>
    <article className={styles.balance}><div><b>Payment linked to canonical booking</b><span>Amounts and trainer earnings are reconciled by Finance; this customer view does not invent a balance.</span></div><em>Booking {bookingId}</em></article>
    {plan.bonus&&<article className={styles.bonus}><i>✦</i><div><b>Complimentary grooming benefit</b><span>Benefit fulfilment remains subject to the canonical package terms.</span></div><button onClick={()=>flash("Complimentary grooming benefit terms are attached to your canonical package confirmation.")}>View terms</button></article>}
    <div className={styles.trainingTabs}><button className={view==="plan"?styles.selected:""} onClick={()=>setView("plan")}>Plan</button><button className={view==="homework"?styles.selected:""} onClick={()=>setView("homework")}>Homework</button><button className={view==="progress"?styles.selected:""} onClick={()=>setView("progress")}>Progress</button></div>
    {view==="plan"&&<><article className={styles.nextSession}><span>{nextSession?`NEXT SESSION · ${nextSession.sequence_no} OF ${programme?.total_sessions??plan.sessions}`:"PROGRAMME CALENDAR"}</span><h4>{nextSession?"Training session":"No upcoming active session"}</h4><p>{nextSession?`${slotLabel(new Date(nextSession.scheduled_start))} · ${serviceMinutes} min · ${nextSession.provider_id}`:"All sessions are terminal or the programme is awaiting recovery."}</p><div><button disabled={recoveryBusy||!nextSession} onClick={()=>void requestReschedule()}>Request reschedule</button><button onClick={()=>flash(`Opening secure chat with ${trainerName}. UAT does not deliver a live message yet.`)}>Message trainer</button></div></article><article className={styles.trainerChecklist}><b>Trainer closure requirements</b><span>✓ Attendance and session notes</span><span>✓ Secure proof linked to the exact session</span><span>✓ Homework assigned</span><span>✓ Progress scores recorded</span></article><article className={styles.cancelRule}><b>Recovery protection</b><span>Trainer cancellation, replacement, customer cancellation and no-show states remain linked to the same canonical programme. Session consumption changes only through governed lifecycle actions.</span><button disabled={recoveryBusy||["completed","completed_with_exceptions","cancelled"].includes(String(programme?.status||""))} onClick={()=>void requestCancellation()}>Request programme cancellation / refund review</button>{recoveryStatus&&<small>{recoveryStatus}</small>}</article><div className={styles.sessionList}>{sessions.map(item=><span key={item.id}><i>{item.status==="completed"?"✓":item.sequence_no}</i><b>Session {item.sequence_no}</b><em>{item.status.replaceAll("_"," ")} · {slotLabel(new Date(item.scheduled_start))}</em></span>)}</div></>}
    {view==="homework"&&<>{sessions.filter(item=>item.status==="completed").map(item=>{const homework=jsonObject(item.homework_json),text=String(homework.text||"");return <article className={styles.homework} key={item.id}><span>SESSION {item.sequence_no}</span><h4>{text||"No homework text recorded"}</h4><p>Homework shown here comes from the canonical trainer session report.</p></article>;})}{completed===0&&<article className={styles.homework}><span>CANONICAL HOMEWORK</span><h4>No completed-session homework yet</h4><p>Homework appears only after a trainer closes a session with the required evidence and report.</p></article>}</>}
    {view==="progress"&&<><div className={styles.milestones}>{Object.entries(latestProgress).filter(([,value])=>typeof value==="number").map(([name,value])=><article key={name}><div><b>{name.replaceAll("_"," ")}</b><span>{Number(value)}/10</span></div><progress max="10" value={Number(value)}/></article>)}</div><article className={styles.report}><b>Latest canonical progress</b><p>{latestCompleted?`From completed Session ${latestCompleted.sequence_no}.`:"No completed session has produced progress scores yet."}</p><span>{latestCompleted?"Trainer evidence and homework are linked to the same session record.":"No synthetic progress score is displayed."}</span></article><article className={styles.certificate}><i>♛</i><div><b>Completion certificate readiness</b><span>{programme?.status==="completed"?"Programme is canonically complete; certificate generation can be triggered by the later communications/document gate.":"Certificate remains locked until all required sessions are canonically completed."}</span></div></article><section className={styles.crossSell}><b>Continue care</b><div><Link href="/mobile-app">Bath & Basic</Link><Link href="/food">Fresh Food</Link><Link href="/boarding">Pet Boarding</Link></div></section></>}
  </section>;
}
