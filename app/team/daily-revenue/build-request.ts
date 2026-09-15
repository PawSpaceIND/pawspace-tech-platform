/**
 * The request the daily revenue board's "Build today's list" control sends.
 *
 * The board said "It fills once leads exist and a daily target is set above." Both were true on a
 * live deployment — four open leads, a INR 50,000 target — and the list stayed empty, because what
 * BUILDS the list is the generate_daily_100 action and the page posted only set_daily_target and
 * claim_opportunity. Called directly the action returned {"created":4} and the board rendered four
 * claimable opportunities. It lives in its own module so a test can drive the real route with it.
 */
export const buildTodaysListRequest = () => ({ url: "/api/revenue-crm", body: { action: "generate_daily_100" } as const });
