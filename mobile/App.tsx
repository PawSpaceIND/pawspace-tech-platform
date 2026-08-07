import { StatusBar } from "expo-status-bar";
import { useMemo, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

type Tab = "Home" | "Services" | "Bookings" | "Pets" | "Account";

const purple = "#56208D";
const orange = "#FF9C19";
const ink = "#211432";

const services = [
  { icon: "✂", name: "Grooming", note: "Dog & cat care", color: "#F2E8FF" },
  { icon: "⌁", name: "Dog Training", note: "At your doorstep", color: "#FFF0DA" },
  { icon: "⌂", name: "Boarding", note: "Trusted pet hosts", color: "#E5F7EE" },
  { icon: "♡", name: "Pet Sitting", note: "Care in your home", color: "#FFE9F0" },
  { icon: "♟", name: "Dog Walking", note: "GPS-tracked walks", color: "#E7F2FF" },
  { icon: "↗", name: "Pet Taxi", note: "Safe live-tracked trips", color: "#FFF4D6" },
  { icon: "♨", name: "Fresh Food", note: "Meals & subscriptions", color: "#E9F8E4" },
  { icon: "+", name: "More Care", note: "Relocation & support", color: "#EFEAF6" },
];

const pets = [
  { emoji: "🐕", name: "Bruno", detail: "Golden Retriever · 3 years", tag: "Vaccinated", color: "#FFF0DD" },
  { emoji: "🐈", name: "Misty", detail: "Persian Cat · 2 years", tag: "Profile 80%", color: "#F1E8FF" },
];

const bookings = [
  { date: "08 AUG", title: "Bath & Basic Grooming", pet: "Bruno", slot: "9:00–11:00 AM", status: "Confirmed", price: "₹1,899" },
  { date: "12 AUG", title: "Pet Taxi", pet: "Bruno", slot: "Pickup 11:00 AM–2:00 PM", status: "Scheduled", price: "₹699" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("Home");
  const [pet, setPet] = useState("Bruno");
  const [bookingService, setBookingService] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");

  const visibleServices = useMemo(
    () => services.filter((service) => service.name.toLowerCase().includes(search.toLowerCase())),
    [search],
  );

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.app}>
        {toast ? <View style={styles.toast}><Text style={styles.toastText}>✓ {toast}</Text></View> : null}
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {bookingService ? <BookingFlow service={bookingService} close={() => setBookingService(null)} notify={notify} /> : null}
          {!bookingService && tab === "Home" && <Home pet={pet} setPet={setPet} open={setTab} beginBooking={setBookingService} notify={notify} />}
          {!bookingService && tab === "Services" && <Services search={search} setSearch={setSearch} items={visibleServices} beginBooking={setBookingService} />}
          {!bookingService && tab === "Bookings" && <Bookings notify={notify} />}
          {!bookingService && tab === "Pets" && <Pets notify={notify} />}
          {!bookingService && tab === "Account" && <Account notify={notify} />}
        </ScrollView>
        {!bookingService && <BottomNav tab={tab} setTab={setTab} />}
      </View>
    </SafeAreaView>
  );
}

function Home({ pet, setPet, open, beginBooking, notify }: { pet: string; setPet: (name: string) => void; open: (tab: Tab) => void; beginBooking: (service: string) => void; notify: (message: string) => void }) {
  return <>
    <View style={styles.header}>
      <View><Text style={styles.logo}><Text style={styles.logoOrange}>paw</Text>space</Text><Text style={styles.location}>⌖ Bengaluru · All pincodes⌄</Text></View>
      <TouchableOpacity style={styles.avatar} onPress={() => open("Account")}><Text style={styles.avatarText}>KP</Text><View style={styles.dot} /></TouchableOpacity>
    </View>

    <View style={styles.welcome}><View><Text style={styles.eyebrow}>GOOD EVENING, KARTHIK</Text><Text style={styles.h1}>What does {pet}{"\n"}need today?</Text></View><Text style={styles.paw}>🐾</Text></View>

    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.petSwitcher}>
      {pets.map((item) => <TouchableOpacity key={item.name} style={[styles.petChip, pet === item.name && styles.petChipActive]} onPress={() => setPet(item.name)}><Text>{item.emoji}</Text><Text style={[styles.petChipText, pet === item.name && styles.petChipTextActive]}>{item.name}</Text></TouchableOpacity>)}
      <TouchableOpacity style={styles.addChip} onPress={() => open("Pets")}><Text style={styles.addChipText}>＋ Add pet</Text></TouchableOpacity>
    </ScrollView>

    <View style={styles.hero}>
      <View style={styles.heroCopy}><Text style={styles.heroEyebrow}>PAWSPACE PROMISE</Text><Text style={styles.heroTitle}>Complete care.{"\n"}One trusted app.</Text><Text style={styles.heroBody}>Book verified professionals, follow every update and keep your pet’s complete history.</Text><TouchableOpacity style={styles.heroButton} onPress={() => open("Services")}><Text style={styles.heroButtonText}>Explore all services  →</Text></TouchableOpacity></View>
      <View style={styles.heroPet}><Text style={styles.heroEmoji}>🐕</Text><View style={styles.verified}><Text style={styles.verifiedText}>✓ Verified care</Text></View></View>
    </View>

    <SectionTitle title="Care for every need" action="View all" onPress={() => open("Services")} />
    <View style={styles.serviceGrid}>{services.slice(0, 6).map((item) => <ServiceCard key={item.name} item={item} onPress={() => beginBooking(item.name)} />)}</View>

    <SectionTitle title="Upcoming care" action="All bookings" onPress={() => open("Bookings")} />
    <View style={styles.bookingCard}>
      <View style={styles.bookingTop}><View style={styles.calendar}><Text style={styles.month}>AUG</Text><Text style={styles.day}>08</Text></View><View style={styles.bookingCopy}><Text style={styles.confirmed}>● CONFIRMED</Text><Text style={styles.bookingTitle}>Bath & Basic Grooming</Text><Text style={styles.bookingMeta}>Bruno · 9:00–11:00 AM</Text></View><Text style={styles.arrow}>›</Text></View>
      <View style={styles.provider}><View style={styles.providerAvatar}><Text>AK</Text></View><View style={styles.providerCopy}><Text style={styles.providerName}>Arjun is assigned</Text><Text style={styles.providerMeta}>Senior groomer · 4.8 ★</Text></View><TouchableOpacity onPress={() => notify("Live tracking starts when Arjun begins his journey")}><Text style={styles.track}>Track</Text></TouchableOpacity></View>
    </View>

    <View style={styles.healthCard}><View><Text style={styles.healthEyebrow}>BRUNO’S CARE PROFILE</Text><Text style={styles.healthTitle}>One place for every detail</Text><Text style={styles.healthBody}>Vaccines, allergies, behaviour, meals, bookings and professional notes.</Text><TouchableOpacity onPress={() => open("Pets")}><Text style={styles.link}>View pet timeline →</Text></TouchableOpacity></View><Text style={styles.healthIcon}>♡</Text></View>
  </>;
}

