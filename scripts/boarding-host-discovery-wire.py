from pathlib import Path
import re

path=Path("app/mobile-app/stay-flow.tsx")
text=path.read_text()

def one(old:str,new:str,label:str):
    global text
    count=text.count(old)
    if count!=1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    text=text.replace(old,new,1)

def sub(pattern:str,replacement:str,label:str,flags=0):
    global text
    text2,count=re.subn(pattern,replacement,text,count=1,flags=flags)
    if count!=1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    text=text2

one('import { loadBoardingCommercial, quoteBoarding, type BoardingQuote } from "../../lib/boarding-commercial-client";','import { loadBoardingCommercial, quoteBoarding, type BoardingHost, type BoardingQuote } from "../../lib/boarding-commercial-client";','boarding host import')
one('''type Caregiver = {
  name: string;
  initials: string;
  area: string;
  rating: string;
  reviews: number;
  repeat: number;
  price: number;
  match: string;
  badge: string;
  response: string;
  home: string;
  features: string[];
  capacity: string;
};''','''type Caregiver = {
  providerId?: string;
  model?: "full_time" | "commission";
  name: string;
  initials: string;
  area: string;
  rating: string;
  reviews?: number;
  repeat?: number;
  price: number;
  match?: string;
  badge: string;
  response?: string;
  home: string;
  features: string[];
  capacity: string;
  availabilityVerified?: boolean;
  availableGuestPets?: number;
};''','caregiver type')
sub(r'const boardingHosts: Caregiver\[\] = \[.*?\n\];\nconst sitters:', 'const sitters:', 'remove Boarding fixtures', re.S)
one('''const pets = [
  { name: "Bruno", detail: "Golden Retriever · 4 years", icon: "🐕" },
  { name: "Coco", detail: "Persian cat · 3 years", icon: "🐈" },
  { name: "Milo", detail: "Beagle · 2 years", icon: "🐶" },
];''','''const pets = [
  { name: "Bruno", detail: "Golden Retriever · 4 years", icon: "🐕", species: "dog" },
  { name: "Coco", detail: "Persian cat · 3 years", icon: "🐈", species: "cat" },
  { name: "Milo", detail: "Beagle · 2 years", icon: "🐶", species: "dog" },
];''','pet species')
one('''const dateOffset = (days: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};''','''const dateOffset = (days: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const boardingPlaceholder: Caregiver = {
  providerId: "",
  name: "Select a verified host",
  initials: "VH",
  area: "Bengaluru East",
  rating: "—",
  price: 0,
  badge: "Governed Boarding",
  home: "Host availability is loaded from PawSpace capacity records for the selected stay window.",
  features: [],
  capacity: "Window availability required",
};
const hostInitials = (name: string) => name.split(/\\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "BH";
const toBoardingCaregiver = (host: BoardingHost): Caregiver => ({
  providerId: host.providerId,
  model: host.model,
  name: host.name,
  initials: hostInitials(host.name),
  area: host.area,
  rating: host.rating.toFixed(1),
  price: 0,
  badge: "Verified Boarding host",
  response: "Selected-window capacity checked",
  home: `Verified host home · resident pets: ${host.residentPets || "none"}`,
  features: [
    `Species: ${host.species.join(", ")}`,
    host.medicationSupport ? "Medication support enabled" : "Medication support not enabled",
    host.oneFamilyOnly ? "One family at a time" : "Multiple families allowed by profile",
    "Home, KYC and background verified",
  ],
  capacity: `${host.availableGuestPets ?? host.capacity} of ${host.capacity} guest-pet spots available`,
  availabilityVerified: Boolean(host.availabilityVerified),
  availableGuestPets: host.availableGuestPets ?? host.capacity,
});''','boarding adapter')
one('''    [caregiver, setCaregiver] = useState(
      (initialMode === "boarding" ? boardingHosts : sitters)[0],
    ),
    [meet, setMeet] = useState(true),''','''    [caregiver, setCaregiver] = useState<Caregiver>(
      initialMode === "boarding" ? boardingPlaceholder : sitters[0],
    ),
    [boardingHosts, setBoardingHosts] = useState<Caregiver[]>([]),
    [boardingHostWindowKey, setBoardingHostWindowKey] = useState(""),
    [boardingHostError, setBoardingHostError] = useState(""),
    [meet, setMeet] = useState(true),''','discovery state')
