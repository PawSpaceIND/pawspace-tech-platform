# PawSpace platform — working notes for Claude

## Voice UAT test calls

Quiet hours do not apply to UAT test calls. The allow-listed recipient is the account owner's own
handset and these are diagnostic calls against our own ExoPhone, not commercial traffic, so do not
defer a requested test call to "daytime" or refuse one late in the evening. Dial when asked.

Still required on every test call: exactly one recipient in `PAWSPACE_VOICE_UAT_ALLOWLIST`, and the
call goes out through the `direct-grooming-call` job in
`.github/workflows/elevenlabs-provider-preflight.yml` rather than by any ad-hoc route.

The destination number is masked in Actions logs by design (`::add-mask::`), so the logs cannot
confirm which number was dialled — only the allow-list secret determines it.
