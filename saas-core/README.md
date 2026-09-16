# saas-core

A multi-tenant operating system for appointment-based businesses — salons, spas, pet grooming,
barbers, nail and lash studios, wellness centres and appointment-driven clinics.

One core. Verticals are configuration, not forks.

## Status

Phase A, increment 1. The tenancy substrate and the booking spine exist and are tested. Payments,
invoicing, commission, inventory, CRM and the AI layer do not yet — they are Phase C onward and are
not claimed here.

```
35 tests, 35 passing
  20  tenant-isolation      the adversarial cross-tenant battery
   4  sql-boundary-guard    structural guards on the seam
  11  golden-loop           signup through booked appointment, across four verticals
```

## This directory is a separate product

It has no imports from the surrounding PawSpace application and is excluded from the root
`tsconfig.json`. It is meant to be lifted into its own repository:

```
git subtree split --prefix=saas-core -b saas-core-main
```

Nothing here should ever `import` from `../lib` or `../app`. Reuse from PawSpace happens by porting
a module in and genericising it, never by reaching across.

## The one rule

**Nothing gets built ahead of tenant isolation.**

An operational row belongs to exactly one tenant and that ownership is part of its primary key. Two
tenants can both hold a customer with id `cus_1`; the database keeps them apart. There is no id
space shared across tenants where a bug could make one resolve to the other.

Every operational read and write goes through `TenantContext`. It does not expose a raw database
handle. `all` / `first` / `count` / `insert` / `update` / `remove` build their own `WHERE` clause and
the tenant predicate is not optional or overridable.

```ts
const ctx = await TenantContext.open(db, { identityId, tenantId });
await ctx.all("appointments", { status: "booked" });   // tenant_id is already in the query
```

`TenantContext.open` proves the membership in the database. A tenant id supplied by a caller is
never trusted on its own, and every refusal — no membership, no tenant, suspended, expired trial,
revoked — throws the identical error, so a caller probing ids learns nothing.

For queries the equality builder cannot express there is one escape hatch, `rawTenantQuery`, which
refuses SQL without an explicit `tenant_id = ?` predicate and binds the tenant itself as the first
parameter. `tests/sql-boundary-guard.test.mjs` fails if any module outside the three SQL owners
calls the database directly.

## Identity is not membership

PawSpace's `app_users.email NOT NULL UNIQUE` conflated "who can log in" with "who is a customer of
this business", which is why it could not go multi-tenant. Here they are separate:

- **`identities`** — one login per human, platform-wide, email unique. Staff and owners.
- **`memberships`** — that identity's role in one tenant, optionally scoped to specific branches.
- **`customers`** — tenant-scoped records, email unique *within* a tenant, no login required.

So a stylist working weekends at two salons has one login and two memberships with different roles,
and one person can be a customer of four businesses without any of them learning about the other
three.

## Verticals

The scheduling engine books `staff + resource + duration + buffers`. A stylist and a chair, a
therapist and a room, a groomer and a table, a dentist and an operatory are the same four rows.
`tests/golden-loop.test.mjs` LOOP-08 runs all four through one code path.

Buffers are part of the occupied window, not decoration: a 60-minute massage with a 15-minute
turnaround shows the customer 10:00–11:00 and holds the room until 11:15. The appointment row
stores both — `starts_at`/`ends_at` for the customer, `occupies_from`/`occupies_to` for the
scheduler.

## Running it

```
npm test              # everything
npm run test:isolation # the battery and the guards only
npm run typecheck
```

Requires Node 22.15+. No dependencies: TypeScript runs under `--experimental-strip-types` and the
test harness adapts `node:sqlite` to the D1 interface, so the modules under test run their real SQL
against a real engine.

Node's strip-only mode does not support TypeScript parameter properties (`constructor(readonly x)`).
Declare fields explicitly.

## Tests are sabotage-verified

A green isolation battery means nothing until the defect it claims to catch has been shown to turn
it red. Every guard in this directory has been verified by breaking the production code and
confirming the named test fails:

| Sabotage | Result |
| --- | --- |
| Tenant predicate removed from `scope()` | 9 of 20 isolation tests fail |
| `insert` honours a caller-supplied `tenant_id` | ISO-04 fails |
| Empty location scope means "everything" | ISO-12 fails |
| Raw `.prepare()` added to a domain module | GUARD-01 fails |
| A table added without classification | GUARD-03 fails |
| Primary key no longer leads with `tenant_id` | GUARD-04 fails |
| Raw SQL against a tenant table in `provisioning.ts` | GUARD-02 fails |

LOOP-04 was not written to pass. It was written to book into another appointment's turnaround
buffer, and it found a real defect: the collision check compared the new booking's buffered window
against the existing row's *unbuffered* `ends_at`, so a booking could land inside a turnaround. The
fix is the stored `occupies_from`/`occupies_to` pair.
