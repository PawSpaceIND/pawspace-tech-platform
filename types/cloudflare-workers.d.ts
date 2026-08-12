// Minimal ambient Cloudflare Workers runtime types used by this project.
//
// The production build (vinext/esbuild) strips types and never type-checks,
// so these declarations exist purely so `tsc --noEmit` (the `npm run typecheck`
// gate) can resolve the Workers globals the code relies on — chiefly the D1
// database binding used as `type Db = D1Database` across lib/.
//
// Kept intentionally minimal and mirroring @cloudflare/workers-types; if the
// code starts using more of the Workers runtime, extend this file (or adopt
// the official @cloudflare/workers-types package).
export {};

declare global {
  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
    error?: string;
  }

  interface D1ExecResult {
    count: number;
    duration: number;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    raw<T = unknown[]>(): Promise<T[]>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = Record<string, unknown>>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]>;
    exec(query: string): Promise<D1ExecResult>;
    dump(): Promise<ArrayBuffer>;
  }

  interface Queue<Body = unknown> {
    send(message: Body, options?: unknown): Promise<void>;
    sendBatch(
      messages: Iterable<{ body: Body }>,
      options?: unknown,
    ): Promise<void>;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
  }

  interface Fetcher {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }
}
