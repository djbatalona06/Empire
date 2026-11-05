# 09 · Ship status

One page that says what is finished, what has been proven by a test, and what is still waiting on a person.
Last updated with the owner sign-in and Leaflet maps work.

Key: ✅ built · 🧪 proven by an automated test · 🙋 needs a person (an account, a decision, a legal sign-off) · ⏸ parked on purpose

## What is built

| Part | Built | Proven | Notes |
|---|---|---|---|
| API (Worker + D1 + R2) | ✅ | 🧪 72 API tests | Includes the two-step sign-in, SMTP client and map data |
| Owner two-step sign-in | ✅ | 🧪 12 API tests + browser test | Email link opens a locked screen; password unlocks data; 5 wrong tries lock for 15 min |
| Email by SMTP | ✅ | 🧪 12 tests against a fake mail server | Never run against a real mail server yet (see below) |
| Admin console | ✅ | 🧪 browser tests at 1280 px and phone width | 15 sections including Map |
| Leaflet maps (admin Map, order mini-map, phone map) | ✅ | 🧪 browser tests with real pins | Map tiles are stubbed in tests |
| iPhone app | ✅ | 🧪 on CI (macOS runner) | Not run in this session. See "Owner on the phone apps" |
| Android app | ✅ | 🧪 on CI (Linux runner) | Not run in this session. Same note |
| Payments (Stripe) | ✅ | 🧪 in mock mode | Real keys not set |
| Push (APNs) | ✅ | | Needs Apple keys. Android push (FCM) is still a follow-up |

## What only a person can do

| # | Step | Where / command |
|---|---|---|
| 1 | Create the production database and file bucket | `docs/06-IMPLEMENTATION-PLAN.md` → "Deploy commands", then paste the IDs into `worker/wrangler.toml` |
| 2 | Set the secrets | `npx wrangler secret put <NAME> --env production` for `JWT_SECRET`, `MASTER_EMAIL`, `SMTP_*`, `STRIPE_*`, `APNS_*` (list: `docs/10-RUNBOOK.md`) |
| 3 | Verify your sending domain so magic links do not land in spam | Your mail provider's dashboard: add the SPF and DKIM records they show |
| 4 | Deploy, then sign in as the owner **right away** and create the password | GitHub → Actions → "Worker API" → Run workflow → `production` |
| 5 | Replace placeholders: consent text, catalog prices, SeaTac boundary, do-not-knock list | `docs/07-LAUNCH-CHECKLIST.md` |
| 6 | Counsel approves the consent and disclosure text | `docs/07-LAUNCH-CHECKLIST.md` → Legal & brand |
| 7 | Apple Developer and Google Play accounts, then submit | `docs/06-IMPLEMENTATION-PLAN.md` Phase 7, `docs/08-MAC-XCODE-SETUP.md` |
| 8 | Switch map tiles to a hosted provider before many people use the map | `TILE_URL` in `admin/map-core.js` |

## Known limits (said plainly)

- **SMTP has only been tested against a pretend mail server.** The first real send is step 4 above. If it fails, search the logs for `email_failed`: it names the reason without printing the password.
- **Owner on the phone apps.** The iPhone and Android apps have no password screen yet. The owner should use "Sign in with a password" there (after creating the password in the console). A link-only sign-in in the apps gives a locked session and the app shows errors. Everyone else signs in as before.
- **First owner password.** Until it exists, whoever can read the owner's mailbox can set it. Do step 4 right after deploying.
- **No SMS.** Parked. See `docs/06-IMPLEMENTATION-PLAN.md` Phase 9 for what it would take.
- **Public map tiles.** Fine for a pilot, not for heavy use.
- **Native apps keep their own maps** (MapKit and osmdroid); Leaflet is in the web console and the phone web page.

## How it works (so you can change it yourself)

**A sign-in has a trust level.** Opening the emailed link proves you can read the mailbox (level 1). Typing the password proves you are you (level 2). The level is written inside the sign-in token (`aal`), and one function, `requireAuth` in `worker/src/lib/auth.ts`, turns level 1 away from every route that returns real data. That is why adding a new data route needs no extra work to be protected: it is protected the moment it uses `requireAuth`.

**Why the link is "one use" and stored hashed.** Mail scanners click links before people do. The link in the email only redirects; the token is spent by the page's `POST /v1/auth/verify`. The database holds a fingerprint (SHA-256) of the token, never the token itself.

**How the map decides what to show.** `GET /v1/map/points` asks the database for the pins inside the part of the map on screen. `staffScope` in `worker/src/lib/scope.ts` limits rows by who is asking: a rep sees their own, a team lead their crew, office and admin everyone. The browser draws pins with Leaflet (`admin/map-core.js`), and merges nearby ones into numbered bubbles with the markercluster plugin.

**Try it yourself.**

1. In `admin/map-core.js`, change a color in `LEAD_COLORS` (for example `interested`). Reload the Map view and watch the dots change.
2. In `worker/test/owner-gate.test.ts`, change the lockout test to expect a lock after 3 wrong passwords, watch it fail, then change `MAX_FAILED_PASSWORDS` in `worker/src/routes/auth.ts` to 3 and watch it pass. That is the red-then-green loop this whole project was built with.
