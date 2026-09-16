/**
 * The isolation seam. Every operational read and write in this platform goes through here.
 *
 * The design goal is not "remember to filter by tenant" — people forget, and with hundreds of
 * tables the probability of remembering every time is not 1. The goal is that the ordinary way to
 * query is ALSO the safe way, and that the unsafe way is hard to reach, ugly to name, checked at
 * runtime and written to the audit log.
 *
 * So there is no method on this class that returns a raw database handle. `from`/`insert`/`update`/
 * `remove` build their own WHERE clause and the tenant predicate is not optional or overridable.
 * The one escape hatch is called `rawTenantQuery`, demands a written reason, and refuses SQL that
 * does not mention tenant_id.
 *
 * Nothing here is exotic. It is a small amount of discipline installed on line one, because the
 * alternative — retrofitting it across a grown codebase — is the single highest-risk thing this
 * project could attempt.
 */

import type { Database } from "../db/types.ts";
import { newId } from "../db/ids.ts";
import { BRIDGE_SCOPED, TENANT_SCOPED, locationColumn } from "./schema.ts";
import { PermissionDeniedError, type Permission, type Role, isRole, roleHas } from "./rbac.ts";

export type LocationScope = "all" | readonly string[];

export class TenantAccessError extends Error {
  constructor(message = "No active membership for this tenant") {
    super(message);
    this.name = "TenantAccessError";
  }
}

/** Table and column names are interpolated, never bound, so they are validated before they are used. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new TenantAccessError(`Illegal identifier: ${name}`);
  return name;
}

type Row = Record<string, unknown>;

export type OpenOptions = {
  identityId: string;
  tenantId: string;
  /** Wall-clock injection point. Tests and the scheduler both need to control "now". */
  now?: number;
};

export class TenantContext {
  readonly tenantId: string;
  readonly identityId: string;
  readonly role: Role;
  readonly locationScope: LocationScope;
  readonly #db: Database;
  readonly #now: () => number;

  private constructor(
    tenantId: string,
    identityId: string,
    role: Role,
    locationScope: LocationScope,
    db: Database,
    now: () => number,
  ) {
    this.tenantId = tenantId;
    this.identityId = identityId;
    this.role = role;
    this.locationScope = locationScope;
    this.#db = db;
    this.#now = now;
  }

  /**
   * The only constructor. A context is the proven intersection of an authenticated identity and a
   * tenant, established by a membership row that exists in the database right now — never by a
   * tenant id a caller supplied on its own.
   *
   * Every refusal throws the same error with the same message. A caller probing tenant ids must not
   * be able to tell "no such tenant" from "tenant exists, you are not in it".
   */
  static async open(db: Database, options: OpenOptions): Promise<TenantContext> {
    const now = options.now ?? Date.now();
    const clock = () => options.now ?? Date.now();

    const membership = await db
      .prepare("SELECT role, location_scope, status FROM memberships WHERE tenant_id = ? AND identity_id = ?")
      .bind(options.tenantId, options.identityId)
      .first<Row>();
    if (!membership || membership.status !== "active") throw new TenantAccessError();
    if (!isRole(membership.role)) throw new TenantAccessError();

    const tenant = await db
      .prepare("SELECT status, trial_ends_at FROM tenants WHERE id = ?")
      .bind(options.tenantId)
      .first<Row>();
    if (!tenant) throw new TenantAccessError();
    if (tenant.status !== "active" && tenant.status !== "trialing") throw new TenantAccessError();
    if (tenant.status === "trialing" && Number(tenant.trial_ends_at ?? 0) <= now) {
      throw new TenantAccessError();
    }

    const identity = await db
      .prepare("SELECT status FROM identities WHERE id = ?")
      .bind(options.identityId)
      .first<Row>();
    if (!identity || identity.status !== "active") throw new TenantAccessError();

    return new TenantContext(
      options.tenantId,
      options.identityId,
      membership.role,
      parseScope(membership.location_scope),
      db,
      clock,
    );
  }