function Services({ search, setSearch, items, beginBooking }: { search: string; setSearch: (value: string) => void; items: typeof services; beginBooking: (service: string) => void }) {
  return <>
    <PageHeader eyebrow="ALL PAWSPACE VERTICALS" title="Care marketplace" subtitle="One trusted experience across your pet’s entire life." />
    <TextInput value={search} onChangeText={setSearch} placeholder="Search grooming, taxi, food…" placeholderTextColor="#8D8198" style={styles.search} />
    <View style={styles.serviceList}>{items.map((item) => <TouchableOpacity key={item.name} style={styles.serviceRow} onPress={() => beginBooking(item.name)}><View style={[styles.serviceIconLarge, { backgroundColor: item.color }]}><Text style={styles.serviceEmoji}>{item.icon}</Text></View><View style={styles.serviceRowCopy}><Text style={styles.serviceRowTitle}>{item.name}</Text><Text style={styles.serviceRowNote}>{item.note}</Text><Text style={styles.serviceBenefit}>Live availability · Verified professional</Text></View><Text style={styles.arrow}>›</Text></TouchableOpacity>)}</View>
    <View style={styles.assurance}><Text style={styles.assuranceIcon}>♢</Text><View><Text style={styles.assuranceTitle}>PawSpace Care Guarantee</Text><Text style={styles.assuranceBody}>Verified partners, transparent pricing, live support and complete service records.</Text></View></View>
  </>;
}

