#!/usr/bin/env bash
# Trigger a remote deploy on Render via the Render API.
#
# Requires:
#   RENDER_API_KEY     Render API key (Account Settings -> API Keys)
#   RENDER_SERVICE_ID  Service id (dashboard URL has it, e.g. srv-xxxx, or:
#                      curl -H "Authorization: Bearer $RENDER_API_KEY" \
#                        https://api.render.com/v1/services)
#
# Usage:
#   scripts/deploy-render.sh                      # deploy latest of linked branch
#   scripts/deploy-render.sh srv-abc123           # deploy a specific service
#   scripts/deploy-render.sh --commit <sha>       # deploy a pinned commit
#   scripts/deploy-render.sh --clear-cache        # clear build cache then deploy
set -euo pipefail

KEY="${RENDER_API_KEY:-}"
SERVICE="${RENDER_SERVICE_ID:-}"
COMMIT=""
CLEAR_CACHE="do_not_clear"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --clear-cache) CLEAR_CACHE="clear"; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) SERVICE="$1"; shift ;;
  esac
done

if [[ -z "$KEY" ]]; then
  echo "Missing RENDER_API_KEY" >&2
  exit 2
fi
if [[ -z "$SERVICE" ]]; then
  echo "Missing RENDER_SERVICE_ID (pass as arg or set RENDER_SERVICE_ID)" >&2
  exit 2
fi

BODY="{\"clearCache\":\"${CLEAR_CACHE}\""
if [[ -n "$COMMIT" ]]; then
  BODY+=",\"commitId\":\"${COMMIT}\""
fi
BODY+="}"

echo "Triggering deploy on Render service $SERVICE (clearCache=$CLEAR_CACHE${COMMIT:+, commit=$COMMIT})"
RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer $KEY" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "https://api.render.com/v1/services/${SERVICE}/deploys")

echo "$RESPONSE"
case "$RESPONSE" in
  *'"id"'*) echo "Deploy started." ;;
  *'"message"'*) echo "Render reported an error (see above)." >&2; exit 1 ;;
  *) echo "Unexpected response (see above)." >&2; exit 1 ;;
esac