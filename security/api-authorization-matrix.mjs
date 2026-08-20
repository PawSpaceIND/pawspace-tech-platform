import { fileURLToPath } from "node:url";
import { generateAuthorizationMatrix } from "../scripts/generate-api-authorization-matrix.mjs";

/**
 * Committed executable view of the authoritative PawSpace API authorization matrix.
 *
 * This intentionally derives from route exports + lib/api-gateway.ts + ownership guards instead of
 * copying policy into a second hand-maintained JSON map. CI imports this module on every run, which
 * regenerates the complete route x method view and then applies the reviewed source fingerprints.
 */
export const matrix = await generateAuthorizationMatrix();
export default matrix;

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
}
