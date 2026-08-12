// Ambient declaration for the Workers virtual module `cloudflare:workers`,
// which exposes the bound environment (D1 database, asset fetchers, and the
// configured environment variables). This file is intentionally script-mode
// (no top-level import/export) so the `declare module` below is a genuine
// ambient module declaration for the virtual specifier, resolvable by
// `tsc --noEmit` even though the module only exists inside the Workers runtime.
//
// The D1Database / Fetcher interfaces it references are declared globally in
// ./cloudflare-workers.d.ts.

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    ASSETS?: Fetcher;
    IMAGES?: Fetcher;
    FOUNDER_EMAIL?: string;
    NODE_ENV?: string;
    PAWSPACE_PAYMENT_ENV?: string;
    RAZORPAY_KEY_ID_SANDBOX?: string;
    RAZORPAY_KEY_SECRET_SANDBOX?: string;
    NEXT_PUBLIC_PAWSPACE_DEFAULT_APPEARANCE?: string;
    NEXT_PUBLIC_PAWSPACE_DEFAULT_THEME?: string;
  };
}
