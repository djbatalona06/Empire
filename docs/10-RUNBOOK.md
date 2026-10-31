# 10 · Runbook: when something goes wrong

Plain steps for the person on call. Every command runs from the `worker/` folder. Replace `<env>` with `staging` or `production`.

## Is it up?

Open `https://<your api domain>/v1/health`. You should see `"ok": true` with `"db": true` and `"files": true`. If either is false the page returns status 503. Point an uptime monitor (any free one) at this address.

Every response has an `x-request-id` header. When a user reports an error, ask for the `request_id` shown in the error, then search for it under Cloudflare dashboard → Workers → your Worker → Logs.

## Roll back a bad deploy

```bash
npx wrangler deployments list --env <env>   # see recent versions
npx wrangler rollback --env <env>           # go back to the previous version
```

Rolling back the code does not undo database changes. New migrations only add things (tables, columns, indexes), so older code keeps working with them.

## Restore the database (D1 Time Travel)

D1 keeps 30 days of history automatically. Every deploy prints a "restore point" near the top of the log.

```bash
npx wrangler d1 time-travel info DB --env <env>                       # shows the current bookmark
npx wrangler d1 time-travel restore DB --env <env> --timestamp=<ISO time before the mistake>
```

Restoring replaces the whole database with how it looked at that moment, so anything saved after that time is lost. Write down the "previous bookmark" it prints: it lets you undo the restore.

## Secrets

Add or change a secret: `npx wrangler secret put NAME --env <env>`.

| Secret | Needed? | If you change it |
|---|---|---|
| `JWT_SECRET` | Required, 32+ characters (the API refuses to start if missing or short) | Everyone is signed out once. Do this if you think it leaked. |
| `FILE_SIGNING_SECRET` | Optional (falls back to `JWT_SECRET`) | Photo links already handed out stop working (they last 15 minutes anyway). |
| `PULSE_HASH_SECRET` | Optional (falls back to `JWT_SECRET`) | **Do not change after launch.** Old weekly check-in answers would no longer match their owners, and people could answer twice in a week. To move away from `JWT_SECRET` safely, set it before the first real check-in. |
| `STRIPE_*`, `RESEND_API_KEY`, `APNS_*` | See the launch checklist | Put the new value, then deploy. |

Generate a good one with `openssl rand -base64 48`.

## Deploying to production

1. Staging deploys by itself when something merges into `main`. Check staging first.
2. GitHub → Actions → "Worker API" → Run workflow → pick `production` (only works from `main`).
3. The pipeline checks the secret exists, prints the database restore point, applies migrations, deploys, then calls `/v1/health`. Set the repository variables `STAGING_API_URL` and `PRODUCTION_API_URL` so that last check runs.

## Someone is locked out

- Staff member: an admin opens Users and sets them active again, then they ask for a new sign-in link.
- The only admin is locked out: the API will not let the last active admin be removed, but if it ever happens, run the first-admin command in `docs/06-IMPLEMENTATION-PLAN.md` ("Deploy commands").
