/**
 * Enumerate every decision the gateway actually distinguishes.
 *
 * requiredPermission() in lib/api-gateway.ts does not map route+method to one permission. For 36
 * routes it reads the request body, and for several it reads the query string, so one route can demand
 * four different permissions depending on what is being asked:
 *
 *   POST /api/booking-operations
 *     action=refund_status          -> payments.manage
 *     action=apply_package_upgrade  -> pricing.manage
 *     action=running_late           -> communications.message
 *     anything else                 -> bookings.manage
 *
 * Freezing route+method alone therefore froze whichever branch an empty body happened to reach - the
 * last one - and left the other three unguarded. Moving `apply_package_upgrade` from pricing.manage to
 * bookings.view would have changed who can rewrite a booking's total and failed no test. That is the
 * shape of the QA-004 defect: a money-moving action reachable on a permission far too many roles hold.
 *
 * So the probe list is derived from the gateway's own source rather than written down. Every literal the
 * rule compares body.action against, and every query value it branches on, becomes its own frozen
 * entry. A new branch appears in the diff as a new line; a moved branch fails the matrix test.
 */

/** Permissions look like "finance.manage"; action names do not. */
const PERMISSION = /^[a-z_]+\.[a-z_]+$/;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/**
 * @param source the text of lib/api-gateway.ts
 * @returns [{ route, method, action?, query? }] - every distinct decision to freeze
 */
export function enumerateProbes(source) {
  const probes = [];
  const seen = new Set();
  const add = (probe) => {
    const key = probeKey(probe);
    if (!seen.has(key)) { seen.add(key); probes.push(probe); }
  };

  for (const line of source.split("\n")) {
    if (!line.includes('url.pathname===')) continue;
    const routes = [...line.matchAll(/url\.pathname==="(\/api\/[a-z0-9-]+)"/g)].map((m) => m[1]);
    if (!routes.length) continue;

    // Everything the rule compares body.action against. Read from the part of the rule that mentions
    // the body, so a permission name or a pathname elsewhere on the line is not mistaken for an action.
    const bodyAt = line.indexOf("body.");
    const actions = bodyAt === -1 ? [] : [...new Set(
      [...line.slice(bodyAt).matchAll(/"([a-z][a-z0-9_]*)"/g)]
        .map((m) => m[1])
        .filter((value) => !PERMISSION.test(value) && !METHODS.includes(value.toUpperCase())),
    )];

    // Query branches: `searchParams.get("scope")==="customer"` and the truthiness form
    // `searchParams.get("customerId")`, which decides between two permissions just as an action does.
    const queries = [];
    for (const m of line.matchAll(/searchParams\.get\("([a-zA-Z0-9_]+)"\)\s*===\s*"([^"]*)"/g)) queries.push({ [m[1]]: m[2] });
    for (const m of line.matchAll(/searchParams\.get\("([a-zA-Z0-9_]+)"\)(?!\s*===)/g)) queries.push({ [m[1]]: "probe" });

    for (const route of routes) {
      // The bare pair for every method, so adding a DELETE to a route later cannot arrive ungated.
      for (const method of METHODS) add({ route, method });
      // Branch probes for one method each. Every rule reads `method === "GET" ? … : …`, so the write
      // branch is method-agnostic - POST proves it for PATCH, PUT and DELETE too, and probing all four
      // would quadruple the fixture without freezing one extra decision.
      for (const query of queries) add({ route, method: "GET", query });
      for (const action of actions) add({ route, method: "POST", action });
    }
  }
  return probes;
}

/** A stable, readable key. The bare form stays "GET /api/x" so existing entries do not churn. */
export function probeKey({ route, method, action, query }) {
  if (action) return `${method} ${route} [action=${action}]`;
  if (query) { const [[k, v]] = Object.entries(query); return `${method} ${route} [?${k}=${v}]`; }
  return `${method} ${route}`;
}

/** Build the Request a probe describes. */
export function probeRequest(host, { route, method, action, query }, email) {
  const url = new URL(`${host}${route}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const init = { method, headers: { "oai-authenticated-user-email": email } };
  if (method !== "GET") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(action ? { action } : {});
  }
  return new Request(url, init);
}
