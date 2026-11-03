#!/bin/sh
# Container entrypoint — decides WHERE this service's secrets come from.
#
#   SECRETS_SOURCE=platform   (DEFAULT) exec the app unchanged. The platform's own
#                             environment variables stay the only source, so this
#                             file is a no-op until someone flips the switch.
#
#   SECRETS_SOURCE=infisical  fetch this service's secrets from our vault at start
#                             and exec the app under `infisical run`, which injects
#                             them into the app's environment for the process
#                             lifetime only. Nothing is written to disk.
#
# FAIL-CLOSED in infisical mode: a missing variable, a failed login, an unreachable
# API or an empty secret set aborts the container (exit 1). There is deliberately NO
# fallback to the platform environment — a half-configured service must not come up
# quietly on stale values, and `infisical run` itself has no zero-secret guard
# (packages/cmd/run.go:149-173 fetches, logs the count and executes regardless), so
# the guard has to live here.
#
# Nothing in this file ever logs a secret value: variable NAMES and a COUNT only.
#
# Required in infisical mode:
#   INFISICAL_API_URL                        e.g. https://vault.getaim.ai/api
#   INFISICAL_PROJECT_ID                     vault project holding this service
#   INFISICAL_SECRET_PATH                    folder for THIS service, e.g. /line-by-line
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_ID       machine identity scoped to that folder
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET   ditto
# Optional:
#   INFISICAL_ENV                            environment slug, default "prod"
#
# The CLI reads INFISICAL_API_URL and the universal-auth client id/secret straight
# from the environment (docs: infisical.com/docs/cli/commands/login § environment
# variables), so no credential is ever passed on a command line — there is nothing
# for another process in the container to read out of `ps`.

set -eu

log() {
    echo "[entrypoint] $*" >&2
}

die() {
    log "FATAL: $*"
    exit 1
}

SECRETS_SOURCE="${SECRETS_SOURCE:-platform}"

case "$SECRETS_SOURCE" in
    platform)
        log "SECRETS_SOURCE=platform — using the platform environment as-is"
        exec "$@"
        ;;
    infisical)
        : # handled below
        ;;
    *)
        die "unknown SECRETS_SOURCE='${SECRETS_SOURCE}' (expected 'platform' or 'infisical')"
        ;;
esac

# ------------------------------------------------------------------ infisical --

INFISICAL_ENV="${INFISICAL_ENV:-prod}"

missing=""
for name in \
    INFISICAL_API_URL \
    INFISICAL_PROJECT_ID \
    INFISICAL_SECRET_PATH \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID \
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
do
    if [ -z "$(printenv "$name" 2>/dev/null || true)" ]; then
        missing="${missing} ${name}"
    fi
done
if [ -n "$missing" ]; then
    die "SECRETS_SOURCE=infisical but these variables are unset or empty:${missing}"
fi

command -v infisical >/dev/null 2>&1 || die "infisical CLI not found on PATH"

# Any token inherited from the platform is dropped on purpose: in this mode the
# only token allowed is the one the login below mints for this identity.
unset INFISICAL_TOKEN || true
export INFISICAL_DISABLE_UPDATE_CHECK=true

log "authenticating to ${INFISICAL_API_URL} (universal-auth machine identity)"
if ! INFISICAL_TOKEN="$(infisical login --method=universal-auth --silent --plain 2>/dev/null)"; then
    die "universal-auth login failed — bad credentials, or API unreachable at ${INFISICAL_API_URL}"
fi
if [ -z "$INFISICAL_TOKEN" ]; then
    die "universal-auth login returned an empty token"
fi
export INFISICAL_TOKEN

# Pre-flight: how many secrets does this identity actually see at this path?
# `infisical export --format=json` marshals a JSON ARRAY of {Key,Value,...}
# (packages/cmd/export.go:365-373), so len() is the secret count. The value list
# is piped straight into node and never bound to a shell variable; only the
# count leaves this pipeline. An unexpected shape fails closed rather than
# reporting a wrong number.
secret_count="$(
    infisical export \
        --format=json \
        --projectId="$INFISICAL_PROJECT_ID" \
        --env="$INFISICAL_ENV" \
        --path="$INFISICAL_SECRET_PATH" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}if(!Array.isArray(d))process.exit(1);console.log(d.length)})' 2>/dev/null
)" || secret_count=""

case "$secret_count" in
    "" | *[!0-9]*)
        die "could not read secrets at ${INFISICAL_SECRET_PATH} (env=${INFISICAL_ENV}) — fetch failed, token rejected, or unexpected response shape"
        ;;
esac
if [ "$secret_count" -eq 0 ]; then
    die "0 secrets at ${INFISICAL_SECRET_PATH} (env=${INFISICAL_ENV}) — refusing to start on an empty secret set"
fi

log "loaded ${secret_count} secrets from ${INFISICAL_SECRET_PATH} (env=${INFISICAL_ENV}); starting the app"
exec infisical run \
    --projectId="$INFISICAL_PROJECT_ID" \
    --env="$INFISICAL_ENV" \
    --path="$INFISICAL_SECRET_PATH" \
    -- "$@"
