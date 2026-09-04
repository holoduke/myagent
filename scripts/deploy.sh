#!/usr/bin/env bash
# Deploy the backend and/or frontend to Coolify from this machine (no GitHub Actions).
#
#   scripts/deploy.sh            # backend + frontend, current HEAD of main on GitHub
#   scripts/deploy.sh backend    # backend only
#   scripts/deploy.sh frontend   # frontend only
#   scripts/deploy.sh --force    # force rebuild (no docker cache)
#
# Needs ~/.config/myagent/coolify.env with COOLIFY_URL, COOLIFY_TOKEN,
# COOLIFY_APP_UUID and COOLIFY_FRONTEND_APP_UUID. Coolify builds from the
# repository's main branch, so push first. Pushes to main also trigger Coolify's
# own GitHub webhook; this script is for manual/re-deploys.
set -euo pipefail

ENV_FILE="${COOLIFY_ENV_FILE:-$HOME/.config/myagent/coolify.env}"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${COOLIFY_URL:?}" "${COOLIFY_TOKEN:?}" "${COOLIFY_APP_UUID:?}" "${COOLIFY_FRONTEND_APP_UUID:?}"

targets=()
force=false
for arg in "$@"; do
  case "$arg" in
    backend|frontend) targets+=("$arg") ;;
    --force) force=true ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done
[[ ${#targets[@]} -gt 0 ]] || targets=(backend frontend)

deploy() {
  local label="$1" uuid="$2"
  local response code body
  response=$(curl -s -w "\n%{http_code}" -m 30 -X POST \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
    "$COOLIFY_URL/api/v1/deploy?uuid=$uuid&force=$force")
  code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  echo "$label ($uuid): HTTP $code $body"
  [[ "$code" -lt 300 ]]
}

status=0
for t in "${targets[@]}"; do
  if [[ "$t" == backend ]]; then deploy backend "$COOLIFY_APP_UUID" || status=1; fi
  if [[ "$t" == frontend ]]; then deploy frontend "$COOLIFY_FRONTEND_APP_UUID" || status=1; fi
done
exit $status
