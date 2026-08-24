/**
 * Shared setup for the executed AI suites.
 *
 * The AI module's proof was 13 source-text suites against 3 executed ones: the assertions checked
 * that identifiers appeared in `lib/ai-*.ts`, which is satisfied by a comment. These helpers exist so
 * a new AI suite can drive the real orchestrator, the real tool registry and the real provider
 * adapter over a real SQLite-backed D1 without re-deriving the schema each time.
 *
 * Deliberately not a mock of any AI module. The only thing stubbed is the network - `stubFetch`
 * replaces the outbound origin, because the alternative is either calling a paid provider from CI or
 * never executing the failure branches at all.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./module-hooks.mjs";

export const NOW = 1770000000000;

export function installAiHooks() {
  installWorkersHooks("__AI_DB__", "__PAWSPACE_TEST_ENV__");
}

export function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const out = []; for (const item of items) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Pulls DDL out of the module that owns it rather than restating it here, so the harness cannot drift
 * from production schema the way a hand-copied CREATE TABLE does.
 */
export function applyOwnedDdl(sqlite, path) {
  const source = read(path);
  for (const match of source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)) {
    const statement = match[2];
    if (!/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(statement)) continue;
    const isIndex = /^\s*CREATE (UNIQUE )?INDEX/i.test(statement);
    try {
      sqlite.exec(statement);
    } catch (error) {
      // An index on a table this harness does not create is the ONE ignorable case. A CREATE TABLE
      // that fails means the extracted DDL no longer parses - schema drift - and swallowing it left
      // the suite running against an incomplete database, reporting either misleading AI behaviour or a
      // failure at some unrelated later statement. It fails here, naming the file and the statement.
      if (isIndex && /no such table/i.test(String(error?.message))) continue;
      throw new Error(`${path}: DDL failed to apply (${String(error?.message).slice(0, 160)})\n  ${statement.slice(0, 200)}`);
    }
  }
}

/** A database with the identity/auth/canonical tables every AI path touches, and the env bound. */
export function freshAiDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA journal_mode=MEMORY;");
  const db = makeD1(sqlite);
  globalThis.__AI_DB__ = db;
  globalThis.__PAWSPACE_TEST_ENV__ = { ...env };
  applyOwnedDdl(sqlite, "lib/customer-account.ts");
  applyOwnedDdl(sqlite, "lib/server-auth.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT,breed TEXT,vaccination_status TEXT,source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT NOT NULL,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,channel TEXT,total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',provider_id TEXT,provider_name TEXT,provider_status TEXT,provider_eta TEXT,created_at INTEGER,updated_at INTEGER)");
  return { sqlite, db };
}

export function seedCustomer(sqlite, id, name, phone) {
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(id, "blr", name, phone, NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(`PET-${id}`, id, `${name}'s dog`, "dog", "Indie", "verified", NOW, NOW);
}

export const staffActor = {
  email: "founder@pawspace.in", roleCode: "founder", permissions: ["*"], developmentPreview: false,
  identitySource: "workspace", principalType: "email", principalKey: "founder@pawspace.in",
};

/** A real customer identity - platform-session principal, self-service permissions only. */
export function customerActor(sqlite, customerId) {
  const email = `customer+${customerId}@pawspace.test`;
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(email, customerId, NOW, NOW);
  return { email, roleCode: "customer", permissions: ["scheduling.book"], developmentPreview: false, identitySource: "platform_session", principalType: "email", principalKey: email };
}

export async function inboundMessage(sqlite, db, { threadId, customerId, text, channel = "chat", idempotencyKey }) {
  const comms = await import("../../lib/communication-engine.ts");
  await comms.ensureCommunicationTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR IGNORE INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open','ai-orchestrator',NULL,?,?)")
    .run(threadId, customerId, now, now);
  const messageId = `MSG-${idempotencyKey}`;
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound',?,'transactional','test',?,'received','test',NULL,?,'{}','test',?,?)")
    .run(messageId, threadId, customerId, channel, JSON.stringify({ text }), idempotencyKey, now, now);
  return messageId;
}

/**
 * Replaces the outbound origin for one test. `handler(url, init)` returns either a Response, or one of
 * the shorthands below; every call is recorded so a suite can assert on what was actually sent - and,
 * critically, on what was NOT sent.
 */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A body that arrives as headers-then-trickle, so a headers-only deadline would pass this.
 *
 * The abort signal is wired into the stream because that is what a real fetch implementation does:
 * aborting a request errors its body stream. Without that wiring the stub could not distinguish an
 * adapter that holds its deadline through the body read from one that releases it after the
 * handshake - which is the whole point of the case.
 */
export function slowBodyResponse(text, delayMs, signal) {
  const stream = new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      }, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        controller.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

/** A body larger than any sane provider answer, used to prove the size bound is real. */
export function oversizedResponse(bytes) {
  return jsonResponse(JSON.stringify({ content: [{ type: "text", text: "x".repeat(bytes) }] }));
}

export const UAT_AI_ENV = {
  PAWSPACE_AI_PROVIDER_API_KEY: "uat-test-key-not-a-real-credential",
  PAWSPACE_AI_PROVIDER_TIMEOUT_MS: "150",
};
