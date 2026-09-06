type Db=D1Database;
type Row=Record<string,unknown>;
const rows=<T=Row>(result:{results?:unknown[]})=>(result.results||[]) as T[];

export type Badge={id:string;name:string;description:string;icon:string;earnedAt:number|null};

export type HostStats={completedStays:number;repeatCustomers:number;yearsHosting:number;avgRating:number;totalReviews:number;acceptanceTimeout:number;medicationSupport:boolean;homeVerified:boolean;kycVerified:boolean;hostCancelledCount:number};

async function safeAll(db:Db,sql:string,bindings:unknown[]=[]){
  try{
    let statement=db.prepare(sql);
    if(bindings.length)statement=statement.bind(...bindings);
    return rows(await statement.all<Row>());
  }catch{
    return[] as Row[];
  }
}

async function safeFirst(db:Db,sql:string,bindings:unknown[]=[]){
  try{
    let statement=db.prepare(sql);
    if(bindings.length)statement=statement.bind(...bindings);
    return await statement.first<Row>();
  }catch{
    return null;
  }
}


/**
 * What the platform can actually evidence about a host provider, as opposed to what its profile row
 * claims. Keyed through the provider's onboarding application, because provider_verifications is
 * recorded per application. A provider with no application has no evidence - which is the honest answer
 * for the seeded demo hosts - and any failure to read is treated the same way: no evidence, no badge.
 */
async function hostVerificationEvidence(db:Db,hostProviderId:string){
  const none={mandateSatisfied:false,homeVerified:false};
  const application=await safeFirst(db,"SELECT id FROM provider_onboarding_applications WHERE provider_id=? ORDER BY updated_at DESC LIMIT 1",[hostProviderId]);
  const applicationId=String(application?.id||"");
  if(!applicationId)return none;
  try{
    const {verificationMandateStatus}=await import("./provider-verification-mandate");
    const status=await verificationMandateStatus(db,{applicationId,category:"host"});
    return{
      mandateSatisfied:Boolean(status.allVerified),
      homeVerified:status.checks.some(check=>check.verificationType==="house_verification"&&check.status==="verified"),
    };
  }catch{
    return none;
  }
}

