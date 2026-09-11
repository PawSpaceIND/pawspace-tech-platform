#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

echo "Running bounded vinext build..."
if command -v timeout >/dev/null; then
  timeout \
    --signal=TERM \
    --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
    "${SITES_BUILD_TIMEOUT:-3m}" \
    "${vinext}" build
else
  # macOS does not ship GNU timeout. Keep the same bounded behaviour through Node, which is already
  # a required project runtime, so `npm run build` and `npm test` behave consistently with Linux CI.
  node "${script_dir}/run-with-timeout.mjs" \
    "${SITES_BUILD_TIMEOUT:-3m}" \
    "${SITES_BUILD_KILL_AFTER:-10s}" \
    "${vinext}" build
fi

# Wrangler 4.131+ removed legacy_env. vinext 0.0.50 still emits it in the generated
# artifact; deleting only this obsolete field preserves Wrangler's former default behavior.
artifact_config="${SITES_PROJECT_ROOT}/dist/server/wrangler.json"
if [[ -f "${artifact_config}" ]]; then
  node -e 'const fs=require("fs");const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p,"utf8"));delete v.legacy_env;fs.writeFileSync(p,JSON.stringify(v));' "${artifact_config}"
fi

"${script_dir}/validate-artifact.sh"
