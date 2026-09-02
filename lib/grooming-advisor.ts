/**
 * Deterministic grooming package advisor for the Haptik advisory flow.
 *
 * Scope is intentionally limited to the six standard LOE package outcomes:
 *   - dog: Essential Bath, Bath & Basic, Complete Makeover
 *   - cat: Routine Grooming, Bath & Basic, Complete Makeover
 *
 * "Just Trim" and young-pet promotional prices remain separate catalogue offers and are not
 * introduced as seventh/eighth advisory outcomes here.
 */

export type GroomingAdvisorPetType = "dog" | "cat";
export type GroomingBreedSize = "small" | "medium" | "large" | "giant";
export type GroomingCoatCondition = "short" | "matted" | "double";
export type GroomingAgeRequirement = "young" | "adult" | "senior";
export type GroomingBehaviorRequirement = "standard" | "anxious" | "reactive" | "handling_sensitive";
export type GroomingPackageTier = "essential" | "basic" | "complete";

export type GroomingAdvisorInput = {
  petType: GroomingAdvisorPetType;
  breedSize: GroomingBreedSize;
  coatCondition: GroomingCoatCondition;
  ageRequirement: GroomingAgeRequirement;
  behaviorRequirement?: GroomingBehaviorRequirement;
  requestedTier?: GroomingPackageTier;
};

export type StandardGroomingPackage = {
  petType: GroomingAdvisorPetType;
  tier: GroomingPackageTier;
  packageCode: string;
  packageName: string;
};

export const STANDARD_GROOMING_PACKAGES = [
  { petType: "dog", tier: "essential", packageCode: "dog-bath", packageName: "Essential Bath" },
  { petType: "dog", tier: "basic", packageCode: "dog-basic", packageName: "Bath & Basic" },
  { petType: "dog", tier: "complete", packageCode: "dog-makeover", packageName: "Complete Makeover" },
  { petType: "cat", tier: "essential", packageCode: "cat-routine", packageName: "Routine Grooming" },
  { petType: "cat", tier: "basic", packageCode: "cat-basic", packageName: "Bath & Basic" },
  { petType: "cat", tier: "complete", packageCode: "cat-makeover", packageName: "Complete Makeover" },
] as const satisfies readonly StandardGroomingPackage[];

type RuleCondition = {
  breedSize?: readonly GroomingBreedSize[];
  coatCondition?: readonly GroomingCoatCondition[];
  ageRequirement?: readonly GroomingAgeRequirement[];
  behaviorRequirement?: readonly GroomingBehaviorRequirement[];
};

export type GroomingAdvisorRule = {
  id: string;
  priority: number;
  when: RuleCondition;
  minimumTier: GroomingPackageTier;
  reason: string;
  requiresHumanReview?: boolean;
};

/**
 * Rules are data rather than an opaque if-chain so the bot integration can inspect and version the
 * decision policy. Higher-priority matching rules are reported first, while tier escalation is always
 * monotonic: a rule can raise the package tier but never silently downgrade a stronger requirement.
 */
