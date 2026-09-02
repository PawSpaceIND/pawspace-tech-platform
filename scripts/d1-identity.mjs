/**
 * The one D1 database-id validator, shared by the backup and restore tools.
 *
 * It lived twice, once in each script, and the two copies drifted: the restore copy was written
 *
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i
 *
 * which drops the `{3}-[0-9a-f]` between the fourth and fifth groups and therefore matches NO valid
 * UUID at all. The effect was not a cosmetic one: assertRestoreTarget refused every legitimate
 * database id, and restore's own infoIdentity() uses the same pattern to pick the id out of
 * `wrangler d1 info`, so it could never identify the target either. D1 restore was unusable in every
 * environment, including the production break-glass path - the one path that only ever runs when
 * something has already gone badly wrong.
 *
 * Two copies of a security-relevant pattern is what allowed that, so there is now one.
 */

/** Canonical UUID (any version 1-5, RFC 4122 variant), which is the shape Cloudflare D1 ids take. */
export const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True when `value` is a well-formed D1 database id. */
export const isD1DatabaseId = (value) => D1_DATABASE_ID.test(String(value ?? "").trim());