  /* ---------------- authorization ---------------- */

  can(permission: Permission): boolean {
    return roleHas(this.role, permission);
  }

  require(permission: Permission): void {
    if (!this.can(permission)) throw new PermissionDeniedError(permission, this.role);
  }

  /* ---------------- scoped access ---------------- */

  /**
   * Builds the predicate every statement starts with. Tenant always; branch as well when the
   * membership is scoped to specific locations and the table records one.
   *
   * A member scoped to an empty list of locations resolves to `1 = 0` rather than to no filter at
   * all. An empty scope must mean "sees nothing", never "sees everything" — that inversion is how
   * permission bugs become breaches.
   */
  private scope(table: string): { sql: string; args: unknown[] } {
    const name = identifier(table);
    if (!TENANT_SCOPED.has(name)) {
      const hint = BRIDGE_SCOPED.has(name)
        ? `${name} is the membership bridge and is read before a context exists`
        : `${name} is not registered as tenant-scoped in schema.ts`;
      throw new TenantAccessError(`Cannot reach ${name} through a tenant context: ${hint}`);
    }

    const parts = ["tenant_id = ?"];
    const args: unknown[] = [this.tenantId];

    const column = locationColumn(name);
    if (column && this.locationScope !== "all") {
      const ids = this.locationScope as readonly string[];
      if (ids.length === 0) {
        parts.push("1 = 0");
      } else {
        parts.push(`${column} IN (${ids.map(() => "?").join(", ")})`);
        args.push(...ids);
      }
    }
    return { sql: parts.join(" AND "), args };
  }

  private equality(where: Row): { sql: string; args: unknown[] } {
    const parts: string[] = [];
    const args: unknown[] = [];
    for (const [column, value] of Object.entries(where)) {
      const name = identifier(column);
      // tenant_id is owned by the context. A caller passing it is either confused or probing;
      // either way it is never allowed to widen or redirect the scope already applied.
      if (name === "tenant_id") throw new TenantAccessError("tenant_id is set by the context");
      if (value === null) { parts.push(`${name} IS NULL`); continue; }
      parts.push(`${name} = ?`);
      args.push(value);
    }
    return { sql: parts.join(" AND "), args };
  }

  async all<T = Row>(
    table: string,
    where: Row = {},
    options: { orderBy?: string; direction?: "ASC" | "DESC"; limit?: number } = {},
  ): Promise<T[]> {
    const scoped = this.scope(table);
    const filter = this.equality(where);
    const clauses = [scoped.sql, filter.sql].filter(Boolean).join(" AND ");
    let sql = `SELECT * FROM ${table} WHERE ${clauses}`;
    if (options.orderBy) {
      sql += ` ORDER BY ${identifier(options.orderBy)} ${options.direction === "DESC" ? "DESC" : "ASC"}`;
    }
    if (options.limit !== undefined) sql += ` LIMIT ${Math.max(0, Math.trunc(options.limit))}`;
    const result = await this.#db.prepare(sql).bind(...scoped.args, ...filter.args).all<T>();
    return result.results ?? [];
  }

  async first<T = Row>(table: string, where: Row = {}): Promise<T | null> {
    const rows = await this.all<T>(table, where, { limit: 1 });
    return rows[0] ?? null;
  }

  async count(table: string, where: Row = {}): Promise<number> {
    const scoped = this.scope(table);
    const filter = this.equality(where);
    const clauses = [scoped.sql, filter.sql].filter(Boolean).join(" AND ");
    const row = await this.#db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${clauses}`)
      .bind(...scoped.args, ...filter.args)
      .first<Row>();
    return Number(row?.n ?? 0);
  }

