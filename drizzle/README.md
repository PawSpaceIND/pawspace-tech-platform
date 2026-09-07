# `drizzle/` — generated archive with governed replay

These `.sql` files are `drizzle-kit generate` output. Production schema ownership remains runtime-first:
each module owns `ensure*Tables(db)` functions using additive `CREATE ... IF NOT EXISTS`, and
`worker/index.ts` boots those owners before handlers use D1. `lib/financial-runtime-bootstrap.ts` is
the money-path entry point.

No production workflow blindly executes this directory as a migration ledger. `deploy-release-preview.yml`
only invokes Wrangler migrations when a separate `migrations/` directory exists. That directory is not
the `drizzle/` archive.

## Replay governance

The archive is still required to be repeat-safe for audit and scratch-database verification. Use
`scripts/schema/apply-idempotent-drizzle.mjs` when replaying generated SQL. It normalizes historical
`CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER`, and corresponding DROP forms to idempotent SQLite
DDL. SQLite/D1 does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so additive columns use
`-- @add-column-if-missing table|column|definition` directives. The runner checks `PRAGMA table_info`
before issuing the real `ALTER TABLE ... ADD COLUMN`.

Do not replace those directives with unconditional ALTER statements.

## What protects the schema

`tests/schema-creation-source-contract.test.mjs` statically asserts that every table production code
writes has a runtime creator.

`tests/schema-governance-runtime.test.mjs` executes real runtime schema owners against `node:sqlite`,
boots the schema twice, enables foreign keys, requires `PRAGMA foreign_key_check` to return zero rows,
and runs anti-join orphan checks from `lib/schema-governance-manifest.ts` for intentionally
unconstrained logical relationships.

`tests/schema-migration-idempotency.test.mjs` proves the 0025 additive-column migration can be replayed
and rejects ungoverned ADD COLUMN statements.

`tests/schema-query-plan.test.mjs` uses `EXPLAIN QUERY PLAN` to block regressions from indexed financial,
provider-matching, and CRM hot paths back to full table scans.

Run all of them under the locked environment with:

```bash
npm run test:schema-governance
```

The npm script pins `PAWSPACE_PAYMENT_ENV=sandbox`, `FORBID_PRODUCTION=true`, `NODE_ENV=test`, and
`APP_ENV=staging`.

## If you are adding a table or relationship

Add the table to the owning module's `ensure*Tables`. If a relationship cannot safely be a physical
SQLite foreign key, add it to `lib/schema-governance-manifest.ts` so the anti-join audit fails on
orphans. Add or update a query-plan assertion whenever a high-frequency access path changes.
