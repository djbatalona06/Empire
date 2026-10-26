#!/usr/bin/env bash
# Boots the Worker locally with a fresh-enough demo database. Used by Playwright and the iOS UI-test job.
set -euo pipefail
cd "$(dirname "$0")/../worker"
[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local > /dev/null
npx wrangler d1 execute DB --local --file seed/dev.sql > /dev/null
exec npx wrangler dev --port 8787
