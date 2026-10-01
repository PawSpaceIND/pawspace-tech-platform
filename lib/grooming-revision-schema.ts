/** Explicit prerequisite preparation for the governed Grooming revision installation.
 * This does not activate authority, install triggers, seed revisions or mark an install ready.
 * Request-time readiness checks remain read-only and fail closed until installation completes. */
export async function ensureGroomingRevisionPrerequisiteTables(db:D1Database) {
 await db.batch([
  db.prepare(`CREATE TABLE IF NOT EXISTS conversation_ownership_revisions (
   thread_id TEXT PRIMARY KEY,
   revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
  )`),
  db.prepare(`CREATE TABLE IF NOT EXISTS grooming_effective_control_revision (
   id INTEGER PRIMARY KEY CHECK(id=1),
   revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
   database_incarnation TEXT NOT NULL CHECK(length(database_incarnation)>=32)
  )`),
  db.prepare(`CREATE TABLE IF NOT EXISTS grooming_revision_installation (
   id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL
  )`),
  db.prepare(`CREATE TABLE IF NOT EXISTS grooming_revision_installation_epoch (
   id INTEGER PRIMARY KEY CHECK(id=1),
   epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch BETWEEN 1 AND 9007199254740991),
   incarnation TEXT NOT NULL CHECK(length(incarnation)>=32)
  )`)
 ]);
}
