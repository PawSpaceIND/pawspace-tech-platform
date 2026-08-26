/**
 * Which verification a provider must clear before they may take work, by service and by city.
 * [PTJA-W1-F53]
 *
 * WHAT WAS MEASURED. Two of the six canonical services - dog_walking and pet_taxi - had no verification
 * category at all. verificationCategoryForVertical returned null for both, and the activation checklist
 * answered that null by pushing `check("category_verification_mandate", true)`: an unmapped vertical
 * produced a PASSING check. A dog walker was activated end to end with zero verification rows - the
 * provider_verifications table was never even created for that journey - and zero onboarding documents.
 * Nor was it a state an operator could close: setCategoryMandate refused any category outside a
 * hardcoded four, so there was no way to require Aadhaar of a dog walker or of a pet-taxi driver who
 * takes sole physical custody of an animal and drives it away.
 *
 * That is this audit's most common defect in its purest form: unknown or absent treated as satisfied.
 *
 * THE APPROVED REQUIREMENTS, seeded below per vertical:
 *
 *                                        Dog Walking     Pet Taxi
 *   Government photo ID                  mandatory       mandatory
 *   Address verification                 mandatory       mandatory
 *   Police verification                  mandatory       mandatory
 *   Selfie / liveness + identity match   mandatory       mandatory
 *   References / background screening    mandatory       recommended
 *   Driving licence                      -               mandatory
 *   Vehicle registration                 -               mandatory
 *   Vehicle insurance                    -               mandatory
 *   Pollution / fitness documents        -               mandatory where applicable
 *   Bank / KYC                           payout          payout
 *   Pet-handling induction               mandatory       mandatory
 *   Emergency / safety training          mandatory       mandatory
 *
 * "Government photo ID" maps to the platform's existing `aadhaar` check rather than to a new duplicate
 * type: that is already the government-identity verification IDfy runs, and adding a second name for the
 * same evidence would mean two records of one fact.
 *
 * FAIL-CLOSED FOR ANYTHING NOT LISTED. The platform default at (*, *) carries `configured:false`, and an
 * unconfigured vertical BLOCKS activation with a message naming it. A seventh service added tomorrow
 * cannot activate providers on silence; somebody has to decide what it requires. That is the finding's
 * own expected outcome: "An unrecognised vertical must not produce a PASSING check."
 *
 * PER CITY, because the standing instruction is that these decisions change by market. A city that
 * demands more of a taxi driver writes a (pet_taxi, <city>) row in Control Center; nothing is deployed.
 */
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;

export const PROVIDER_VERIFICATION_DOMAIN="provider_verification_policy";

export type ProviderVerificationPolicyConfig={
  /** False in the platform default. An unconfigured vertical blocks activation rather than passing it. */
  configured:boolean;
  /** Every one of these must be `verified` before the provider may take assignments. */
  requiredTypes:string[];
  /** Tracked and surfaced, but not blocking. */
  recommendedTypes:string[];
  /** Must be verified before money can be paid out, separately from taking work. */
  payoutBlockingTypes:string[];
  /** An expired or rejected mandatory document stops NEW assignments. */
  blockAssignmentOnExpiredOrRejected:boolean;
  /** In-progress work is never deleted by a block; Operations reassigns it. */
  preserveInProgressWorkOnBlock:boolean;
  /** The provider category these requirements belong to, for the existing mandate records. */
  category:string|null;
};

const STRICT_DEFAULT:ProviderVerificationPolicyConfig={
  configured:false,
  requiredTypes:[],
  recommendedTypes:[],
  payoutBlockingTypes:[],
  blockAssignmentOnExpiredOrRejected:true,
  preserveInProgressWorkOnBlock:true,
  category:null,
};

/** Government photo ID is the platform's existing `aadhaar` check - one record for one fact. */
export const GOVERNMENT_PHOTO_ID="aadhaar";
const CORE_CUSTODY_CHECKS=[GOVERNMENT_PHOTO_ID,"address","police_verification","selfie_liveness","pet_handling_induction","emergency_safety_training"];

