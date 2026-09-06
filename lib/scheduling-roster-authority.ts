/**
 * Who is allowed to say a provider is available, and which rows the eligibility engine may believe.
 *
 * backend/src/scheduling.ts makes published availability an eligibility RULE - a provider with no row
 * for a date is refused with "No published availability on <date>", and a requested time outside every
 * published window is refused with "Requested time is outside roster". The authorized write path for
 * that table is app/api/provider-capacity-control POST set_availability, which requires
 * scheduling.manage and writes source='operations'; backend/src/domain.ts declares the whole set of
 * authored sources in ProviderAvailability.source: "partner_app" | "operations" | "roster" - the
 * provider's own app, an Ops publish, and an imported roster.
 *
 * `uat_roster` is not one of them. It is written by seedUatRoster on the CUSTOMER's own reserve path,
 * which means the rule was satisfiable by the party it constrains. Measured on this branch: against an
 * empty table one unprivileged reserve wrote 300 synthetic 09:00-19:00 rows covering three providers
 * for 100 days; and with Ops having published groom_arun 09:00-11:00, a customer reserving 15:00-17:00
 * IST was assigned groom_arun, because listAvailability returns every row for provider+date and the
 * engine's check is `roster.some(...)` - the synthetic row simply joined the narrow one beside it.
 * Ops could not restrict a provider's hours at all. [PTJA-W1-F27]
 *
 * Two rules follow, and they are independent on purpose:
 *
 *   1. Seeding is a CAPABILITY, so it needs an explicit declaration. Same reasoning as
 *      lib/payment-environment.ts: an absent variable is not a declaration and must unlock nothing.
 *      There was no scheduling environment flag anywhere in the domain, so a production runtime
 *      fabricated roster exactly as a UAT one did.
 *
 *   2. Where a provider or Ops HAS authored availability for a date, that is the answer for that date.
 *      This does not depend on rule 1 and is the load-bearing half: a synthetic row seeded before Ops
 *      narrowed the day would otherwise keep widening it forever, and turning seeding off cannot
 *      retract rows already in the table.
 */

/** The sources backend/src/domain.ts declares for ProviderAvailability. Nothing else is evidence. */
export const AUTHORED_AVAILABILITY_SOURCES=["partner_app","operations","roster"] as const;

/** A literal list, so the eligibility read never builds placeholders from an array. */
const AUTHORED_SOURCE_SQL="('partner_app','operations','roster')";

type SchedulingEnv=Record<string,unknown>|null|undefined;
type AvailabilityRow=Record<string,unknown>;
type RosterDb={prepare(sql:string):{bind(...values:unknown[]):{all<T>():Promise<{results:T[]}>}}};

/** The declared scheduling environment, lowercased and trimmed. Empty when nothing was declared. */
export function declaredSchedulingEnvironment(env:SchedulingEnv){return String(env?.PAWSPACE_SCHEDULING_ENV??"").trim().toLowerCase();}

/**
 * Whether the UAT roster seeder may write synthetic availability. True only for an explicit `uat`
 * declaration; an absent or empty variable is not a declaration and unlocks nothing.
 */
export function uatRosterSeedingEnabled(env:SchedulingEnv){return declaredSchedulingEnvironment(env)==="uat";}

/**
 * Every availability row the eligibility engine is entitled to believe for one provider on one date.
 *
 * This is intentionally one D1 round trip. The older implementation first queried authored rows and,
 * when none existed, issued a second query for synthetic UAT rows. Provider evaluation fans this call
 * out across the shortlist, so that fallback doubled remote D1 latency on the hottest scheduling read.
 * The EXISTS predicate preserves the exact authority rule: authored rows win; otherwise all rows for
 * the provider/date are eligible evidence.
 */
export async function listAuthoritativeAvailability(db:RosterDb,providerId:string,date:string){
  return (await db.prepare(`
    SELECT *
    FROM scheduling_availability a
    WHERE a.provider_id=? AND a.date=?
      AND (
        a.source IN ${AUTHORED_SOURCE_SQL}
        OR NOT EXISTS (
          SELECT 1
          FROM scheduling_availability authored
          WHERE authored.provider_id=a.provider_id
            AND authored.date=a.date
            AND authored.source IN ${AUTHORED_SOURCE_SQL}
        )
      )
  `).bind(providerId,date).all<AvailabilityRow>()).results;
}