export async function computeHostStats(db:Db,hostProviderId:string):Promise<HostStats>{
  // Completed stays: count from canonical_bookings where provider_id and status='completed'
  const staysResult=await safeFirst(db,"SELECT COUNT(*) as count FROM canonical_bookings WHERE provider_id=? AND status='completed' AND service_code IN ('boarding','pet_sitting')",[hostProviderId]);
  const completedStays=Number(staysResult?.count||0);

  // Repeat customers: count distinct customers with 2+ completed bookings
  const repeatResult=await safeAll(db,"SELECT COUNT(*) as repeat_count FROM (SELECT customer_id,COUNT(*) as booking_count FROM canonical_bookings WHERE provider_id=? AND status='completed' AND service_code IN ('boarding','pet_sitting') GROUP BY customer_id HAVING booking_count>=2)",[hostProviderId]);
  const repeatCustomers=Number(repeatResult[0]?.repeat_count||0);

  // Years hosting: from earliest booking
  const yearsResult=await safeFirst(db,"SELECT MIN(created_at) as first_booking FROM canonical_bookings WHERE provider_id=?",[hostProviderId]);
  const firstBookingTime=Number(yearsResult?.first_booking||Date.now());
  const yearsHosting=Math.floor((Date.now()-firstBookingTime)/(365.25*24*60*60*1000));

  // Avg rating from reviews
  const ratingResult=await safeFirst(db,"SELECT AVG(rating) as avg_rating,COUNT(*) as review_count FROM host_reviews WHERE host_provider_id=?",[hostProviderId]);
  const avgRating=Number(ratingResult?.avg_rating||0);
  const totalReviews=Number(ratingResult?.review_count||0);

  // Acceptance timeout lives on provider_capacity_profiles as MINUTES; expose seconds.
  const profileResult=await safeFirst(db,"SELECT acceptance_timeout_minutes FROM provider_capacity_profiles WHERE id=?",[hostProviderId]);
  const acceptanceTimeout=Number(profileResult?.acceptance_timeout_minutes||5)*60;

  // Medication support / home verification / KYC live on boarding_host_profiles, not the
  // capacity profile (sitting-only providers have no boarding_host_profiles row -> all false).
  const hostProfile=await safeFirst(db,"SELECT medication_support,home_verified,kyc_status FROM boarding_host_profiles WHERE provider_id=?",[hostProviderId]);
  const medicationSupport=Boolean(Number(hostProfile?.medication_support||0));

  // A badge that tells a customer "Identity and background verified" needs a verification record behind
  // it. boarding_host_profiles.kyc_status and home_verified are written by exactly one statement in this
  // codebase - the hardcoded host seed in lib/boarding-governance.ts, which sets them as literals - so
  // reporting those columns verbatim showed "KYC Verified" and "Verified Home" for providers with zero
  // verification records of any kind, to anyone, unauthenticated. The claim now needs BOTH: the
  // operator's own host record AND the platform's own evidence - the host category mandate satisfied for
  // that provider's onboarding application, and specifically the mandated house_verification for the
  // home badge. Nothing here decides what KYC means; those are the mandated checks the platform already
  // defines. This governs the BADGE only - host eligibility for booking is judged elsewhere, on the
  // columns, and changing that is an operations decision about the seeded UAT hosts. [PTJA-P0-06]
  const evidence=await hostVerificationEvidence(db,hostProviderId);
  const homeVerified=Boolean(Number(hostProfile?.home_verified||0))&&evidence.homeVerified;
  const kycVerified=String(hostProfile?.kyc_status||"")==="verified"&&evidence.mandateSatisfied;

  // Host cancelled count
  const cancelResult=await safeFirst(db,"SELECT COUNT(*) as host_cancelled FROM canonical_bookings WHERE provider_id=? AND cancellation_reason='host_cancelled'",[hostProviderId]);
  const hostCancelledCount=Number(cancelResult?.host_cancelled||0);

  return{
    completedStays,
    repeatCustomers,
    yearsHosting,
    avgRating:Math.round(avgRating*100)/100,
    totalReviews,
    acceptanceTimeout,
    medicationSupport,
    homeVerified,
    kycVerified,
    hostCancelledCount,
  };
}

export function computeHostBadges(stats:HostStats):Badge[]{
  const badges:Badge[]=[];
  const now=Date.now();

  // Superhost: >=10 completed stays AND avg rating >= 4.8
  if(stats.completedStays>=10&&stats.avgRating>=4.8){
    badges.push({
      id:"superhost",
      name:"Superhost",
      description:"Consistently excellent ratings and high volume of completed stays",
      icon:"⭐",
      earnedAt:now,
    });
  }

  // Medication Pro: medication_support on profile
  if(stats.medicationSupport){
    badges.push({
      id:"medication-pro",
      name:"Medication Pro",
      description:"Experienced in administering pet medications",
      icon:"💊",
      earnedAt:now,
    });
  }

  // Verified Home: home_verified
  if(stats.homeVerified){
    badges.push({
      id:"verified-home",
      name:"Verified Home",
      description:"Home verified by PawSpace team",
      icon:"🏡",
      earnedAt:now,
    });
  }

  // KYC Verified
  if(stats.kycVerified){
    badges.push({
      id:"kyc-verified",
      name:"KYC Verified",
      description:"Identity and background verified",
      icon:"✓",
      earnedAt:now,
    });
  }

  // Zero Cancellations: >=5 stays, 0 host-cancelled
  if(stats.completedStays>=5&&stats.hostCancelledCount===0){
    badges.push({
      id:"zero-cancellations",
      name:"Zero Cancellations",
      description:"Never cancelled a booking",
      icon:"🎯",
      earnedAt:now,
    });
  }

  // Quick Responder: acceptance timeout <= 3 min (180 sec)
  if(stats.acceptanceTimeout<=180){
    badges.push({
      id:"quick-responder",
      name:"Quick Responder",
      description:"Responds to booking requests within 3 minutes",
      icon:"⚡",
      earnedAt:now,
    });
  }

  return badges;
}