function BookingFlow({ service, close, notify }: { service: string; close: () => void; notify: (message: string) => void }) {
  const [step, setStep] = useState(0);
  const [selectedPets, setSelectedPets] = useState(["Bruno"]);
  const [pack, setPack] = useState("Bath & Basic");
  const [sessions, setSessions] = useState(1);
  const [addons, setAddons] = useState<string[]>([]);
  const [slot, setSlot] = useState("8 Aug · 9:00–11:00 AM");
  const [repeat, setRepeat] = useState("Choose every session myself");
  const steps = ["Pets", "Package", "Schedule", "Address", "Confirm"];
  const isGrooming = service === "Grooming";
  const packages = isGrooming ? [
    { name: "Essential Bath", price: 1349, note: "Bath, shampoo, deshedding, blow dry" },
    { name: "Bath & Basic", price: 1899, note: "Complete hygiene care + minor trim" },
    { name: "Complete Makeover", price: 2399, note: "Full-body trim and styling" },
    { name: "Just Trim", price: 1399, note: "Haircut, nail clipping and ear cleaning" },
  ] : [{ name: `${service} Standard`, price: 999, note: "Verified professional · live updates" }, { name: `${service} Premium`, price: 1599, note: "Priority support and enhanced care" }];
  const selectedPackage = packages.find((item) => item.name === pack) ?? packages[0];
  const addonTotal = addons.reduce((sum, addon) => sum + (addon.includes("Flea") ? 499 : 299), 0);
  const base = (selectedPackage?.price ?? 0) * selectedPets.length;
  const subscriptionPrice = sessions === 12 ? 11988 : sessions === 6 ? 6594 : sessions === 3 ? (pack === "Just Trim" ? 4197 : pack === "Essential Bath" ? 3597 : 2999) : base;
  const total = sessions === 1 ? base + addonTotal : subscriptionPrice * selectedPets.length + addonTotal;
  const togglePet = (name: string) => setSelectedPets((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const toggleAddon = (name: string) => setAddons((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const next = () => step < 4 ? setStep(step + 1) : (notify("Booking confirmed · WhatsApp and app confirmation sent"), close());

  return <View>
    <View style={styles.flowHeader}><TouchableOpacity onPress={step ? () => setStep(step - 1) : close}><Text style={styles.flowBack}>‹</Text></TouchableOpacity><View><Text style={styles.eyebrow}>BOOK {service.toUpperCase()}</Text><Text style={styles.flowTitle}>{steps[step]}</Text></View><TouchableOpacity onPress={close}><Text style={styles.flowClose}>×</Text></TouchableOpacity></View>
    <View style={styles.flowProgress}>{steps.map((item, index) => <View key={item} style={[styles.flowProgressStep, index <= step && styles.flowProgressActive]} />)}</View>

    {step === 0 && <><Text style={styles.flowQuestion}>Who needs {service.toLowerCase()}?</Text><Text style={styles.flowHint}>Select up to four pets. Five or more becomes a priority enquiry.</Text>{pets.map((item) => <TouchableOpacity key={item.name} style={[styles.petProfile, selectedPets.includes(item.name) && styles.flowSelected]} onPress={() => togglePet(item.name)}><View style={[styles.petPortrait, { backgroundColor: item.color }]}><Text style={styles.petPortraitEmoji}>{item.emoji}</Text></View><View style={styles.petProfileCopy}><Text style={styles.petName}>{item.name}</Text><Text style={styles.petDetail}>{item.detail}</Text></View><View style={[styles.check, selectedPets.includes(item.name) && styles.checkActive]}><Text style={styles.checkText}>{selectedPets.includes(item.name) ? "✓" : ""}</Text></View></TouchableOpacity>)}<TouchableOpacity style={styles.addPet} onPress={() => notify("Quick pet profile opened") }><Text style={styles.addPetIcon}>＋</Text><View><Text style={styles.addPetTitle}>Add a pet for this booking</Text><Text style={styles.addPetBody}>Basic profile now; complete health details later</Text></View></TouchableOpacity></>}

    {step === 1 && <><Text style={styles.flowQuestion}>Choose the care package</Text><Text style={styles.flowHint}>Clear inclusions and final prices—no surprises after service.</Text>{packages.map((item) => <TouchableOpacity key={item.name} style={[styles.packageCard, pack === item.name && styles.flowSelected]} onPress={() => setPack(item.name)}><View style={styles.packageRadio}>{pack === item.name && <View style={styles.packageRadioInner} />}</View><View style={styles.packageCopy}><Text style={styles.packageName}>{item.name}</Text><Text style={styles.packageNote}>{item.note}</Text></View><Text style={styles.packagePrice}>₹{item.price.toLocaleString("en-IN")}</Text></TouchableOpacity>)}<Text style={styles.miniTitle}>Booking type</Text><View style={styles.sessionGrid}>{[1,3,6,12].map((count) => <TouchableOpacity key={count} style={[styles.sessionButton, sessions === count && styles.sessionActive]} onPress={() => setSessions(count)}><Text style={[styles.sessionCount, sessions === count && styles.sessionActiveText]}>{count}</Text><Text style={[styles.sessionLabel, sessions === count && styles.sessionActiveText]}>{count === 1 ? "One time" : "sessions"}</Text></TouchableOpacity>)}</View><Text style={styles.miniTitle}>Optional add-ons</Text>{["Tick & Flea Treatment · ₹499", "Full Body Oil Massage · ₹299"].map((item) => <TouchableOpacity style={styles.addonRow} key={item} onPress={() => toggleAddon(item)}><Text style={styles.addonText}>{item}</Text><View style={[styles.check, addons.includes(item) && styles.checkActive]}><Text style={styles.checkText}>{addons.includes(item) ? "✓" : ""}</Text></View></TouchableOpacity>)}</>}

    {step === 2 && <><Text style={styles.flowQuestion}>{sessions > 1 ? "Plan your sessions" : "Choose a live slot"}</Text><Text style={styles.flowHint}>{sessions > 1 ? "Book all sessions now or receive a reminder every 15 days." : "Only currently available groomer slots are shown."}</Text>{sessions > 1 && <View style={styles.repeatOptions}>{["Schedule every 15 days", "Choose every session myself", "Remind me before booking"].map((item) => <TouchableOpacity style={[styles.repeatOption, repeat === item && styles.flowSelected]} key={item} onPress={() => setRepeat(item)}><View style={styles.packageRadio}>{repeat === item && <View style={styles.packageRadioInner} />}</View><Text style={styles.repeatText}>{item}</Text></TouchableOpacity>)}</View>}<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dateStrip}>{["Thu 6","Fri 7","Sat 8","Sun 9","Mon 10","Tue 11"].map((date) => <TouchableOpacity style={[styles.dateCard, date === "Sat 8" && styles.dateActive]} key={date}><Text style={styles.dateDay}>{date.split(" ")[0]}</Text><Text style={styles.dateNumber}>{date.split(" ")[1]}</Text></TouchableOpacity>)}</ScrollView><View style={styles.slotGrid}>{["9:00–11:00 AM","11:00 AM–1:00 PM","1:00–3:00 PM","3:00–5:00 PM","5:00–7:00 PM"].map((time, index) => <TouchableOpacity key={time} disabled={index === 1} style={[styles.slotButton, slot.includes(time) && styles.slotActive, index === 1 && styles.slotDisabled]} onPress={() => setSlot(`8 Aug · ${time}`)}><Text style={[styles.slotText, slot.includes(time) && styles.slotActiveText]}>{time}</Text><Text style={styles.slotAvailability}>{index === 1 ? "Booked" : index === 3 ? "2 groomers" : "Available"}</Text></TouchableOpacity>)}</View>{sessions > 1 && <View style={styles.scheduleSummary}><Text style={styles.scheduleSummaryTitle}>{sessions} sessions planned</Text><Text style={styles.scheduleSummaryBody}>{repeat === "Schedule every 15 days" ? `Starting 8 Aug, automatically every 15 days. Change any session anytime.` : "The first session is reserved now. Remaining sessions stay in your wallet with reminders."}</Text></View>}</>}

    {step === 3 && <><Text style={styles.flowQuestion}>Where should we come?</Text><Text style={styles.flowHint}>PawSpace currently serves all Bengaluru pincodes. No pincode check needed.</Text><TouchableOpacity style={[styles.addressCard, styles.flowSelected]}><View style={styles.addressIcon}><Text>⌂</Text></View><View style={styles.addressCopy}><Text style={styles.addressTitle}>Home</Text><Text style={styles.addressBody}>144, 5th Main, Indiranagar, Bengaluru</Text><Text style={styles.addressMeta}>Primary · Door instructions saved</Text></View><Text style={styles.checkTextPurple}>✓</Text></TouchableOpacity><TouchableOpacity style={styles.addPet} onPress={() => notify("New address form opened")}><Text style={styles.addPetIcon}>＋</Text><View><Text style={styles.addPetTitle}>Add another address</Text><Text style={styles.addPetBody}>Apartment, landmark and access instructions</Text></View></TouchableOpacity><View style={styles.contactCard}><Text style={styles.miniTitle}>Booking contacts</Text><Text style={styles.contactLabel}>Primary · receives payment details</Text><Text style={styles.contactValue}>Karthik · +91 99••• ••505</Text><Text style={styles.contactLabel}>Secondary · service coordination</Text><Text style={styles.contactValue}>Add secondary number</Text></View></>}

    {step === 4 && <><Text style={styles.flowQuestion}>Review and confirm</Text><View style={styles.reviewCard}><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Service</Text><Text style={styles.reviewValue}>{service} · {pack}</Text></View><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Pets</Text><Text style={styles.reviewValue}>{selectedPets.join(", ")}</Text></View><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Schedule</Text><Text style={styles.reviewValue}>{slot}</Text></View><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Booking type</Text><Text style={styles.reviewValue}>{sessions === 1 ? "One-time service" : `${sessions}-session subscription`}</Text></View><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Address</Text><Text style={styles.reviewValue}>Home · Indiranagar</Text></View><View style={styles.reviewRow}><Text style={styles.reviewLabel}>Payment</Text><Text style={styles.reviewValue}>Pay after service</Text></View><View style={styles.reviewTotal}><Text style={styles.reviewTotalLabel}>Total</Text><Text style={styles.reviewTotalValue}>₹{total.toLocaleString("en-IN")}</Text></View></View><View style={styles.otpCard}><Text style={styles.otpTitle}>OTP verification at confirmation</Text><Text style={styles.otpBody}>Browse freely. We verify the primary number only now to protect the booking and customer record.</Text></View><View style={styles.securityCard}><Text style={styles.securityIcon}>⌾</Text><Text style={styles.securityText}>Phone numbers remain masked for service professionals. Access is logged and controlled by role.</Text></View></>}

    <View style={styles.flowFooter}><View><Text style={styles.flowTotalLabel}>{sessions === 1 ? "TOTAL" : `${sessions}-SESSION PLAN`}</Text><Text style={styles.flowTotal}>₹{total.toLocaleString("en-IN")}</Text></View><TouchableOpacity style={[styles.continueButton, !selectedPets.length && styles.slotDisabled]} disabled={!selectedPets.length} onPress={next}><Text style={styles.continueText}>{step === 4 ? "Verify OTP & confirm" : "Continue"}</Text></TouchableOpacity></View>
  </View>;
}

function Bookings({ notify }: { notify: (message: string) => void }) {
  return <>
    <PageHeader eyebrow="YOU ARE IN CONTROL" title="Your bookings" subtitle="Track, reschedule, pay and review every service." />
    <View style={styles.segment}><TouchableOpacity style={styles.segmentActive}><Text style={styles.segmentActiveText}>Upcoming</Text></TouchableOpacity><TouchableOpacity><Text style={styles.segmentText}>Completed</Text></TouchableOpacity><TouchableOpacity><Text style={styles.segmentText}>Cancelled</Text></TouchableOpacity></View>
    {bookings.map((booking) => <View style={styles.fullBooking} key={booking.date + booking.title}><View style={styles.fullBookingHead}><View style={styles.calendar}><Text style={styles.month}>{booking.date.split(" ")[1]}</Text><Text style={styles.day}>{booking.date.split(" ")[0]}</Text></View><View style={styles.bookingCopy}><Text style={styles.confirmed}>● {booking.status.toUpperCase()}</Text><Text style={styles.bookingTitle}>{booking.title}</Text><Text style={styles.bookingMeta}>{booking.pet} · {booking.slot}</Text></View><Text style={styles.price}>{booking.price}</Text></View><View style={styles.bookingActions}><TouchableOpacity onPress={() => notify("Booking details opened")}><Text style={styles.secondaryButtonText}>View details</Text></TouchableOpacity><TouchableOpacity onPress={() => notify("Live calendar opened for rescheduling")}><Text style={styles.secondaryButtonText}>Reschedule</Text></TouchableOpacity><TouchableOpacity style={styles.primarySmall} onPress={() => notify("Tracking will activate on service day")}><Text style={styles.primarySmallText}>Track</Text></TouchableOpacity></View></View>)}
    <TouchableOpacity style={styles.subscription} onPress={() => notify("Subscription wallet opened")}><View><Text style={styles.subscriptionTag}>PAWSPACE PLUS</Text><Text style={styles.subscriptionTitle}>12-session care plan</Text><Text style={styles.subscriptionBody}>9 sessions available · Valid until 12 Nov 2027</Text></View><Text style={styles.subscriptionArrow}>›</Text></TouchableOpacity>
  </>;
}

function Pets({ notify }: { notify: (message: string) => void }) {
  return <>
    <PageHeader eyebrow="YOUR PET FAMILY" title="Pet profiles" subtitle="Their identity, preferences and lifetime care history." />
    {pets.map((item, index) => <TouchableOpacity style={styles.petProfile} key={item.name} onPress={() => notify(`${item.name}’s complete timeline opened`)}><View style={[styles.petPortrait, { backgroundColor: item.color }]}><Text style={styles.petPortraitEmoji}>{item.emoji}</Text></View><View style={styles.petProfileCopy}><Text style={styles.petName}>{item.name}</Text><Text style={styles.petDetail}>{item.detail}</Text><View style={styles.petTags}><Text style={styles.petTag}>{item.tag}</Text><Text style={styles.petTag}>{index ? "Indoor pet" : "Friendly"}</Text></View></View><Text style={styles.arrow}>›</Text></TouchableOpacity>)}
    <TouchableOpacity style={styles.addPet} onPress={() => notify("New pet onboarding started")}><Text style={styles.addPetIcon}>＋</Text><View><Text style={styles.addPetTitle}>Add another pet</Text><Text style={styles.addPetBody}>Dogs, cats and other companion animals</Text></View></TouchableOpacity>
    <SectionTitle title="Bruno’s care timeline" />
    {[{ icon: "✂", title: "Bath & Basic completed", meta: "28 Jul · Groomer Arjun · 5 ★" }, { icon: "♡", title: "Rabies vaccination added", meta: "14 Jul · Document verified" }, { icon: "♨", title: "Fresh food preference updated", meta: "Chicken & pumpkin · 500 g" }].map((event, index) => <View style={styles.timeline} key={event.title}><View style={styles.timelineRail}><View style={styles.timelineIcon}><Text>{event.icon}</Text></View>{index < 2 && <View style={styles.timelineLine} />}</View><View><Text style={styles.timelineTitle}>{event.title}</Text><Text style={styles.timelineMeta}>{event.meta}</Text></View></View>)}
  </>;
}

function Account({ notify }: { notify: (message: string) => void }) {
  const items = ["Family & contact details", "Saved addresses", "Payments & PawSpace wallet", "Subscriptions & coupons", "Notifications & reminders", "Support & open tickets", "Privacy and security"];
  return <>
    <PageHeader eyebrow="PAWSPACE FAMILY" title="Your account" subtitle="Everything connected to one verified mobile number." />
    <View style={styles.accountHead}><View style={styles.accountAvatar}><Text style={styles.accountAvatarText}>KP</Text></View><View><Text style={styles.accountName}>Karthik</Text><Text style={styles.accountPhone}>+91 99••• ••505 · Verified</Text><Text style={styles.member}>PawSpace member since 2022</Text></View></View>
    <View style={styles.accountStats}><View><Text style={styles.accountStatValue}>18</Text><Text style={styles.accountStatLabel}>Bookings</Text></View><View><Text style={styles.accountStatValue}>2</Text><Text style={styles.accountStatLabel}>Pets</Text></View><View><Text style={styles.accountStatValue}>₹850</Text><Text style={styles.accountStatLabel}>Wallet</Text></View></View>
    <View style={styles.menu}>{items.map((item, index) => <TouchableOpacity style={styles.menuRow} key={item} onPress={() => notify(`${item} opened`)}><View style={styles.menuIcon}><Text>{["♙", "⌖", "₹", "◇", "♢", "?", "⌾"][index]}</Text></View><Text style={styles.menuText}>{item}</Text>{item.includes("tickets") && <Text style={styles.menuBadge}>1 open</Text>}<Text style={styles.arrow}>›</Text></TouchableOpacity>)}</View>
    <Text style={styles.prototypeNote}>Phase 1 prototype · Real OTP, payments and customer data will be connected during integration.</Text>
  </>;
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items: { name: Tab; icon: string }[] = [{ name: "Home", icon: "⌂" }, { name: "Services", icon: "✦" }, { name: "Bookings", icon: "▣" }, { name: "Pets", icon: "♡" }, { name: "Account", icon: "○" }];
  return <View style={styles.bottomNav}>{items.map((item) => <TouchableOpacity key={item.name} style={styles.navItem} onPress={() => setTab(item.name)}><Text style={[styles.navIcon, tab === item.name && styles.navActive]}>{item.icon}</Text><Text style={[styles.navText, tab === item.name && styles.navActive]}>{item.name}</Text>{tab === item.name && <View style={styles.navDot} />}</TouchableOpacity>)}</View>;
}

function ServiceCard({ item, onPress }: { item: typeof services[number]; onPress: () => void }) {
  return <TouchableOpacity style={styles.serviceCard} onPress={onPress}><View style={[styles.serviceIcon, { backgroundColor: item.color }]}><Text style={styles.serviceEmoji}>{item.icon}</Text></View><Text style={styles.serviceName}>{item.name}</Text><Text style={styles.serviceNote}>{item.note}</Text></TouchableOpacity>;
}

function SectionTitle({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return <View style={styles.sectionTitle}><Text style={styles.sectionHeading}>{title}</Text>{action && <TouchableOpacity onPress={onPress}><Text style={styles.sectionAction}>{action} →</Text></TouchableOpacity>}</View>;
}

function PageHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <View style={styles.pageHeader}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.pageTitle}>{title}</Text><Text style={styles.pageSubtitle}>{subtitle}</Text></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FAF8FC" }, app: { flex: 1, backgroundColor: "#FAF8FC" }, scroll: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 118 },
  toast: { position: "absolute", zIndex: 9, top: 12, alignSelf: "center", backgroundColor: "#197447", borderRadius: 24, paddingHorizontal: 18, paddingVertical: 11 }, toastText: { color: "white", fontWeight: "800", fontSize: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 26 }, logo: { color: purple, fontSize: 28, fontWeight: "900", letterSpacing: -1.5 }, logoOrange: { color: orange }, location: { color: "#6D6178", fontSize: 11, marginTop: 2 }, avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: purple, alignItems: "center", justifyContent: "center" }, avatarText: { color: "white", fontWeight: "900" }, dot: { position: "absolute", width: 10, height: 10, borderRadius: 5, backgroundColor: "#32B56C", right: 0, bottom: 1, borderWidth: 2, borderColor: "white" },
  welcome: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, eyebrow: { color: "#846C9D", fontSize: 10, letterSpacing: 1.2, fontWeight: "800" }, h1: { color: ink, fontSize: 30, fontWeight: "900", lineHeight: 35, marginTop: 6 }, paw: { fontSize: 44, opacity: .16 },
  petSwitcher: { gap: 8, paddingVertical: 18 }, petChip: { flexDirection: "row", gap: 6, alignItems: "center", borderRadius: 22, borderWidth: 1, borderColor: "#E5DDEA", paddingHorizontal: 13, paddingVertical: 9, backgroundColor: "white" }, petChipActive: { backgroundColor: purple, borderColor: purple }, petChipText: { color: ink, fontSize: 12, fontWeight: "700" }, petChipTextActive: { color: "white" }, addChip: { borderRadius: 22, borderWidth: 1, borderStyle: "dashed", borderColor: "#BFAAD0", paddingHorizontal: 13, justifyContent: "center" }, addChipText: { color: purple, fontSize: 12, fontWeight: "800" },
  hero: { minHeight: 238, backgroundColor: purple, borderRadius: 24, overflow: "hidden", flexDirection: "row", padding: 22 }, heroCopy: { width: "67%", zIndex: 2 }, heroEyebrow: { color: "#D5B9EF", fontSize: 9, letterSpacing: 1.2, fontWeight: "900" }, heroTitle: { color: "white", fontSize: 26, lineHeight: 30, fontWeight: "900", marginTop: 8 }, heroBody: { color: "#E2D4EE", fontSize: 12, lineHeight: 17, marginTop: 9 }, heroButton: { alignSelf: "flex-start", backgroundColor: orange, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, marginTop: 15 }, heroButtonText: { color: "#2D1548", fontWeight: "900", fontSize: 11 }, heroPet: { position: "absolute", right: -18, bottom: -8, alignItems: "center" }, heroEmoji: { fontSize: 126 }, verified: { position: "absolute", bottom: 18, right: 19, backgroundColor: "white", borderRadius: 15, paddingHorizontal: 9, paddingVertical: 5 }, verifiedText: { color: "#237848", fontSize: 9, fontWeight: "800" },
  sectionTitle: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 28, marginBottom: 13 }, sectionHeading: { fontSize: 19, color: ink, fontWeight: "900" }, sectionAction: { color: purple, fontSize: 11, fontWeight: "800" },
  serviceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 }, serviceCard: { width: "31.4%", minHeight: 125, backgroundColor: "white", borderRadius: 17, borderWidth: 1, borderColor: "#ECE5F0", padding: 10 }, serviceIcon: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", marginBottom: 9 }, serviceEmoji: { color: purple, fontSize: 20, fontWeight: "900" }, serviceName: { color: ink, fontSize: 12, fontWeight: "900" }, serviceNote: { color: "#7E7189", fontSize: 9, lineHeight: 13, marginTop: 3 },
  bookingCard: { backgroundColor: "white", borderWidth: 1, borderColor: "#E9E1EE", borderRadius: 19, overflow: "hidden" }, bookingTop: { flexDirection: "row", alignItems: "center", padding: 15 }, calendar: { width: 48, height: 54, borderRadius: 11, overflow: "hidden", backgroundColor: "#F0E5FA", alignItems: "center" }, month: { backgroundColor: purple, color: "white", width: "100%", textAlign: "center", fontSize: 8, fontWeight: "900", paddingVertical: 3 }, day: { color: purple, fontSize: 20, fontWeight: "900", marginTop: 4 }, bookingCopy: { flex: 1, marginLeft: 12 }, confirmed: { color: "#238351", fontSize: 8, fontWeight: "900", letterSpacing: .7 }, bookingTitle: { color: ink, fontSize: 14, fontWeight: "900", marginTop: 4 }, bookingMeta: { color: "#7D7087", fontSize: 10, marginTop: 4 }, arrow: { color: "#A090AD", fontSize: 28 }, provider: { flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderTopColor: "#EEE8F1", padding: 12, backgroundColor: "#FCFAFD" }, providerAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#FFE1B3", alignItems: "center", justifyContent: "center" }, providerCopy: { flex: 1, marginLeft: 9 }, providerName: { color: ink, fontSize: 11, fontWeight: "800" }, providerMeta: { color: "#82758D", fontSize: 9, marginTop: 2 }, track: { color: purple, fontSize: 11, fontWeight: "900" },
  healthCard: { marginTop: 16, backgroundColor: "#EBF7F1", borderRadius: 19, padding: 19, flexDirection: "row" }, healthEyebrow: { color: "#39805C", fontSize: 8, letterSpacing: 1, fontWeight: "900" }, healthTitle: { color: "#173D2B", fontSize: 17, fontWeight: "900", marginTop: 5 }, healthBody: { color: "#547262", fontSize: 10, lineHeight: 15, marginTop: 5, maxWidth: 260 }, healthIcon: { position: "absolute", right: 18, top: 13, color: "#39805C", fontSize: 34 }, link: { color: "#25714B", fontSize: 10, fontWeight: "900", marginTop: 10 },
  pageHeader: { marginBottom: 20, marginTop: 4 }, pageTitle: { color: ink, fontSize: 30, fontWeight: "900", marginTop: 5 }, pageSubtitle: { color: "#776A83", fontSize: 12, lineHeight: 17, marginTop: 5 }, search: { backgroundColor: "white", borderWidth: 1, borderColor: "#E6DEEA", borderRadius: 14, paddingHorizontal: 15, paddingVertical: 14, color: ink, marginBottom: 12 },
  serviceList: { gap: 9 }, serviceRow: { backgroundColor: "white", borderWidth: 1, borderColor: "#EAE3EE", borderRadius: 17, padding: 13, flexDirection: "row", alignItems: "center" }, serviceIconLarge: { width: 55, height: 55, borderRadius: 17, alignItems: "center", justifyContent: "center" }, serviceRowCopy: { flex: 1, marginLeft: 13 }, serviceRowTitle: { color: ink, fontSize: 15, fontWeight: "900" }, serviceRowNote: { color: "#776A83", fontSize: 10, marginTop: 2 }, serviceBenefit: { color: "#288050", fontSize: 9, marginTop: 5, fontWeight: "700" }, assurance: { marginTop: 18, padding: 17, borderRadius: 17, backgroundColor: "#F0E8FA", flexDirection: "row", gap: 13 }, assuranceIcon: { color: purple, fontSize: 25 }, assuranceTitle: { color: purple, fontSize: 13, fontWeight: "900" }, assuranceBody: { color: "#6C5A7B", fontSize: 10, lineHeight: 15, marginTop: 3, maxWidth: 290 },
  segment: { flexDirection: "row", backgroundColor: "#EEE8F2", borderRadius: 13, padding: 4, marginBottom: 15 }, segmentActive: { flex: 1, backgroundColor: "white", borderRadius: 10, paddingVertical: 9 }, segmentActiveText: { color: purple, textAlign: "center", fontSize: 10, fontWeight: "900" }, segmentText: { color: "#82758D", textAlign: "center", fontSize: 10, fontWeight: "700", paddingVertical: 9, paddingHorizontal: 16 }, fullBooking: { backgroundColor: "white", borderRadius: 18, borderWidth: 1, borderColor: "#E8E1EC", marginBottom: 12, overflow: "hidden" }, fullBookingHead: { flexDirection: "row", alignItems: "center", padding: 15 }, price: { color: ink, fontSize: 14, fontWeight: "900" }, bookingActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: "#EEE8F1", padding: 11 }, secondaryButtonText: { color: purple, fontSize: 10, fontWeight: "800" }, primarySmall: { backgroundColor: purple, borderRadius: 9, paddingHorizontal: 15, paddingVertical: 8 }, primarySmallText: { color: "white", fontSize: 10, fontWeight: "900" }, subscription: { backgroundColor: "#24103F", borderRadius: 18, padding: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 5 }, subscriptionTag: { color: orange, fontSize: 8, fontWeight: "900", letterSpacing: 1 }, subscriptionTitle: { color: "white", fontSize: 17, fontWeight: "900", marginTop: 5 }, subscriptionBody: { color: "#CDBBE0", fontSize: 9, marginTop: 4 }, subscriptionArrow: { color: orange, fontSize: 30 },
  petProfile: { backgroundColor: "white", borderWidth: 1, borderColor: "#E9E2ED", borderRadius: 19, padding: 13, flexDirection: "row", alignItems: "center", marginBottom: 11 }, petPortrait: { width: 72, height: 72, borderRadius: 20, alignItems: "center", justifyContent: "center" }, petPortraitEmoji: { fontSize: 40 }, petProfileCopy: { flex: 1, marginLeft: 14 }, petName: { color: ink, fontSize: 18, fontWeight: "900" }, petDetail: { color: "#786B83", fontSize: 10, marginTop: 3 }, petTags: { flexDirection: "row", gap: 5, marginTop: 9 }, petTag: { backgroundColor: "#E8F7EE", color: "#28794D", fontSize: 8, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 9 }, addPet: { borderWidth: 1, borderStyle: "dashed", borderColor: "#BBA6CC", borderRadius: 17, padding: 15, flexDirection: "row", alignItems: "center" }, addPetIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#F0E8F7", color: purple, textAlign: "center", paddingTop: 8, fontSize: 21, fontWeight: "700" }, addPetTitle: { color: purple, fontSize: 13, fontWeight: "900", marginLeft: 11 }, addPetBody: { color: "#7F7289", fontSize: 9, marginLeft: 11, marginTop: 3 }, timeline: { flexDirection: "row", minHeight: 66 }, timelineRail: { width: 42, alignItems: "center" }, timelineIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#EFE7F7", alignItems: "center", justifyContent: "center" }, timelineLine: { width: 1, flex: 1, backgroundColor: "#D9CEE2" }, timelineTitle: { color: ink, fontSize: 12, fontWeight: "800", marginTop: 5 }, timelineMeta: { color: "#81748B", fontSize: 9, marginTop: 4 },
  accountHead: { backgroundColor: purple, borderRadius: 20, padding: 20, flexDirection: "row", alignItems: "center" }, accountAvatar: { width: 62, height: 62, borderRadius: 31, backgroundColor: orange, alignItems: "center", justifyContent: "center" }, accountAvatarText: { color: "#2C1346", fontWeight: "900", fontSize: 19 }, accountName: { color: "white", fontSize: 19, fontWeight: "900", marginLeft: 14 }, accountPhone: { color: "#DDCDEA", fontSize: 10, marginLeft: 14, marginTop: 4 }, member: { color: orange, fontSize: 9, marginLeft: 14, marginTop: 6, fontWeight: "800" }, accountStats: { flexDirection: "row", backgroundColor: "white", borderWidth: 1, borderColor: "#E7E0EB", borderRadius: 17, marginTop: 12, paddingVertical: 15, justifyContent: "space-around" }, accountStatValue: { color: ink, fontSize: 17, fontWeight: "900", textAlign: "center" }, accountStatLabel: { color: "#80728A", fontSize: 9, marginTop: 3 }, menu: { backgroundColor: "white", borderWidth: 1, borderColor: "#E8E1EC", borderRadius: 18, marginTop: 14, overflow: "hidden" }, menuRow: { flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderBottomColor: "#F0EBF2" }, menuIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: "#F2EBF8", alignItems: "center", justifyContent: "center" }, menuText: { flex: 1, color: ink, fontSize: 11, fontWeight: "800", marginLeft: 10 }, menuBadge: { color: "#9B5D00", backgroundColor: "#FFF0D5", borderRadius: 9, paddingHorizontal: 7, paddingVertical: 3, fontSize: 8, fontWeight: "800" }, prototypeNote: { color: "#93879B", fontSize: 9, textAlign: "center", lineHeight: 14, marginTop: 18 },
  bottomNav: { position: "absolute", bottom: 0, left: 0, right: 0, height: 82, paddingBottom: 11, backgroundColor: "white", borderTopWidth: 1, borderTopColor: "#E9E3ED", flexDirection: "row", shadowColor: "#32154E", shadowOpacity: .08, shadowRadius: 15 }, navItem: { flex: 1, alignItems: "center", justifyContent: "center" }, navIcon: { color: "#92879B", fontSize: 20, fontWeight: "700" }, navText: { color: "#92879B", fontSize: 8, fontWeight: "700", marginTop: 3 }, navActive: { color: purple }, navDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: orange, marginTop: 3 },
  flowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }, flowBack: { color: purple, fontSize: 40, lineHeight: 40 }, flowClose: { color: "#7D7088", fontSize: 28 }, flowTitle: { color: ink, fontSize: 22, fontWeight: "900", marginTop: 3 }, flowProgress: { flexDirection: "row", gap: 5, marginBottom: 24 }, flowProgressStep: { height: 5, flex: 1, backgroundColor: "#E5DDE9", borderRadius: 5 }, flowProgressActive: { backgroundColor: purple }, flowQuestion: { color: ink, fontSize: 23, lineHeight: 29, fontWeight: "900" }, flowHint: { color: "#796D83", fontSize: 11, lineHeight: 16, marginTop: 5, marginBottom: 16 }, flowSelected: { borderWidth: 2, borderColor: purple, backgroundColor: "#FCF9FF" }, check: { width: 25, height: 25, borderRadius: 8, borderWidth: 1, borderColor: "#D4C9DC", alignItems: "center", justifyContent: "center" }, checkActive: { backgroundColor: purple, borderColor: purple }, checkText: { color: "white", fontWeight: "900" },
  packageCard: { flexDirection: "row", alignItems: "center", backgroundColor: "white", borderWidth: 1, borderColor: "#E6DEEA", borderRadius: 16, padding: 14, marginBottom: 9 }, packageRadio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: "#9D87AD", alignItems: "center", justifyContent: "center" }, packageRadioInner: { width: 11, height: 11, borderRadius: 6, backgroundColor: purple }, packageCopy: { flex: 1, marginLeft: 11 }, packageName: { color: ink, fontSize: 14, fontWeight: "900" }, packageNote: { color: "#7B6E85", fontSize: 9, marginTop: 4 }, packagePrice: { color: purple, fontSize: 15, fontWeight: "900" }, miniTitle: { color: ink, fontSize: 13, fontWeight: "900", marginTop: 17, marginBottom: 9 }, sessionGrid: { flexDirection: "row", gap: 7 }, sessionButton: { flex: 1, borderWidth: 1, borderColor: "#DDD3E4", backgroundColor: "white", borderRadius: 12, alignItems: "center", paddingVertical: 11 }, sessionActive: { backgroundColor: purple, borderColor: purple }, sessionCount: { color: ink, fontSize: 17, fontWeight: "900" }, sessionLabel: { color: "#7F7289", fontSize: 8, marginTop: 2 }, sessionActiveText: { color: "white" }, addonRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 13, backgroundColor: "white", borderWidth: 1, borderColor: "#E7E0EA", borderRadius: 12, marginBottom: 7 }, addonText: { color: ink, fontSize: 11, fontWeight: "700" },
  repeatOptions: { gap: 7, marginBottom: 17 }, repeatOption: { flexDirection: "row", gap: 10, padding: 13, alignItems: "center", borderWidth: 1, borderColor: "#E4DBE9", backgroundColor: "white", borderRadius: 13 }, repeatText: { color: ink, fontSize: 11, fontWeight: "800" }, dateStrip: { gap: 8, marginBottom: 14 }, dateCard: { width: 57, height: 65, borderRadius: 14, borderWidth: 1, borderColor: "#DED4E5", backgroundColor: "white", alignItems: "center", justifyContent: "center" }, dateActive: { backgroundColor: purple, borderColor: purple }, dateDay: { color: "#7C6F86", fontSize: 8, fontWeight: "700" }, dateNumber: { color: ink, fontSize: 18, fontWeight: "900", marginTop: 3 }, slotGrid: { gap: 8 }, slotButton: { borderWidth: 1, borderColor: "#DDD3E4", backgroundColor: "white", borderRadius: 13, padding: 13, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, slotActive: { backgroundColor: purple, borderColor: purple }, slotDisabled: { opacity: .42 }, slotText: { color: ink, fontSize: 11, fontWeight: "900" }, slotActiveText: { color: "white" }, slotAvailability: { color: "#2D8857", fontSize: 9, fontWeight: "800" }, scheduleSummary: { backgroundColor: "#EAF7F0", borderRadius: 14, padding: 14, marginTop: 13 }, scheduleSummaryTitle: { color: "#236E48", fontSize: 12, fontWeight: "900" }, scheduleSummaryBody: { color: "#527462", fontSize: 9, lineHeight: 14, marginTop: 4 },
  addressCard: { flexDirection: "row", alignItems: "center", backgroundColor: "white", borderRadius: 16, padding: 14, marginBottom: 10 }, addressIcon: { width: 45, height: 45, borderRadius: 14, backgroundColor: "#F1E8F9", alignItems: "center", justifyContent: "center" }, addressCopy: { flex: 1, marginLeft: 11 }, addressTitle: { color: ink, fontSize: 13, fontWeight: "900" }, addressBody: { color: "#685B74", fontSize: 10, marginTop: 3 }, addressMeta: { color: "#2B8252", fontSize: 8, marginTop: 4, fontWeight: "700" }, checkTextPurple: { color: purple, fontSize: 19, fontWeight: "900" }, contactCard: { backgroundColor: "white", borderWidth: 1, borderColor: "#E7DFEB", borderRadius: 16, padding: 14, marginTop: 14 }, contactLabel: { color: "#8A7D92", fontSize: 8, textTransform: "uppercase", letterSpacing: .5, marginTop: 10 }, contactValue: { color: ink, fontSize: 12, fontWeight: "800", marginTop: 3 },
  reviewCard: { backgroundColor: "white", borderWidth: 1, borderColor: "#E6DEEA", borderRadius: 17, padding: 15, marginTop: 15 }, reviewRow: { flexDirection: "row", justifyContent: "space-between", gap: 20, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#F0EAF2" }, reviewLabel: { color: "#7D7087", fontSize: 10 }, reviewValue: { color: ink, flex: 1, textAlign: "right", fontSize: 10, fontWeight: "800" }, reviewTotal: { flexDirection: "row", justifyContent: "space-between", paddingTop: 15 }, reviewTotalLabel: { color: ink, fontSize: 13, fontWeight: "900" }, reviewTotalValue: { color: purple, fontSize: 22, fontWeight: "900" }, otpCard: { backgroundColor: "#FFF1D8", borderRadius: 14, padding: 14, marginTop: 12 }, otpTitle: { color: "#714800", fontSize: 11, fontWeight: "900" }, otpBody: { color: "#7E6235", fontSize: 9, lineHeight: 14, marginTop: 4 }, securityCard: { flexDirection: "row", gap: 9, padding: 13, marginTop: 9 }, securityIcon: { color: "#27734B", fontSize: 20 }, securityText: { flex: 1, color: "#5B6D62", fontSize: 9, lineHeight: 14 }, flowFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "white", borderWidth: 1, borderColor: "#E3DAE8", borderRadius: 17, padding: 13, marginTop: 22, shadowColor: "#271039", shadowOpacity: .08, shadowRadius: 14 }, flowTotalLabel: { color: "#8C7E94", fontSize: 7, letterSpacing: 1, fontWeight: "900" }, flowTotal: { color: ink, fontSize: 20, fontWeight: "900", marginTop: 2 }, continueButton: { backgroundColor: orange, borderRadius: 11, paddingHorizontal: 20, paddingVertical: 13 }, continueText: { color: "#2B1444", fontSize: 11, fontWeight: "900" },
});
