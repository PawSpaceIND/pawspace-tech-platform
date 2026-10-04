/**
 * TEST / LOCAL. First executable NORMAL Grooming journey (frozen cohort OPS-GROOMING-01) through the real route handlers, one
 * shared harness and one run descriptor. See tests/helpers/atlas-grooming-journey-executors.mjs for the stage-by-stage
 * executor and its TEST labels. The packet printed at the end feeds docs/atlas/ATLAS_JOURNEY_LEDGER.md.
 */
import test from "node:test";
import { setupJourney } from "./helpers/grooming-journey-harness.mjs";
import { executeGroomingNormalJourney, RUN_DESCRIPTOR } from "./helpers/atlas-grooming-journey-executors.mjs";
export { RUN_DESCRIPTOR };
let stages = [];
test(`[${RUN_DESCRIPTOR}] TEST first normal Grooming journey: enquiry to consented follow-up through real routes`, async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  ({ stages } = await executeGroomingNormalJourney(ctx));
});
test.after(() => { console.log("FIRST_JOURNEY_PACKET " + JSON.stringify({ runDescriptor: RUN_DESCRIPTOR, cohortId: "OPS-GROOMING-01", label: "TEST/LOCAL executable journey; not hosted whole-job evidence", stages }, null, 1)); });
