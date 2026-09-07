# `drizzle/` — generated, and deliberately not applied

These 27 `.sql` files are `drizzle-kit generate` output. **No workflow applies them**, to any
environment — not preview, not staging, not production.

That is not an oversight. This codebase does not migrate its schema; it **creates it at runtime**.
Every module owns `ensure*Tables(db)` functions of `CREATE TABLE IF NOT EXISTS`, and
`worker/index.ts` runs the bootstrap on both the fetch and scheduled paths before any handler
touches the database. `lib/financial-runtime-bootstrap.ts` is the money path's entry point.

`deploy-release-preview.yml` contains a `wrangler d1 migrations apply` step, but it is guarded by
`if [ -d migrations ]` and there is no `migrations/` directory — wrangler's default
`migrations_dir`. The step has therefore never run, and its own log line says so: *"the route
creates its own tables on first request."*

## Why keep the files

They are a readable, reviewable record of intended schema, and `drizzle-kit` needs the history to
generate correctly. Deleting them would lose that.

## What actually protects the schema

`tests/runtime-schema-completeness.test.mjs` asserts that **every table production code writes to
has a runtime creator**. It is exhaustive by construction over `lib/`, `app/` and `worker/`, and it
fails naming the file when a route writes to a table nobody creates — the one failure mode this
architecture has no other safety net for.

## If you are adding a table

Add it to the owning module's `ensure*Tables`. Adding it only to `drizzle/` will typecheck, lint,
and fail in production on the first request with `no such table`.
