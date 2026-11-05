# 06 · Implementation Plan

Status key: ✅ built in this repo · 🧪 verified by automated test or browser run · 🙋 needs a person (accounts, legal, Apple)

## Phase 1 · Discovery & schema (weeks 1–2)

- ✅ D1 schema + seed (`worker/migrations`)
- ✅ API contract (`worker/src/routes`, listed in the README)
- ✅ SeaTac polygon (approximate) 🙋 replace with the official King County GIS city-limits polygon (Admin → Settings → Service area)

## Phase 2 · Worker API + D1 (weeks 3–5)

- ✅🧪 Auth: magic link, password, rotating refresh tokens, role guards, deactivation
- ✅🧪 Leads with TCPA + disclosure evidence, out-of-area flagging, idempotent offline replays
- ✅🧪 Do-not-knock at route assignment and check-in; geofenced check-ins; sync conflicts
- ✅🧪 Serviceability by coverage; orders with pricing snapshot, customer account, commission estimate
- ✅🧪 11-stage timeline with ordering rules; customer simplified view

## Phase 3 · Payments (weeks 5–7)

- ✅🧪 Invoices with Net 0/15/30/45/60, draft → sent → viewed → partial → paid → overdue
- ✅🧪 Stripe PaymentIntents (card + ACH) and signed webhook; mock mode for sandbox
- ✅🧪 Cron: overdue marking + T-3/T0/T+7/T+30 reminders, once each
- 🙋 Stripe account; confirm the processor allows these dealer fees; set keys + webhook URL `/v1/webhooks/stripe` (events: `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`)

## Phase 4 · Customer iOS (weeks 6–9)

- ✅ Login (magic link / password), Face ID unlock, push registration + deep links
- ✅ Dashboard, order timeline, invoices + PaymentSheet, feedback tab with photo
- ✅🧪 UI tests tap through every screen in an iPhone simulator on each PR and save screenshots (`ios/DealerDoorUITests`, `.github/workflows/ios.yml`)
- 🙋 First Xcode build on your own Mac: follow [08-MAC-XCODE-SETUP.md](08-MAC-XCODE-SETUP.md)

## Phase 5 · Coworker iOS (weeks 8–11)

- ✅ Route map (SeaTac outline, stops, do-not-knock), GPS check-in
- ✅ Lead capture: consent texts, signature, door photo, offline SwiftData queue with conflict flags
- ✅ Serviceability, appointment, order submit
- ✅ Weekly pulse banner, scorecard with Swift Charts, kudos

## Phase 5b · Android app

- ✅ Same customer and coworker screens as iOS in Kotlin + Jetpack Compose (`android/`), English + Spanish
- ✅ Offline queue, Keystore-encrypted session, fingerprint/screen-lock unlock, Stripe PaymentSheet, OpenStreetMap route map
- ✅🧪 CI builds, lints and unit-tests it, then taps through every screen in an emulator and saves screenshots (`.github/workflows/android.yml`)
- 🙋 Google Play developer account → upload the release build to an internal / closed testing track
- 🙋 App Links: set `ANDROID_CERT_SHA256` (wrangler var) and build with `-PappLinkHost=<your api domain>` so sign-in emails open the app
- 🙋 Push on Android: needs a Firebase project (FCM). Until then Android customers get email updates.

## Phase 6 · Admin dashboard (weeks 10–12)

- ✅🧪 Web console served by the Worker: overview metrics, review queue, routes, DNK, leads, orders/timeline, invoices, feedback moderation, scorecards, commissions, catalog/coverage, users/crews, settings, audit (browser-tested at desktop and phone width)

## Phase 7 · Unlisted submission (week 12) 🙋

1. Apple Developer account → App ID `com.dealerdoor.app` with Push + Associated Domains.
2. Set `DEVELOPMENT_TEAM` in `ios/project.yml`, `applinks:` domain in the entitlements, `API_BASE_URL` for Release.
3. APNs key (.p8) → `wrangler secret put APNS_KEY_P8` (+ `APNS_KEY_ID`, `APNS_TEAM_ID`).
4. Archive in Xcode Cloud → TestFlight → submit with the review notes in [07-LAUNCH-CHECKLIST.md](07-LAUNCH-CHECKLIST.md).
5. After approval: App Store Connect → **App Distribution Methods → Unlisted**. Put the link in `APP_STORE_URL` (wrangler var) so order emails include it.

## Phase 8 · SeaTac pilot (weeks 13–14)

- 3 routes, 10 coworkers, 20 customers. Watch Admin → Overview daily; the compliance tiles must stay at 0.

## Phase 9 · Owner sign-in and maps

- ✅🧪 Two-step sign-in: email link gives a locked level-1 session, password gives level 2; `require_password` per user; lockout after 5 wrong passwords; refresh keeps its level (`worker/test/owner-gate.test.ts`, `e2e/tests/03-owner-gate.spec.ts`)
- ✅🧪 Owner account bootstrapped from the `MASTER_EMAIL` secret (no address in the repo)
- ✅🧪 SMTP client for Workers (465 implicit TLS, 587 STARTTLS, AUTH PLAIN/LOGIN, header-injection guard) with Resend and log-only fallbacks (`worker/test/smtp.test.ts`)
- ✅🧪 Map API `GET /v1/map/points` with per-role scoping, filters, bounding box and limits (`worker/test/map.test.ts`)
- ✅🧪 Leaflet 1.9.4 Map view, order mini-map, "Show on the big map", and the rep phone map `/map.html` (`e2e/tests/04-map.spec.ts`)
- 🙋 Set `MASTER_EMAIL` and the `SMTP_*` secrets in staging and production, verify the sending domain (SPF + DKIM), then set the owner's password on first sign-in
- 🙋 Move off the public OpenStreetMap tile server before the pilot grows (`TILE_URL` in `admin/map-core.js`)
- ⏸ SMS code at sign-in: parked. Twilio Verify is about $0.06 per code and US numbers need carrier registration, so start that paperwork only if you decide to add it. The hook point is `POST /v1/auth/step-up`, which would take a code as well as the password.
- ⏸ Leaflet inside the native apps: parked. They keep MapKit and osmdroid.

## Deploy commands

```bash
cd worker
npx wrangler d1 create dealerdoor-prod --jurisdiction=us        # paste id into wrangler.toml
npx wrangler r2 bucket create dealerdoor-files-prod --jurisdiction=us
npx wrangler secret put JWT_SECRET --env production             # repeat for each secret
npm run db:migrate:prod
npx wrangler deploy --env production
# first admin:
npx wrangler d1 execute DB --remote --env production \
  --command "INSERT INTO users (id, email, role, display_name) VALUES (lower(hex(randomblob(16))), 'you@dealer.com', 'admin', 'Owner')"
```
