import { APPEARANCE_STORAGE_KEY, CONCIERGE_AVAILABLE, DEFAULT_APPEARANCE, DEFAULT_THEME, PLATFORM_THEME_STORAGE_KEY, SAFE_THEME, STYLE_STORAGE_KEY, THEME_STORAGE_KEY, isAppearanceMode, isLegacyThemeId, isOfferedTheme, isThemeId, type AppearanceMode, type ThemeId } from "../mobile-app/theme-config";

/*
 * Appearance compatibility resolver (presentation only).
 *
 * One record per device, carried in a readable cookie so the server renders the effective theme before the first
 * theme-sensitive HTML. It keeps three values apart, as the handoff requires: the explicit user choice, the assigned
 * initial default (written once, never shown as a choice) and the effective theme (explicit, then assigned, then safe A,
 * with the C release gate applied without rewriting either saved value). Legacy palette and Professional/Fun values are
 * kept as an inactive snapshot for rollback and never render.
 *
 * The cookie value is a bounded dot-separated token drawn from [A-Za-z0-9._~-] only, so no browser, proxy or framework
 * cookie parser can split or re-encode it. Anything else, including the earlier semicolon-separated draft, is treated
 * as invalid and resolves to the safe theme without throwing.
 *
 * This is a device-scoped record, not an account implementation. No account field exists for appearance in this
 * repository (audited 3 Oct 2026); account-authoritative persistence, a validated server mutation and a server-side
 * new-user assignment stay with the backend owner. A device without a record is not proof of a genuinely new user.
 */
export const APPEARANCE_COOKIE = "pawspace-appearance";
export const APPEARANCE_RECORD_VERSION = "1";
export const APPEARANCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_COOKIE_VALUE_LENGTH = 240;
const MAX_LEGACY_PAIRS = 3;

export type AppearanceRecord = {
  version: typeof APPEARANCE_RECORD_VERSION;
  /** Set only by an explicit user action in the Appearance control. */
  explicit: ThemeId | null;
  /** Assigned once when the device first meets the shared layout. */
  assigned: ThemeId;
  mode: AppearanceMode;
  /** Inactive migration metadata, e.g. "theme~signature~style~cartoon". Never used for rendering. */
  legacy: string | null;
};

export type AppearanceSnapshot = {
  effective: ThemeId;
  explicit: ThemeId | null;
  assigned: ThemeId;
  mode: AppearanceMode;
  legacy: string | null;
  conciergeAvailable: boolean;
  /** False when no usable record existed; the client then writes the initial assignment. */
  recordPresent: boolean;
  /** True when a stored value was malformed or unsupported and the safe theme was used instead. */
  invalidInput: boolean;
  /** True when a previous legacy style was carried over, so the control can say so plainly. */
  legacyMoved: boolean;
};

export type AppearanceChangeDetail = { record?: unknown; theme?: unknown; mode?: unknown };

const COOKIE_SAFE = /^[A-Za-z0-9._~-]+$/;
const LEGACY_KEY = /^(theme|platform|style)$/;
const LEGACY_VALUE = /^[a-z0-9_-]{1,32}$/;

/** Builds the inactive legacy snapshot from already-sanitised pairs; anything unexpected is recorded as "invalid". */
function legacySnapshot(pairs: Array<[string, string]>): string | null {
  const parts: string[] = [];
  for (const [key, value] of pairs.slice(0, MAX_LEGACY_PAIRS)) {
    if (!LEGACY_KEY.test(key)) continue;
    parts.push(key, LEGACY_VALUE.test(value) ? value : "invalid");
  }
  return parts.length ? parts.join("~") : null;
}

function parseLegacy(segment: string): string | null | undefined {
  if (segment === "-") return null;
  const parts = segment.split("~");
  if (parts.length === 0 || parts.length % 2 !== 0 || parts.length > MAX_LEGACY_PAIRS * 2) return undefined;
  for (let i = 0; i < parts.length; i += 2) {
    if (!LEGACY_KEY.test(parts[i]) || !(LEGACY_VALUE.test(parts[i + 1]) || parts[i + 1] === "invalid")) return undefined;
  }
  return segment;
}

/** Strict, non-throwing parser. Anything malformed yields null plus the invalid flag; nothing is guessed. */
export function parseAppearanceRecord(value: unknown): { record: AppearanceRecord | null; invalid: boolean } {
  try {
    if (value === null || value === undefined || value === "") return { record: null, invalid: false };
    if (typeof value !== "string" || value.length > MAX_COOKIE_VALUE_LENGTH || !COOKIE_SAFE.test(value)) return { record: null, invalid: true };
    const segments = value.split(".");
    if (segments.length !== 5 || segments[0] !== `v${APPEARANCE_RECORD_VERSION}`) return { record: null, invalid: true };
    const [, explicitRaw, assignedRaw, modeRaw, legacyRaw] = segments;
    if (!isThemeId(assignedRaw)) return { record: null, invalid: true };
    if (explicitRaw !== "-" && !isThemeId(explicitRaw)) return { record: null, invalid: true };
    if (!isAppearanceMode(modeRaw)) return { record: null, invalid: true };
    const legacy = parseLegacy(legacyRaw);
    if (legacy === undefined) return { record: null, invalid: true };
    return { record: { version: APPEARANCE_RECORD_VERSION, explicit: explicitRaw === "-" ? null : explicitRaw, assigned: assignedRaw, mode: modeRaw, legacy }, invalid: false };
  } catch {
    return { record: null, invalid: true };
  }
}