  /**
   * The row's tenant is stamped from the context, overwriting anything the caller passed. A forged
   * tenant_id in a request payload is therefore inert rather than dangerous.
   *
   * A branch-scoped member writing a row for a branch outside their scope is refused here too —
   * otherwise scope would filter reads while leaving writes wide open, which is worse than no
   * scoping at all because it looks safe.
   */
  async insert(table: string, row: Row): Promise<void> {
    this.scope(table);
    const payload: Row = { ...row, tenant_id: this.tenantId };

    const column = locationColumn(identifier(table));
    if (column && this.locationScope !== "all") {
      const target = payload[column];
      if (typeof target !== "string" || !(this.locationScope as readonly string[]).includes(target)) {
        throw new TenantAccessError(`Location ${String(target)} is outside this membership's scope`);
      }
    }

    const columns = Object.keys(payload).map(identifier);
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    await this.#db.prepare(sql).bind(...columns.map((c) => payload[c] ?? null)).run();
  }

  /** Returns rows changed. Zero means "not yours or not there" — the two are indistinguishable by design. */
  async update(table: string, patch: Row, where: Row): Promise<number> {
    const scoped = this.scope(table);
    const filter = this.equality(where);
    const sets: string[] = [];
    const setArgs: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      const name = identifier(column);
      if (name === "tenant_id") throw new TenantAccessError("tenant_id cannot be reassigned");
      sets.push(`${name} = ?`);
      setArgs.push(value);
    }
    if (sets.length === 0) return 0;
    const clauses = [scoped.sql, filter.sql].filter(Boolean).join(" AND ");
    const result = await this.#db
      .prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${clauses}`)
      .bind(...setArgs, ...scoped.args, ...filter.args)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  async remove(table: string, where: Row): Promise<number> {
    const scoped = this.scope(table);
    const filter = this.equality(where);
    const clauses = [scoped.sql, filter.sql].filter(Boolean).join(" AND ");
    const result = await this.#db
      .prepare(`DELETE FROM ${table} WHERE ${clauses}`)
      .bind(...scoped.args, ...filter.args)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  /* ---------------- audit ---------------- */

  async audit(entry: { action: string; entity: string; entityId: string; detail?: unknown }): Promise<void> {
    await this.insert("audit_log", {
      id: newId("aud"),
      at: this.#now(),
      actor_identity_id: this.identityId,
      actor_role: this.role,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId,
      detail: JSON.stringify(entry.detail ?? {}),
    });
  }

  /* ---------------- escape hatch ---------------- */

  /**
   * For reads the equality builder cannot express — range overlaps, joins, aggregates.
   *
   * The tenant id is bound as the FIRST parameter, so callers write `WHERE tenant_id = ?` and then
   * their own placeholders. SQL without that predicate is refused before it reaches the database
   * rather than quietly returning every tenant's rows.
   *
   * `reason` is a code comment forced into the signature: it exists so that a reviewer scanning for
   * raw SQL gets an explanation at every call site without leaving the line.
   *
   * Deliberately NOT audited. An earlier draft wrote an audit row per call, which put two extra
   * writes on every booking — the hottest path in the product — to record something a grep already
   * shows. The predicate check is the security control; review is handled statically by the guard
   * in tests/sql-tenant-predicate-guard.test.mjs, which fails if raw SQL naming a tenant-scoped
   * table appears anywhere outside this file.
   *
   * The check is a guard rail, not a proof: SQL mentioning tenant_id in a comment, or in only one
   * side of a join, would pass it. It raises the floor; it does not replace reading the query.
   */
  async rawTenantQuery<T = Row>(sql: string, args: unknown[], reason: string): Promise<T[]> {
    if (!reason || reason.trim().length < 8) {
      throw new TenantAccessError("rawTenantQuery requires a written reason");
    }
    if (!/\btenant_id\s*=\s*\?/i.test(sql)) {
      throw new TenantAccessError("rawTenantQuery requires an explicit `tenant_id = ?` predicate");
    }
    const result = await this.#db.prepare(sql).bind(this.tenantId, ...args).all<T>();
    return result.results ?? [];
  }
}

function parseScope(raw: unknown): LocationScope {
  if (raw === "all") return "all";
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    // An unparseable scope means nothing, not everything.
    return [];
  }
}
