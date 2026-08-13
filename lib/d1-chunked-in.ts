/**
 * D1 caps a single query at 100 bound parameters. A `WHERE id IN (?,?,...)` built from a result set
 * therefore works in every test fixture and every young environment, then starts failing the moment
 * real volume arrives - and because these reads are wrapped in swallow-and-continue helpers, the
 * failure surfaces as a confident zero rather than an error.
 *
 * Staging showed exactly that: /team/analytics reported 331 bookings and GMV of Rs 3,24,472 next to
 * "Collected Rs 0" on every single service line, because the payments read for those 331 bookings
 * asked D1 for 331 bound parameters and was discarded.
 *
 * Every IN-list read over an unbounded set goes through here: the ids are split into chunks that fit
 * inside the cap and the chunk results are concatenated, so the answer is identical to the one the
 * single query was meant to give.
 */
export const D1_IN_CHUNK = 80;

export function idChunks<T>(ids: readonly T[], size = D1_IN_CHUNK): T[][] {
  if (size < 1) throw new Error("Chunk size must be at least 1");
  const chunks: T[][] = [];
  for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
  return chunks;
}

/**
 * Runs `read` once per chunk and concatenates the rows. `read` receives the chunk plus the matching
 * `?,?,...` placeholder string, so call sites keep their own SQL, bindings and error handling.
 */
export async function chunkedIn<T, R>(
  ids: readonly T[],
  read: (chunk: T[], placeholders: string) => Promise<R[]>,
  size = D1_IN_CHUNK,
): Promise<R[]> {
  if (!ids.length) return [];
  const results = await Promise.all(idChunks(ids, size).map((chunk) => read(chunk, chunk.map(() => "?").join(","))));
  return results.flat();
}
