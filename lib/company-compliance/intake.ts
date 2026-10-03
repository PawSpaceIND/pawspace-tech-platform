import { DraftError, readFinanceMaster, type DraftDatabase } from './store';
import { FACT_KEYS, type FactEntry, type FactKey, type FactState, type IntakeRecord, type IntakeVersion } from './readiness-contract';

/**
 * Versioned company-information intake that keeps UNKNOWN facts explicit. It is a separate owned
 * record: it never feeds CompanyMaster, never relaxes validateCompany, and never makes a draft ready.
 */
type Row = Record<string, unknown>;
function fail(message: string, status = 400): never { throw new DraftError(message, status); }
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const validateId = (value: string) => { if (!/^[\w.-]{1,120}$/.test(value)) fail('invalid_id'); };
async function exists(db: DraftDatabase, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());
}
export const INTAKE_LIMITS = { value: 500, sourceReference: 200 } as const;

export async function ensureIntakeTable(db: DraftDatabase) {
  await db.batch([db.prepare('CREATE TABLE IF NOT EXISTS company_compliance_intake (entity_id TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_id,version))')]);
}

/** Every fact key must be present; a provided fact needs a value and a source, an unknown fact carries nothing. */
export function validateIntake(record: IntakeRecord): IntakeRecord {
  if (!record || typeof record !== 'object') fail('intake_record_required');
  validateId(text(record.entityId));
  const facts = record.facts as unknown;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) fail('intake_facts_required');
  const given = facts as Record<string, unknown>;
  if (Object.keys(given).length !== FACT_KEYS.length || FACT_KEYS.some(key => !Object.hasOwn(given, key))) fail('intake_fact_keys_incomplete');
  const clean = {} as Record<FactKey, FactEntry>;
  for (const key of FACT_KEYS) {
    const entry = given[key] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`intake_fact_invalid:${key}`);
    if (entry.state === 'unknown') {
      if (Object.keys(entry).length !== 1) fail(`intake_unknown_carries_values:${key}`);
      clean[key] = { state: 'unknown' }; continue;
    }
    if (entry.state !== 'provided') fail(`intake_fact_state_invalid:${key}`);
    const value = text(entry.value), sourceReference = text(entry.sourceReference);
    if (Object.keys(entry).length !== 3 || !value || value.length > INTAKE_LIMITS.value || !sourceReference || sourceReference.length > INTAKE_LIMITS.sourceReference) fail(`intake_fact_incomplete:${key}`);
    clean[key] = { state: 'provided', value, sourceReference };
  }
  return { entityId: text(record.entityId), facts: clean };
}

export async function readIntake(db: DraftDatabase, entityId: string): Promise<IntakeVersion | null> {
  validateId(entityId);
  if (!await exists(db, 'company_compliance_intake')) return null;
  const row = await db.prepare('SELECT version,record_json,created_by,created_at FROM company_compliance_intake WHERE entity_id=? ORDER BY version DESC LIMIT 1').bind(entityId).first<Row>();
  if (!row) return null;
  const record = JSON.parse(text(row.record_json)) as IntakeRecord;
  if (record.entityId !== entityId) fail('intake_storage_integrity_mismatch', 409);
  return { version: Number(row.version), record, createdBy: text(row.created_by), createdAt: text(row.created_at) };
}

export async function recordIntake(db: DraftDatabase, entityId: string, input: IntakeRecord, expectedVersion: number, actor: string) {
  validateId(entityId);
  if (!input || input.entityId !== entityId) fail('intake_entity_mismatch');
  const record = validateIntake(input);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) fail('invalid_intake_version');
  if (!await readFinanceMaster(db, entityId)) fail('active_indian_finance_entity_required', 404);
  await ensureIntakeTable(db);
  const current = await db.prepare('SELECT MAX(version) version FROM company_compliance_intake WHERE entity_id=?').bind(entityId).first<Row>();
  if (Number(current?.version || 0) !== expectedVersion) fail('intake_version_conflict', 409);
  // Immutable version insert; the primary key rejects concurrent stale writers.
  await db.prepare('INSERT INTO company_compliance_intake VALUES (?,?,?,?,?)').bind(entityId, expectedVersion + 1, JSON.stringify(record), actor, new Date().toISOString()).run();
  return { version: expectedVersion + 1, unknownFacts: FACT_KEYS.filter(key => record.facts[key].state === 'unknown'), mode: 'draft_only' as const };
}

/** The fact states a review pins, so a later intake version can be detected as a change. */
export function factStates(intake: IntakeVersion | null, keys: readonly FactKey[]): Partial<Record<FactKey, FactState>> {
  const states: Partial<Record<FactKey, FactState>> = {};
  for (const key of keys) states[key] = intake?.record.facts[key]?.state === 'provided' ? 'provided' : 'unknown';
  return states;
}
