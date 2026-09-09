// Validate the supplied environment; never silently replace an unsafe declaration.
export function assertHumanBetaSandbox(env) {
  for (const [name, expected] of Object.entries({
    PAWSPACE_PAYMENT_ENV: "sandbox",
    FORBID_PRODUCTION: "true",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  })) {
    if (env[name] !== expected) throw new Error(`${name} must equal ${JSON.stringify(expected)} for human beta`);
  }
}
