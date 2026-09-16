/**
 * The subset of the Cloudflare D1 interface this platform depends on.
 *
 * Declared locally rather than imported from @cloudflare/workers-types so the core has no runtime
 * dependency on the Workers platform. Anything that satisfies this shape — D1, the node:sqlite
 * adapter in tests, or a future Postgres shim — can drive the whole domain layer.
 */

export type D1Meta = { changes: number; last_row_id: number };

export type D1Result<T = Record<string, unknown>> = {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
};

export interface D1Statement {
  readonly sql: string;
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: D1Meta }>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ success: boolean; meta: D1Meta }[]>;
  exec(sql: string): Promise<unknown>;
}
