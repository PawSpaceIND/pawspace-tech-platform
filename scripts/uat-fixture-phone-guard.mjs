// Pure preflight: no network, database writes, consent changes, or phone calls.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { canonicalDialNumber, normalisedDialKey } from '../lib/voice-call-gate.ts';

export const WHATSAPP_FIXTURE_ID = 'UAT-WA-CERT-CUSTOMER';
export const OWNER_INVENTORY_SQL = 'SELECT COUNT(*) AS owner_count FROM canonical_customers; SELECT id,primary_phone,secondary_phone FROM canonical_customers;';
const refuse = message => { throw new Error(message); };

export function fixtureRecipient(value) {
  const phone = canonicalDialNumber({}, value);
  if (!phone || !/^\+91[6-9]\d{9}$/.test(phone)) {
    refuse('A single valid India UAT mobile recipient is required; value withheld');
  }
  return phone;
}

export function readFixtureOwnerInventory(payload) {
  if (!Array.isArray(payload) || payload.length !== 2 || payload.some(block =>
    !block || block.success !== true || !Array.isArray(block.results))) {
    refuse('Canonical owner inventory is unavailable or incomplete');
  }
  const [countBlock, ownersBlock] = payload;
  const count = countBlock.results[0]?.owner_count;
  if (countBlock.results.length !== 1 || !Number.isSafeInteger(count) || count < 0 ||
      count > 20000 || ownersBlock.results.length !== count) {
    refuse('Canonical owner inventory count did not match; refusing a partial scan');
  }
  const rows = ownersBlock.results;
  if (rows.some(row => !row || typeof row.id !== 'string' || !row.id.trim() ||
      !Object.hasOwn(row, 'primary_phone') || !Object.hasOwn(row, 'secondary_phone')) ||
      new Set(rows.map(row => row.id)).size !== count) {
    refuse('Canonical owner inventory has missing fields or duplicate identities');
  }
  return rows;
}

export function assertFixturePhoneAvailable(payload, recipient) {
  const phone = fixtureRecipient(recipient);
  const owners = readFixtureOwnerInventory(payload);
  // A retired fixture is not a reusable account. Never reattach its old recipient,
  // replace its phone, reset its consent, or overwrite its existing pet/booking.
  if (owners.some(row => row.id === WHATSAPP_FIXTURE_ID)) {
    refuse('Certification fixture already exists; automatic reuse or reactivation is prohibited');
  }
  const key = normalisedDialKey(phone);
  const collision = owners.some(row => [row.primary_phone, row.secondary_phone].some(value => {
    const candidate = canonicalDialNumber({}, value);
    return candidate !== null && normalisedDialKey(candidate) === key;
  }));
  if (collision) refuse('UAT recipient already belongs to a canonical customer; no fixture changes permitted');
  return { checked: true, canonicalOwnersScanned: owners.length, changed: false, dialed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let inventory;
  try { inventory = JSON.parse(readFileSync(process.env.OUT, 'utf8')); }
  catch { refuse('Canonical owner inventory could not be read or parsed; values withheld'); }
  const proof = assertFixturePhoneAvailable(inventory, process.env.UAT_RECIPIENT);
  console.log('UAT_FIXTURE_OWNER_PREFLIGHT=' + JSON.stringify(proof));
}