one('''  const caregivers = mode === "boarding" ? boardingHosts : sitters;
  const nights = Math.max(''','''  const selectedSpecies = [...new Set(selectedPets.map(name => pets.find(pet => pet.name === name)?.species).filter((value): value is string => Boolean(value)))];
  const boardingHostQueryKey = `${start}|${end}|${careWindow}|${selectedPets.slice().sort().join(",")}`;
  const caregivers = mode === "boarding" ? (boardingHostWindowKey === boardingHostQueryKey ? boardingHosts : []) : sitters;
  const nights = Math.max(''','derived discovery key')
one('''  useEffect(()=>{if(mode!=="boarding")return;let active=true;const scheduleStart=new Date(`${start}T03:30:00.000Z`),scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:4)*3_600_000),packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h";void quoteBoarding({packageCode,petCount:selectedPets.length,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:"prepaid"}).then(value=>{if(active){setBoardingQuote(value);setScheduleError("");}}).catch(problem=>{if(active){setBoardingQuote(null);setScheduleError(problem instanceof Error?problem.message:"Unable to refresh Boarding quote");}});return()=>{active=false;};},[mode,careWindow,start,end,selectedPets.length]);''','''  useEffect(()=>{if(mode!=="boarding")return;let active=true;const scheduleStart=new Date(`${start}T03:30:00.000Z`),scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:4)*3_600_000),packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h";void quoteBoarding({packageCode,petCount:selectedPets.length,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:"prepaid"}).then(value=>{if(active){setBoardingQuote(value);setScheduleError("");}}).catch(problem=>{if(active){setBoardingQuote(null);setScheduleError(problem instanceof Error?problem.message:"Unable to refresh Boarding quote");}});return()=>{active=false;};},[mode,careWindow,start,end,selectedPets.length]);
  useEffect(()=>{if(mode!=="boarding")return;let active=true;const queryKey=boardingHostQueryKey,scheduleStart=new Date(`${start}T03:30:00.000Z`),scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:4)*3_600_000);void loadBoardingCommercial({cityId:"blr",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies}).then(data=>{if(!active)return;const hosts=data.hosts.map(toBoardingCaregiver);setBoardingHosts(hosts);setBoardingHostWindowKey(queryKey);setBoardingHostError("");setCaregiver(current=>hosts.find(host=>host.providerId===current.providerId)??hosts[0]??boardingPlaceholder);}).catch(problem=>{if(!active)return;setBoardingHosts([]);setBoardingHostWindowKey(queryKey);setBoardingHostError(problem instanceof Error?problem.message:"Unable to load Boarding host availability");setCaregiver(boardingPlaceholder);});return()=>{active=false;};},[mode,careWindow,start,end,selectedPets.length,boardingHostQueryKey,selectedSpecies.join(",")]);''','discovery effect')
one('''    setCaregiver((next === "boarding" ? boardingHosts : sitters)[0]);''','''    setCaregiver(next === "boarding" ? boardingPlaceholder : sitters[0]);''','switch mode')
one('''const providerIds:Record<string,string>={"Sana F.":"sit_sana","Neha P.":"sit_neha"};const boardingCommercial=mode==="boarding"?await loadBoardingCommercial({cityId:"blr",zoneId:"blr-east"}):null,governedHost=boardingCommercial?.hosts.find(item=>item.name===caregiver.name);if(mode==="boarding"&&!governedHost)throw new Error("Selected Boarding host is no longer active or verified");''','''const providerIds:Record<string,string>={"Sana F.":"sit_sana","Neha P.":"sit_neha"};const boardingCommercial=mode==="boarding"?await loadBoardingCommercial({cityId:"blr",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies}):null,governedHost=boardingCommercial?.hosts.find(item=>item.providerId===caregiver.providerId);if(mode==="boarding"&&!governedHost)throw new Error("Selected Boarding host is no longer available for this stay window");''','confirm governed host')
one('''          <label className={styles.field}>
            Bengaluru area
            <select>
              <option>Indiranagar</option>
              <option>Koramangala</option>
              <option>HSR Layout</option>
              <option>Whitefield</option>
              <option>JP Nagar</option>
            </select>
          </label>''','''          <label className={styles.field}>
            Service zone
            <select value="Bengaluru East · UAT" disabled>
              <option>Bengaluru East · UAT</option>
            </select>
          </label>''','fake area filter')