export const GROOMING_ADVISOR_RULES = [
  {
    id: "matted-coat-complete",
    priority: 100,
    when: { coatCondition: ["matted"] },
    minimumTier: "complete",
    reason: "A matted coat requires the Complete Makeover tier.",
  },
  {
    id: "reactive-handling-complete",
    priority: 95,
    when: { behaviorRequirement: ["reactive"] },
    minimumTier: "complete",
    reason: "Reactive handling needs the most complete grooming slot and human review before confirmation.",
    requiresHumanReview: true,
  },
  {
    id: "large-double-coat-complete",
    priority: 90,
    when: { breedSize: ["large", "giant"], coatCondition: ["double"] },
    minimumTier: "complete",
    reason: "Large or giant double-coated pets are routed to Complete Makeover for the heavier coat workload.",
  },
  {
    id: "double-coat-basic",
    priority: 70,
    when: { coatCondition: ["double"] },
    minimumTier: "basic",
    reason: "Double-coated pets require at least Bath & Basic care.",
  },
  {
    id: "giant-size-basic",
    priority: 60,
    when: { breedSize: ["giant"] },
    minimumTier: "basic",
    reason: "Giant breeds require at least the Basic tier for the additional handling and coat area.",
  },
  {
    id: "senior-support-basic",
    priority: 55,
    when: { ageRequirement: ["senior"] },
    minimumTier: "basic",
    reason: "Senior pets are routed to at least the Basic tier so the booking carries an extended handling requirement.",
  },
  {
    id: "handling-support-basic",
    priority: 50,
    when: { behaviorRequirement: ["anxious", "handling_sensitive"] },
    minimumTier: "basic",
    reason: "Anxious or handling-sensitive pets require at least the Basic tier and an explicit handling note.",
  },
] as const satisfies readonly GroomingAdvisorRule[];

const TIER_RANK: Record<GroomingPackageTier, number> = { essential: 0, basic: 1, complete: 2 };

function atLeast(current: GroomingPackageTier, candidate: GroomingPackageTier): GroomingPackageTier {
  return TIER_RANK[candidate] > TIER_RANK[current] ? candidate : current;
}

function ruleMatches(rule: GroomingAdvisorRule, input: Required<Omit<GroomingAdvisorInput, "requestedTier">> & { requestedTier?: GroomingPackageTier }): boolean {
  const { when } = rule;
  return (!when.breedSize || when.breedSize.includes(input.breedSize))
    && (!when.coatCondition || when.coatCondition.includes(input.coatCondition))
    && (!when.ageRequirement || when.ageRequirement.includes(input.ageRequirement))
    && (!when.behaviorRequirement || when.behaviorRequirement.includes(input.behaviorRequirement));
}

function packageFor(petType: GroomingAdvisorPetType, tier: GroomingPackageTier): StandardGroomingPackage {
  const match = STANDARD_GROOMING_PACKAGES.find(pkg => pkg.petType === petType && pkg.tier === tier);
  if (!match) throw new Error(`No standard grooming package mapped for ${petType}:${tier}`);
  return match;
}

export type GroomingAdvisorRecommendation = {
  petType: GroomingAdvisorPetType;
  packageCode: string;
  packageName: string;
  tier: GroomingPackageTier;
  matchedRuleIds: string[];
  reasons: string[];
  requiresHumanReview: boolean;
  advisories: string[];
};

export function recommendGroomingPackage(input: GroomingAdvisorInput): GroomingAdvisorRecommendation {
  const normalized = {
    ...input,
    behaviorRequirement: input.behaviorRequirement ?? "standard",
  } as Required<Omit<GroomingAdvisorInput, "requestedTier">> & { requestedTier?: GroomingPackageTier };

  let tier: GroomingPackageTier = "essential";
  const matched = [...GROOMING_ADVISOR_RULES]
    .filter(rule => ruleMatches(rule, normalized))
    .sort((a, b) => b.priority - a.priority);

  for (const rule of matched) tier = atLeast(tier, rule.minimumTier);
  if (normalized.requestedTier) tier = atLeast(tier, normalized.requestedTier);

  const pkg = packageFor(normalized.petType, tier);
  const advisories: string[] = [];
  if (normalized.ageRequirement === "young") advisories.push("young_pet: confirm age-appropriate handling and any current young-pet offer before checkout");
  if (normalized.ageRequirement === "senior") advisories.push("senior_pet: capture any mobility or handling constraints before the slot is confirmed");
  if (normalized.behaviorRequirement !== "standard") advisories.push(`behavior:${normalized.behaviorRequirement}`);
  if (normalized.coatCondition === "matted") advisories.push("coat:matted");

  const reasons: string[] = matched.map(rule => rule.reason);
  if (normalized.requestedTier && TIER_RANK[normalized.requestedTier] >= TIER_RANK[tier]) {
    reasons.push(`The requested ${normalized.requestedTier} package tier was retained.`);
  }
  if (!reasons.length) reasons.push("Short coat with standard handling maps to the entry standard package for this pet type.");

  return {
    petType: normalized.petType,
    packageCode: pkg.packageCode,
    packageName: pkg.packageName,
    tier,
    matchedRuleIds: matched.map(rule => rule.id),
    reasons,
    requiresHumanReview: matched.some(rule => "requiresHumanReview" in rule && Boolean(rule.requiresHumanReview)),
    advisories,
  };
}