/** Serialises a record to the bounded cookie-safe token. An unexpected field value is coerced to its safe form. */
export function serializeAppearanceRecord(record: AppearanceRecord): string {
  const explicit = isThemeId(record.explicit) ? record.explicit : "-";
  const assigned = isThemeId(record.assigned) ? record.assigned : SAFE_THEME;
  const mode = isAppearanceMode(record.mode) ? record.mode : DEFAULT_APPEARANCE;
  const legacy = typeof record.legacy === "string" && parseLegacy(record.legacy) ? record.legacy : "-";
  return `v${APPEARANCE_RECORD_VERSION}.${explicit}.${assigned}.${mode}.${legacy}`;
}

/** Normalises any record-shaped input through the serialiser and parser, so only well-formed records survive. */
export function normalizeAppearanceRecord(input: unknown): AppearanceRecord | null {
  if (!input || typeof input !== "object") return null;
  return parseAppearanceRecord(serializeAppearanceRecord(input as AppearanceRecord)).record;
}

/** Cookie string for the browser cookie jar or a Set-Cookie header. Presentation data only: readable by the client, Lax. */
export function appearanceCookie(record: AppearanceRecord, secure = true): string {
  return `${APPEARANCE_COOKIE}=${serializeAppearanceRecord(record)}; Path=/; Max-Age=${APPEARANCE_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The only writer of the device record. Returns false when cookies are unavailable; the page stays usable either way. */
export function persistAppearanceRecord(record: AppearanceRecord): boolean {
  try {
    if (typeof document === "undefined") return false;
    document.cookie = appearanceCookie(record, typeof location !== "undefined" && location.protocol === "https:");
    return true;
  } catch { return false; }
}

export function effectiveTheme(record: Pick<AppearanceRecord, "explicit" | "assigned">, conciergeAvailable: boolean): ThemeId {
  if (record.explicit && isOfferedTheme(record.explicit, conciergeAvailable)) return record.explicit;
  if (isOfferedTheme(record.assigned, conciergeAvailable)) return record.assigned;
  return SAFE_THEME;
}

/** Server and client call this with the same inputs and get the same snapshot; the first client render reuses it. */
export function resolveAppearance(input: { cookieValue?: unknown; adminDefault?: ThemeId; conciergeAvailable?: boolean } = {}): AppearanceSnapshot {
  const conciergeAvailable = input.conciergeAvailable ?? CONCIERGE_AVAILABLE;
  const adminDefault = input.adminDefault ?? DEFAULT_THEME;
  const { record, invalid } = parseAppearanceRecord(input.cookieValue);
  if (!record) {
    // A device without a usable record is initialised with the current eligible new-user default, otherwise safe A.
    const assigned: ThemeId = isOfferedTheme(adminDefault, conciergeAvailable) ? adminDefault : SAFE_THEME;
    return { effective: assigned, explicit: null, assigned, mode: DEFAULT_APPEARANCE, legacy: null, conciergeAvailable, recordPresent: false, invalidInput: invalid, legacyMoved: false };
  }
  return { effective: effectiveTheme(record, conciergeAvailable), explicit: record.explicit, assigned: record.assigned, mode: record.mode, legacy: record.legacy, conciergeAvailable, recordPresent: true, invalidInput: false, legacyMoved: Boolean(record.legacy) };
}

/**
 * Applies a `pawspace-appearance-change` event to the current record without ever guessing an explicit choice:
 * an event that carries a full record replaces it (after normalisation); an event from another writer may change the
 * display mode and may set the explicit choice only when it announces a different, currently offered theme. A mode-only
 * change or a repeat of the effective theme never touches the saved explicit choice or the assigned default.
 */
export function applyAppearanceEvent(current: AppearanceRecord, detail: AppearanceChangeDetail | null | undefined, conciergeAvailable: boolean): AppearanceRecord {
  if (!detail || typeof detail !== "object") return current;
  const carried = normalizeAppearanceRecord(detail.record);
  if (carried) return carried;
  let next = current;
  if (isAppearanceMode(detail.mode as string) && detail.mode !== current.mode) next = { ...next, mode: detail.mode as AppearanceMode };
  const theme = typeof detail.theme === "string" ? detail.theme : null;
  if (theme && isOfferedTheme(theme, conciergeAvailable) && theme !== effectiveTheme(current, conciergeAvailable)) next = { ...next, explicit: theme };
  return next;
}

/** Builds the initial record for a device that still carries legacy device keys. Reads only; the caller persists it. */
export function initialRecordFromLegacy(storage: { getItem: (key: string) => string | null } | null, snapshot: AppearanceSnapshot): AppearanceRecord {
  let theme: string | null = null, platform: string | null = null, mode: string | null = null, style: string | null = null;
  try {
    theme = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    platform = storage?.getItem(PLATFORM_THEME_STORAGE_KEY) ?? null;
    mode = storage?.getItem(APPEARANCE_STORAGE_KEY) ?? null;
    style = storage?.getItem(STYLE_STORAGE_KEY) ?? null;
  } catch { /* Storage unavailable: initialise without a legacy snapshot. */ }
  const pairs: Array<[string, string]> = [];
  if (theme && (isLegacyThemeId(theme) || !isThemeId(theme))) pairs.push(["theme", theme]);
  if (platform && (isLegacyThemeId(platform) || !isThemeId(platform))) pairs.push(["platform", platform]);
  if (style === "cartoon") pairs.push(["style", "cartoon"]);
  // A modern value stored under the legacy key is honoured as an explicit choice; legacy palettes never become one.
  const explicit: ThemeId | null = isThemeId(theme) ? theme : null;
  return { version: APPEARANCE_RECORD_VERSION, explicit, assigned: snapshot.assigned, mode: isAppearanceMode(mode) ? mode : snapshot.mode, legacy: legacySnapshot(pairs) };
}
