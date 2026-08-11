// Real, customer-safe provider profile assembly. Surfaces only genuinely real data - nothing here
// is invented to make a provider look more established than they are.
//
// Deliberately excludes two fields that exist in the schema but are never organically real:
//   - rating/qualityScore on provider_capacity_profiles: every real newly-activated provider is
//     inserted with rating=0, quality_score=0 (confirmed in activateProviderUat) and nothing
//     anywhere in this codebase ever updates them from real customer feedback. The only nonzero
//     values that exist are hardcoded seed data for demo/UAT providers. Showing this to a customer
//     as if it were an earned star rating would be the same category of problem as a fabricated
//     review - so it's left out entirely until a real review system exists.
//   - Any customer testimonial: no real per-provider review/feedback table exists yet.
//
// What IS shown, and why it's safe to:
//   - display_name / bio / business_name / services from provider_onboarding_profiles, only for
//     providers who completed real onboarding (falls back to just the bare capacity-profile name
//     for seeded/demo providers who never went through onboarding at all).
//   - A profile photo, only if a provider_onboarding_profile_media row has
//     media_type='provider_photo' (the one non-sensitive classification - home/facility photos are
//     classified sensitive_location and are never included here) AND publish_approved=1.
//   - A "PawSpace verified" badge, only if a real provider_onboarding_activation_runs row exists
//     with result='activated_uat' or better - not an always-on badge.
//   - Real completed-service and distinct-pet counts, computed live from canonical_bookings - and
//     only returned once they cross a real minimum threshold, so a brand-new provider shows a
//     "New to PawSpace" state instead of an awkward zero.

type Db = D1Database;
type Row = Record<string, unknown>;

const MIN_STATS_THRESHOLD = 3;

export type ProviderPublicProfile = {
  providerId: string;
  displayName: string;
  bio: string | null;
  businessName: string | null;
  services: string[];
  photoUrl: string | null;
  verified: boolean;
  memberSince: string | null;
  stats: { completedServices: number; happyPets: number } | null;
  isNewProvider: boolean;
};

export async function getProviderPublicProfile(db: Db, providerId: string): Promise<ProviderPublicProfile | null> {
  const capacity = await db.prepare("SELECT id,name FROM provider_capacity_profiles WHERE id=?").bind(providerId).first<Row>();
  if (!capacity) return null;

  const onboarding = await db.prepare(
    "SELECT display_name,bio,business_name,services_json FROM provider_onboarding_profiles WHERE provider_id=?"
  ).bind(providerId).first<Row>();

  const activation = await db.prepare(
    "SELECT created_at,result FROM provider_onboarding_activation_runs WHERE provider_id=? ORDER BY created_at ASC LIMIT 1"
  ).bind(providerId).first<Row>();

  let photoUrl: string | null = null;
  if (onboarding) {
    const applicationRow = await db.prepare("SELECT application_id FROM provider_onboarding_profiles WHERE provider_id=?").bind(providerId).first<Row>();
    if (applicationRow) {
      const media = await db.prepare(
        "SELECT file_ref FROM provider_onboarding_profile_media WHERE application_id=? AND media_type='provider_photo' AND publish_approved=1 ORDER BY updated_at DESC LIMIT 1"
      ).bind(String(applicationRow.application_id)).first<Row>();
      if (media) photoUrl = String(media.file_ref);
    }
  }

  const completedBookings = await db.prepare(
    "SELECT pet_ids_json FROM canonical_bookings WHERE provider_id=? AND status='completed'"
  ).bind(providerId).all<Row>();
  const completedServices = completedBookings.results.length;
  const distinctPetIds = new Set<string>();
  for (const row of completedBookings.results) {
    try {
      const ids = JSON.parse(String(row.pet_ids_json)) as unknown[];
      for (const petId of ids) distinctPetIds.add(String(petId));
    } catch { /* malformed row, skip */ }
  }
  const happyPets = distinctPetIds.size;
  const hasEnoughVolume = completedServices >= MIN_STATS_THRESHOLD;

  return {
    providerId,
    displayName: onboarding ? String(onboarding.display_name) : String(capacity.name),
    bio: onboarding?.bio ? String(onboarding.bio) : null,
    businessName: onboarding?.business_name ? String(onboarding.business_name) : null,
    services: onboarding?.services_json ? JSON.parse(String(onboarding.services_json)) : [],
    photoUrl,
    verified: Boolean(activation && ["activated_uat", "activated_live"].includes(String(activation.result))),
    memberSince: activation ? new Date(Number(activation.created_at)).toISOString().slice(0, 7) : null,
    stats: hasEnoughVolume ? { completedServices, happyPets } : null,
    isNewProvider: !hasEnoughVolume,
  };
}