one('''            {datesValid
              ? `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · request goes to eligible commission partners within 15 km.`
              : "End date must be after the start date."}''','''            {datesValid
              ? mode === "boarding"
                ? `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · PawSpace will check verified host species, leave blocks and stay capacity for this exact window.`
                : `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · request goes to eligible commission partners within 15 km.`
              : "End date must be after the start date."}''','stage one truth')
one('''          <div className={styles.caregivers}>
            {caregivers.map((c, i) => (''','''          {mode === "boarding" && boardingHostWindowKey !== boardingHostQueryKey && <p className={styles.hint}>Checking governed host availability for this stay window…</p>}
          {mode === "boarding" && boardingHostWindowKey === boardingHostQueryKey && caregivers.length === 0 && <p role="alert" className={styles.hint}>{boardingHostError || "No verified Boarding host currently has capacity for every selected pet in this UAT window."}</p>}
          <div className={styles.caregivers}>
            {caregivers.map((c, i) => (''','discovery states')
one('''                key={c.name}''','''                key={c.providerId ?? c.name}''','caregiver key')
one('''                  {i === 0 ? (
                    <img
                      src={
                        mode === "boarding"
                          ? "/assets/stays/maya-rohan-profile.webp"
                          : "/assets/stays/sitter-profile.webp"
                      }
                      alt={c.name + " test profile"}
                    />
                  ) : (
                    <i>{c.initials}</i>
                  )}''','''                  {mode === "sitting" && i === 0 ? (
                    <img src="/assets/stays/sitter-profile.webp" alt={c.name + " test profile"} />
                  ) : (
                    <i>{c.initials}</i>
                  )}''','boarding fixture image')
one('''                  <small>
                      📍 {c.area} · {(i + 1) * 3.2} km · {c.response}
                  </small>''','''                  <small>
                    {mode === "boarding" ? `📍 ${c.area} · selected-window capacity checked` : `📍 ${c.area} · ${(i + 1) * 3.2} km · ${c.response}`}
                  </small>''','host card metadata')
one('''                  <em>
                    {c.match}
                    <small>match</small>
                  </em>''','''                  {mode === "sitting" && <em>
                    {c.match}
                    <small>match</small>
                  </em>}''','match score')
one('''                  <span>
                    <b>{c.rating} ★</b>
                    {c.reviews} reviews · {c.repeat} repeats
                  </span>''','''                  <span>
                    <b>{c.rating} ★</b>
                    {mode === "boarding" ? `${c.availableGuestPets ?? 0} guest-pet spots available` : `${c.reviews} reviews · ${c.repeat} repeats`}
                  </span>''','review claims')
one('''                {mode === "boarding" ? (
                  <label>Governed host profile · capacity rechecked at confirmation</label>''','''                {mode === "boarding" ? (
                  <label>✓ Governed host · selected-window availability verified in UAT</label>''','availability badge')
one('''              <span>
                Photos, reviews, amenities, calendar and care rules are managed
                from the {mode === "boarding" ? "Host" : "Sitter"} Partner App.
              </span>''','''              <span>
                {mode === "boarding" ? "Identity, species eligibility and stay capacity come from PawSpace governed records. Host media and customer reviews are not connected in Boarding UAT." : "Photos, reviews, amenities, calendar and care rules are managed from the Sitter Partner App."}
              </span>''','profile source truth')
one('''          {chatOpen && (
            <article className={styles.secureChat}>
              <header><b>Chat with {caregiver.name}</b><span>Numbers stay masked</span></header>
              <p><b>{caregiver.name.split(" ")[0]}:</b> I can support medication, three walks and the one-hour play routine.</p>
              <p><b>You:</b> {mode === "boarding" ? "Can you confirm medication and routine support for this stay?" : "Can you also arrange pickup and share a flexible all-inclusive price?"}</p>
              <label><input placeholder="Type a message" /><button>Send</button></label>
            </article>
          )}''','''          {chatOpen && (
            mode === "boarding" ? <article className={styles.secureChat}><header><b>Boarding chat</b><span>UAT boundary</span></header><p>Live masked chat is not connected yet. This screen does not simulate host messages.</p></article> : <article className={styles.secureChat}>
              <header><b>Chat with {caregiver.name}</b><span>Numbers stay masked</span></header>
              <p><b>{caregiver.name.split(" ")[0]}:</b> I can support medication, three walks and the one-hour play routine.</p>
              <p><b>You:</b> Can you also arrange pickup and share a flexible all-inclusive price?</p>
              <label><input placeholder="Type a message" /><button>Send</button></label>
            </article>
          )}''','boarding chat truth')
