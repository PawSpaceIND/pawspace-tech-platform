// Demo/UAT host & sitter profile cards - a self-contained, standalone feature keyed off the
// existing seeded provider ids in lib/provider-capacity-governance.ts (host_sana, host_maya_rohan,
// host_arjun_tara, sit_sana, sit_neha, sit_asha, plus groomers/trainers). Deliberately separate
// from lib/provider-public-profile.ts: that file surfaces only real, organically-earned data for
// providers who completed real onboarding, and explicitly withholds rating/reviews because nothing
// in this codebase ever earns them organically for seeded/demo providers. This module is the
// opposite case on purpose - a rich, honestly-labelled demo profile for the seeded hosts/sitters
// customers see before booking, so no real-media upload flow needs to exist yet. photoRef /
// housePhotoRefs are media-by-reference placeholder strings, never real uploaded files.

type Db = D1Database;
type Row = Record<string, unknown>;

export type HostProfileRole = "Host" | "Sitter";

export type HostProfileReview = { author: string; city: string; stars: number; text: string };

export type HostProfileStats = { happyPets: number; onTimePct: number; happyParents: number; yearsExp: number };

export type HostProfileVerification = { kyc: boolean; backgroundCheck: boolean; homeVerified: boolean };

export type HostProfile = {
  providerId: string;
  displayName: string;
  role: HostProfileRole;
  photoRef: string;
  housePhotoRefs: string[];
  verified: HostProfileVerification;
  rating: number;
  locationLabel: string;
  yearsExperience: number;
  about: string;
  specializations: string[];
  servicesOffered: string[];
  reviews: HostProfileReview[];
  stats: HostProfileStats;
};

// Per-isolate memoization, same pattern as lib/server-auth.ts ensureSecurityTables: the DDL is
// idempotent, so cache the "already ensured" fact per D1 binding rather than re-issuing it on
// every profile read/write for the life of the isolate.
const hostProfileTablesEnsured = new WeakSet<Db>();

export async function ensureHostProfileTables(db: Db) {
  if (hostProfileTablesEnsured.has(db)) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS host_profiles (provider_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,role TEXT NOT NULL,photo_ref TEXT NOT NULL,house_photo_refs_json TEXT NOT NULL,kyc_verified INTEGER NOT NULL DEFAULT 0,background_check_verified INTEGER NOT NULL DEFAULT 0,home_verified INTEGER NOT NULL DEFAULT 0,rating REAL NOT NULL DEFAULT 0,location_label TEXT NOT NULL,years_experience INTEGER NOT NULL DEFAULT 0,about TEXT NOT NULL DEFAULT '',specializations_json TEXT NOT NULL,services_offered_json TEXT NOT NULL,reviews_json TEXT NOT NULL,stats_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"
    ),
  ]);
  hostProfileTablesEnsured.add(db);
}

function rowToProfile(row: Row): HostProfile {
  return {
    providerId: String(row.provider_id),
    displayName: String(row.display_name),
    role: String(row.role) === "Sitter" ? "Sitter" : "Host",
    photoRef: String(row.photo_ref),
    housePhotoRefs: JSON.parse(String(row.house_photo_refs_json)) as string[],
    verified: {
      kyc: Number(row.kyc_verified) === 1,
      backgroundCheck: Number(row.background_check_verified) === 1,
      homeVerified: Number(row.home_verified) === 1,
    },
    rating: Number(row.rating),
    locationLabel: String(row.location_label),
    yearsExperience: Number(row.years_experience),
    about: String(row.about),
    specializations: JSON.parse(String(row.specializations_json)) as string[],
    servicesOffered: JSON.parse(String(row.services_offered_json)) as string[],
    reviews: JSON.parse(String(row.reviews_json)) as HostProfileReview[],
    stats: JSON.parse(String(row.stats_json)) as HostProfileStats,
  };
}

