# Button audit scanner

`scan.py` is a small, dependency-free JSX-aware scanner. It finds `<button>` tags
that have no `onClick` and no `type="submit"` — i.e. buttons that, as written,
do nothing when clicked.

It is **not** a generic linter and is not wired into CI. It was built for one
specific pass (see `HANDOFF.md` at the repo root for full context) and is
committed here so that pass is reproducible and extendable, not because it's
meant to run automatically.

## Usage

```bash
# Scan specific files
python3 tools/button-audit/scan.py app/page.tsx app/walking/page.tsx

# Scan the same customer/partner surface the original audit covered
bash tools/button-audit/run-full-scan.sh
```

No output = clean. Any output lists the file, line number, the raw tag, and a
short snippet of what follows it (usually the button's visible label) to help
you find it fast.

## How it works

Plain regex breaks on JSX because `onClick={() => doThing()}` contains a literal
`>` inside the arrow function, which a naive `<button[^>]*>` pattern will treat
as the end of the tag. `scan.py` instead walks character-by-character from each
`<button` opening, tracking `{}` nesting depth and quote state, so it correctly
finds the *real* end of the opening tag before checking whether `onClick`
appears inside it.

## Known false positives (by design, not a bug in the scanner)

- **Buttons inside `<form onSubmit={...}>` with no explicit `type`.** HTML
  defaults these to `type="submit"`, so no `onClick` is needed. The scanner
  only recognizes an *explicit* `type="submit"` in the tag text, so these will
  always show up — check for a real `onSubmit` on the enclosing `<form>`
  before assuming it's a bug.
- **Deliberately disabled buttons with no click behavior to test**, e.g.
  telephony buttons gated behind `disabled={!supportPhoneConfigured}` where
  the button's own label already states why it's disabled. These are a
  correct design pattern in this codebase (see `app/funeral-memorial/page.tsx`
  and `app/partner/funeral/page.tsx`), not something to fix.
- **A JS variable or parameter that happens to be named the same single letter
  as an unrelated pattern elsewhere** won't false-positive here (this scanner
  only looks at literal `<button` tags), but the equivalent risk exists if you
  extend this tool to check other things — always read the surrounding code
  before treating a flag as confirmed.

## Extending the audit

The original pass only covered customer- and partner-facing pages (the file
list baked into `run-full-scan.sh`). It deliberately excluded internal
`/team/`, `/control/`, `/crm/`, `/ops/`, `/admin/`, and lab/preview routes,
since those are staff-only tools, not something a customer or partner tester
will click through.

To extend coverage:
1. Add new file paths to `run-full-scan.sh`.
2. For each flag, read the surrounding component before touching anything —
   check whether a real destination, an existing toast/flash mechanism, or an
   existing piece of state already exists nearby that the button should be
   wired to, rather than defaulting to a generic acknowledgment.
3. Never fabricate fake data or a fake success state to make a button "work."
   Every fix in this pass either wired a button to something genuinely real,
   or gave an honest, sandbox-aware acknowledgment of what it will do once
   live — matching the tone each file had already established elsewhere
   (search the file for existing `flash(`/`notify(`/`action(` calls first).
4. Run `run-full-scan.sh` before and after your change to confirm the fix
   landed and nothing else regressed.
5. Always run the full verification before committing:
   ```bash
   npm run build && node --test tests/*.test.mjs && npm run lint
   ```
   `tests/*.test.mjs` are static source-text checks, not runtime execution —
   they will not catch a broken button, a missing CSS class, or a React
   Compiler memoization error. `npm run build` and `npm run lint` are what
   actually catch those.