one('''          <button className={styles.primary} onClick={() => setStage(3)}>
            Continue with {caregiver.name.split(" ")[0]}
          </button>''','''          <button className={styles.primary} disabled={mode === "boarding" && !caregiver.providerId} onClick={() => setStage(3)}>
            {mode === "boarding" && !caregiver.providerId ? "Choose an available host" : `Continue with ${caregiver.name.split(" ")[0]}`}
          </button>''','disable missing host')
one('''                {caregiver.name} · {caregiver.rating} ★ · commission partner''','''                {caregiver.name} · {caregiver.rating} ★ · {mode === "boarding" ? `${caregiver.model === "full_time" ? "full-time" : "commission"} host` : "commission partner"}''','provider model truth')
one('''          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>
                Calendar and capacity verified, secure payment, caregiver
                replacement, cancellation/refund workflow and 24/7 incident
                support.
              </span>
            </div>
          </article>''','''          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>{mode === "boarding" ? "Canonical host capacity and UAT payment are verified. Cancellation/refund policy, live messaging and 24/7 support integrations remain pre-live gates." : "Calendar and capacity verified, secure payment, caregiver replacement, cancellation/refund workflow and 24/7 incident support."}</span>
            </div>
          </article>''','protection truth')
one('''            OTP is requested only now. {money(reserveAmount)} will be collected
            in this test checkout.''','''            {mode === "boarding" ? "Production OTP is not connected; this UAT checkout records the server-quoted payment." : "OTP is requested only now."} {money(reserveAmount)} will be collected
            in this test checkout.''','otp truth')
# Replace the entire Boarding branch of CaregiverProfile with a governed, non-fixture profile.
one('''  const boarding = mode === "boarding";
  const gallery = boarding''','''  const boarding = mode === "boarding";
  if (boarding) return (
    <article className={styles.fullProfile}>
      <header className={styles.profileHeader}><div><span>GOVERNED BOARDING HOST · UAT</span><h3>{caregiver.name}</h3><p>📍 {caregiver.area} · selected-window capacity verified</p></div><b>{caregiver.rating} ★</b></header>
      <section className={styles.aboutProfile}><span>CANONICAL HOST PROFILE</span><h4>{caregiver.home}</h4><p>This view uses PawSpace host identity, verification, species eligibility and capacity records. It does not fabricate reviews, response times, media, amenities or day-by-day availability.</p></section>
      <section className={styles.amenities}><div className={styles.profileSectionHead}><b>Governed eligibility</b><span>UAT canonical</span></div><div>{caregiver.features.map(item=><span key={item}>✓ {item}</span>)}</div></section>
      <section className={styles.profileRules}><div><b>Selected stay window</b><span>{shortDate(start)}–{shortDate(end)} · {caregiver.capacity}</span></div><div><b>Availability source</b><span>Host profile + leave blocks + accepted stay locks + pending Boarding scheduler reservations.</span></div></section>
      <footer className={styles.verifiedBar}><div><b>✓ Home verified</b><b>✓ KYC verified</b><b>✓ Background verified</b><b>✓ Capacity checked</b></div><span>Media, reviews and live communications are not connected in Boarding UAT.</span></footer>
    </article>
  );
  const gallery = boarding''','governed profile early return')
# Since boarding returned early, simplify dead ternaries enough to keep lint/typecheck clear without rewriting Pet Sitting.
if 'const boardingHosts: Caregiver[]' in text:
    raise SystemExit('hard-coded Boarding host fixture remains')
for stale in ['maya-rohan-profile.webp','indiranagar-home.webp','pet-guest-room.webp']:
    if stale in text:
        raise SystemExit(f'Boarding fixture media remains: {stale}')
path.write_text(text)