export async function upsertHostProfile(db: Db, input: HostProfile): Promise<HostProfile> {
  await ensureHostProfileTables(db);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO host_profiles (provider_id,display_name,role,photo_ref,house_photo_refs_json,kyc_verified,background_check_verified,home_verified,rating,location_label,years_experience,about,specializations_json,services_offered_json,reviews_json,stats_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         display_name=excluded.display_name,role=excluded.role,photo_ref=excluded.photo_ref,house_photo_refs_json=excluded.house_photo_refs_json,
         kyc_verified=excluded.kyc_verified,background_check_verified=excluded.background_check_verified,home_verified=excluded.home_verified,
         rating=excluded.rating,location_label=excluded.location_label,years_experience=excluded.years_experience,about=excluded.about,
         specializations_json=excluded.specializations_json,services_offered_json=excluded.services_offered_json,
         reviews_json=excluded.reviews_json,stats_json=excluded.stats_json,updated_at=excluded.updated_at`
    )
    .bind(
      input.providerId,
      input.displayName,
      input.role,
      input.photoRef,
      JSON.stringify(input.housePhotoRefs),
      input.verified.kyc ? 1 : 0,
      input.verified.backgroundCheck ? 1 : 0,
      input.verified.homeVerified ? 1 : 0,
      input.rating,
      input.locationLabel,
      input.yearsExperience,
      input.about,
      JSON.stringify(input.specializations),
      JSON.stringify(input.servicesOffered),
      JSON.stringify(input.reviews),
      JSON.stringify(input.stats),
      now,
      now
    )
    .run();
  const saved = await getHostProfile(db, input.providerId);
  if (!saved) throw new Error("Host profile failed to persist");
  return saved;
}

export async function getHostProfile(db: Db, providerId: string): Promise<HostProfile | null> {
  await ensureHostProfileTables(db);
  const row = await db.prepare("SELECT * FROM host_profiles WHERE provider_id=?").bind(providerId).first<Row>();
  return row ? rowToProfile(row) : null;
}

// Realistic demo content for the seeded hosts/sitters in lib/provider-capacity-governance.ts.
// Sana F. appears as both host_sana (boarding) and sit_sana (pet sitting) - same real seed person,
// so her bio/photo/verification are consistent across both listings.
const DEMO_PROFILES: HostProfile[] = [
  {
    providerId: "host_maya_rohan",
    displayName: "Maya & Rohan",
    role: "Host",
    photoRef: "avatar:host_maya_rohan",
    housePhotoRefs: ["house:host_maya_rohan:living-room", "house:host_maya_rohan:garden", "house:host_maya_rohan:sleep-area"],
    verified: { kyc: true, backgroundCheck: true, homeVerified: true },
    rating: 4.9,
    locationLabel: "Indiranagar, Bengaluru",
    yearsExperience: 6,
    about: "We're a couple who've boarded dogs in our home for six years - always at most 2 guests at a time, so your pet gets a real family, not a kennel. Our garden is fully fenced and our own two dogs help new guests settle in fast.",
    specializations: ["Senior dogs", "Large breeds", "Multi-pet households"],
    servicesOffered: ["Boarding"],
    reviews: [
      { author: "Priya K.", city: "Bengaluru", stars: 5, text: "Our senior labrador Bruno came back happier than we've seen him in months. Maya sent photos every single day." },
      { author: "Ashwin R.", city: "Bengaluru", stars: 5, text: "Rohan clearly loves dogs - he noticed our pup's limp before we did and told us to get it checked." },
      { author: "Deepika S.", city: "Bengaluru", stars: 4, text: "Lovely home, very clean. Only wish drop-off timing was a bit more flexible." },
    ],
    stats: { happyPets: 148, onTimePct: 98, happyParents: 132, yearsExp: 6 },
  },
  {
    providerId: "host_sana",
    displayName: "Sana F.",
    role: "Host",
    photoRef: "avatar:sana_f",
    housePhotoRefs: ["house:sana_f:balcony", "house:sana_f:play-area"],
    verified: { kyc: true, backgroundCheck: true, homeVerified: true },
    rating: 4.8,
    locationLabel: "HSR Layout, Bengaluru",
    yearsExperience: 4,
    about: "Independent pet parent of two rescues, hosting boarding guests from my HSR Layout home for four years. I keep a strict small-group policy so every dog gets one-on-one attention and a proper routine.",
    specializations: ["Rescue dogs", "Anxious/first-time boarders", "Medication administration"],
    servicesOffered: ["Boarding", "Pet Sitting"],
    reviews: [
      { author: "Karthik M.", city: "Bengaluru", stars: 5, text: "Our rescue is nervous around new people but Sana had her comfortable within a day. Genuinely gifted with anxious dogs." },
      { author: "Neha V.", city: "Bengaluru", stars: 5, text: "Handled our cat's twice-daily medication perfectly and sent reminders when we were travelling." },
    ],
    stats: { happyPets: 96, onTimePct: 99, happyParents: 84, yearsExp: 4 },
  },
  {
    providerId: "host_arjun_tara",
    displayName: "Arjun & Tara",
    role: "Host",
    photoRef: "avatar:host_arjun_tara",
    housePhotoRefs: ["house:host_arjun_tara:terrace", "house:host_arjun_tara:dog-corner"],
    verified: { kyc: true, backgroundCheck: true, homeVerified: false },
    rating: 4.7,
    locationLabel: "Whitefield, Bengaluru",
    yearsExperience: 3,
    about: "We're newer to boarding but grew up around dogs our whole lives - three years of hosting guests in our Whitefield home with a big terrace for supervised outdoor time every day.",
    specializations: ["Puppies", "Active/high-energy breeds"],
    servicesOffered: ["Boarding"],
    reviews: [
      { author: "Sneha P.", city: "Bengaluru", stars: 5, text: "Our hyperactive Beagle finally got the exercise he needed. Arjun sent videos of playtime every evening." },
      { author: "Rohit A.", city: "Bengaluru", stars: 4, text: "Great with our puppy, very patient during a rough teething week." },
    ],
    stats: { happyPets: 41, onTimePct: 97, happyParents: 38, yearsExp: 3 },
  },
  {
    providerId: "sit_sana",
    displayName: "Sana F.",
    role: "Sitter",
    photoRef: "avatar:sana_f",
    housePhotoRefs: ["house:sana_f:balcony", "house:sana_f:play-area"],
    verified: { kyc: true, backgroundCheck: true, homeVerified: true },
    rating: 4.9,
    locationLabel: "HSR Layout, Bengaluru",
    yearsExperience: 4,
    about: "I offer in-your-home pet sitting across HSR Layout and nearby zones - your pet stays in their own familiar space while you're away, with visit photos and notes every time.",
    specializations: ["In-home visits", "Cats", "Elderly pet care"],
    servicesOffered: ["Pet Sitting"],
    reviews: [
      { author: "Ritu D.", city: "Bengaluru", stars: 5, text: "Our elderly cat needs a calm routine and Sana followed it exactly, down to the medicine timing." },
      { author: "Vivek S.", city: "Bengaluru", stars: 5, text: "She noticed our dog wasn't eating well one day and messaged us immediately - that kind of attentiveness matters." },
      { author: "Anjali T.", city: "Bengaluru", stars: 5, text: "Reliable, always on time, sends photos unprompted every visit." },
    ],
    stats: { happyPets: 112, onTimePct: 99, happyParents: 97, yearsExp: 4 },
  },
  {
    providerId: "sit_neha",
    displayName: "Neha P.",
    role: "Sitter",
    photoRef: "avatar:neha_p",
    housePhotoRefs: [],
    verified: { kyc: true, backgroundCheck: true, homeVerified: false },
    rating: 4.8,
    locationLabel: "Koramangala, Bengaluru",
    yearsExperience: 5,
    about: "Five years of in-home pet sitting across Koramangala and Indiranagar. I specialise in multi-visit daily schedules for working pet parents - feeding, walks, and playtime, logged every visit.",
    specializations: ["Multi-visit scheduling", "Small dogs", "Puppy potty training"],
    servicesOffered: ["Pet Sitting"],
    reviews: [
      { author: "Farah K.", city: "Bengaluru", stars: 5, text: "Neha's daily visit logs are so detailed, we never worry while travelling for work." },
      { author: "Manoj B.", city: "Bengaluru", stars: 4, text: "Great with our puppy's potty training routine, stuck to our schedule exactly." },
    ],
    stats: { happyPets: 87, onTimePct: 98, happyParents: 79, yearsExp: 5 },
  },
  {
    providerId: "sit_asha",
    displayName: "Asha R.",
    role: "Sitter",
    photoRef: "avatar:asha_r",
    housePhotoRefs: [],
    verified: { kyc: true, backgroundCheck: false, homeVerified: false },
    rating: 4.7,
    locationLabel: "Marathahalli, Bengaluru",
    yearsExperience: 2,
    about: "I've been in-home pet sitting for two years around Marathahalli, mostly for dogs and rabbits. I keep visits calm and unhurried so nervous pets settle quickly even without their owners around.",
    specializations: ["Rabbits & small pets", "Nervous pets"],
    servicesOffered: ["Pet Sitting"],
    reviews: [
      { author: "Divya N.", city: "Bengaluru", stars: 5, text: "Our rabbit is skittish with strangers but was completely calm with Asha by the second visit." },
      { author: "Suresh L.", city: "Bengaluru", stars: 4, text: "Good communication, punctual visits, would book again." },
    ],
    stats: { happyPets: 22, onTimePct: 96, happyParents: 20, yearsExp: 2 },
  },
];

const demoHostProfilesSeeded = new WeakSet<Db>();

export async function seedDemoHostProfiles(db: Db) {
  await ensureHostProfileTables(db);
  if (demoHostProfilesSeeded.has(db)) return;
  for (const profile of DEMO_PROFILES) await upsertHostProfile(db, profile);
  demoHostProfilesSeeded.add(db);
}