export const APPROVED_VERIFICATION_BY_VERTICAL:Record<string,ProviderVerificationPolicyConfig>={
  dog_walking:{
    configured:true,
    requiredTypes:[...CORE_CUSTODY_CHECKS,"references_background"],
    recommendedTypes:[],
    payoutBlockingTypes:["bank_kyc"],
    blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"dog_walker",
  },
  pet_taxi:{
    configured:true,
    // A pet-taxi driver takes sole custody AND drives. Vehicle documents are mandatory alongside the
    // custody checks; references are recommended rather than blocking, per the approved table.
    requiredTypes:[...CORE_CUSTODY_CHECKS,"driving_licence","vehicle_registration","vehicle_insurance","vehicle_fitness_pollution"],
    recommendedTypes:["references_background"],
    payoutBlockingTypes:["bank_kyc"],
    blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"pet_taxi_driver",
  },
  // The four already-configured verticals, carried across from the mandate defaults so that moving the
  // authority here changes no behaviour for them.
  grooming:{configured:true,requiredTypes:["aadhaar","pan"],recommendedTypes:[],payoutBlockingTypes:["bank_kyc"],blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"groomer"},
  pet_sitting:{configured:true,requiredTypes:["aadhaar","pan","address"],recommendedTypes:[],payoutBlockingTypes:["bank_kyc"],blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"pet_sitter"},
  dog_training:{configured:true,requiredTypes:["aadhaar","pan","police_verification"],recommendedTypes:[],payoutBlockingTypes:["bank_kyc"],blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"trainer"},
  boarding:{configured:true,requiredTypes:["aadhaar","pan","house_verification","pet_proofing_photo"],recommendedTypes:[],payoutBlockingTypes:["bank_kyc"],blockAssignmentOnExpiredOrRejected:true,preserveInProgressWorkOnBlock:true,category:"host"},
};
/** The catalogue's own aliases for the same verticals. */
export const VERTICAL_ALIASES:Record<string,string>={sitting:"pet_sitting",training:"dog_training",walking:"dog_walking",taxi:"pet_taxi"};
export const canonicalVertical=(value:unknown)=>{const key=String(value??"").trim().toLowerCase();return VERTICAL_ALIASES[key]??key;};

registerServicePolicyDomain<ProviderVerificationPolicyConfig&Record<string,unknown>>({
  domain:PROVIDER_VERIFICATION_DOMAIN,
  label:"Provider verification requirements",
  managePermission:"settings.manage",
  defaults:STRICT_DEFAULT as ProviderVerificationPolicyConfig&Record<string,unknown>,
  problem(config){
    for(const key of ["requiredTypes","recommendedTypes","payoutBlockingTypes"]){
      if(!Array.isArray(config[key]))return `${key} must be a list of verification type codes`;
    }
    const required=(config.requiredTypes as string[]).map(String);
    if(config.configured===true&&!required.length)return "A configured vertical must require at least one verification";
    const overlap=required.filter(type=>(config.recommendedTypes as string[]).map(String).includes(type));
    // A check that is both blocking and advisory is a contradiction an operator would read either way.
    if(overlap.length)return `A verification cannot be both required and recommended: ${overlap.join(", ")}`;
    /*
     * NO FLOOR ON *WHICH* CHECKS. Two drafts of this validator invented one - first a police check for
     * every vertical, then a government-ID check - and both were mine rather than the business's. The
     * approved decision specifies matrices for Dog Walking and Pet Taxi; it does not say a groomer needs
     * a police check, and lib/provider-verification-mandate.ts carries a deliberate, tested contract
     * that an operator may NARROW a category's mandate and have that narrowing survive. A floor here
     * would silently overrule both.
     *
     * So this validator guards the SHAPE of a decision - that one was made, that it is not
     * self-contradictory, that blocking behaviour is not switched off - and leaves the content to the
     * people who own it. What the platform guarantees is that unknown is never treated as satisfied.
     */
    if(config.blockAssignmentOnExpiredOrRejected===false)return "An expired or rejected mandatory document must block new assignments";
    if(config.preserveInProgressWorkOnBlock===false)return "Blocking a provider must never delete work already in progress; Operations reassigns it";
    return null;
  },
});

export async function resolveProviderVerificationPolicy(db:Db,verticalKey:string,cityId?:string|null,at=new Date()){
  return resolveServicePolicy<ProviderVerificationPolicyConfig&Record<string,unknown>>(
    db,PROVIDER_VERIFICATION_DOMAIN,{serviceCode:canonicalVertical(verticalKey),cityId},at);
}

/**
 * Seeds the approved per-vertical requirements. INSERT OR IGNORE per scope, so an operator's own row is
 * never overwritten - the same rule seedDefaultMandates follows for the category table.
 */
const seeded=new WeakSet<Db>();
export async function seedApprovedVerificationPolicies(db:Db){
  if(seeded.has(db))return;
  const{seedServicePolicyDefault,writeServicePolicy,ensureServicePolicyTables}=await import("./service-policy-governance");
  await ensureServicePolicyTables(db);
  await seedServicePolicyDefault(db,PROVIDER_VERIFICATION_DOMAIN);
  seeded.add(db);
  for(const[vertical,config]of Object.entries(APPROVED_VERIFICATION_BY_VERTICAL)){
    const existing=await db.prepare("SELECT id FROM service_policy_configs WHERE policy_domain=? AND service_code=? AND city_id='*'").bind(PROVIDER_VERIFICATION_DOMAIN,vertical).first<Record<string,unknown>>();
    if(existing)continue;
    await writeServicePolicy(db,{domain:PROVIDER_VERIFICATION_DOMAIN,serviceCode:vertical,cityId:"*",config:config as unknown as Record<string,unknown>,
      notes:`Approved verification requirements for ${vertical}`},"founder_seed","Approved PawSpace provider verification requirements");
  }
}