const PET_TYPES = new Set<GroomingAdvisorPetType>(["dog", "cat"]);
const BREED_SIZES = new Set<GroomingBreedSize>(["small", "medium", "large", "giant"]);
const COAT_CONDITIONS = new Set<GroomingCoatCondition>(["short", "matted", "double"]);
const AGE_REQUIREMENTS = new Set<GroomingAgeRequirement>(["young", "adult", "senior"]);
const BEHAVIOR_REQUIREMENTS = new Set<GroomingBehaviorRequirement>(["standard", "anxious", "reactive", "handling_sensitive"]);
const PACKAGE_TIERS = new Set<GroomingPackageTier>(["essential", "basic", "complete"]);

/** Convert an untyped Haptik payload into the governed advisor input or fail clearly. */
export function groomingAdvisorInputFromHaptik(payload: Record<string, unknown>): GroomingAdvisorInput {
  const petType = String(payload.petType ?? payload.pet_type ?? "").trim() as GroomingAdvisorPetType;
  const breedSize = String(payload.breedSize ?? payload.breed_size ?? "").trim() as GroomingBreedSize;
  const coatCondition = String(payload.coatCondition ?? payload.coat_condition ?? "").trim() as GroomingCoatCondition;
  const ageRequirement = String(payload.ageRequirement ?? payload.age_requirement ?? "").trim() as GroomingAgeRequirement;
  const behaviorRaw = String(payload.behaviorRequirement ?? payload.behavior_requirement ?? "standard").trim() as GroomingBehaviorRequirement;
  const requestedRaw = String(payload.requestedTier ?? payload.requested_tier ?? "").trim() as GroomingPackageTier;

  if (!PET_TYPES.has(petType)) throw new Error("Grooming advisor requires petType: dog | cat");
  if (!BREED_SIZES.has(breedSize)) throw new Error("Grooming advisor requires breedSize: small | medium | large | giant");
  if (!COAT_CONDITIONS.has(coatCondition)) throw new Error("Grooming advisor requires coatCondition: short | matted | double");
  if (!AGE_REQUIREMENTS.has(ageRequirement)) throw new Error("Grooming advisor requires ageRequirement: young | adult | senior");
  if (!BEHAVIOR_REQUIREMENTS.has(behaviorRaw)) throw new Error("Unsupported grooming behavior requirement");
  if (requestedRaw && !PACKAGE_TIERS.has(requestedRaw)) throw new Error("Unsupported requested grooming package tier");

  return {
    petType,
    breedSize,
    coatCondition,
    ageRequirement,
    behaviorRequirement: behaviorRaw,
    requestedTier: requestedRaw || undefined,
  };
}

/** Compact JSON-safe response shape for Haptik's advisory action. */
export function groomingAdvisoryForHaptik(payload: Record<string, unknown>) {
  const recommendation = recommendGroomingPackage(groomingAdvisorInputFromHaptik(payload));
  return {
    action: "grooming_package_advice" as const,
    package_code: recommendation.packageCode,
    package_name: recommendation.packageName,
    package_tier: recommendation.tier,
    requires_human_review: recommendation.requiresHumanReview,
    matched_rule_ids: recommendation.matchedRuleIds,
    reasons: recommendation.reasons,
    advisories: recommendation.advisories,
  };
}
