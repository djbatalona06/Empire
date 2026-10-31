# 02 · TRD: Technical Requirements

## Stack

| Layer | Choice | Why |
|---|---|---|
| iOS app | **SwiftUI, iOS 17+**, Observation, SwiftData, MapKit, Swift Charts | Native, offline-capable, no WebView |
| Android app | **Kotlin + Jetpack Compose**, Android 8+ (API 26), OkHttp, kotlinx.serialization, OpenStreetMap (osmdroid), Keystore-encrypted tokens, file-backed offline queue | Same screens and API as iOS; no Google Maps key needed |
| Payments (device) | **Stripe PaymentSheet** (iOS: SPM `StripePaymentSheet`; Android: `com.stripe:stripe-android`) | Tokenizes card/bank on device → PCI SAQ-A |
| API | **Cloudflare Worker**, TypeScript, **Hono** router | Edge latency from SeaTac, one deploy unit |
| Database | **Cloudflare D1** (SQLite), `us` jurisdiction | Bound to the Worker only, no public endpoint |
| Files | **Cloudflare R2** (private), US jurisdiction | Door photos, signatures, install + feedback photos |
| Scheduling | **Cron Trigger** `0 16 * * *` (9 AM Pacific, daylight time) | Overdue marking, payment reminders, stale leads, token cleanup |
| Push | **APNs** HTTP/2 with ES256 provider token (iOS). Android: email only for now; FCM is a follow-up | Install updates, payment reminders, feedback request |
| Email | **Resend** API | Magic links, order confirmation |
| Geocoding | US Census geocoder (free, no key) on the server; `CLGeocoder` / Android `Geocoder` on device | Turn route addresses into coordinates |
| Admin console | Static HTML + CSS + JS served by the same Worker (`[assets]`) | No build step, same API |
| CI/CD | GitHub Actions: test → migrate → deploy. iOS: compile + XCUITest in a simulator. Android: build + lint + unit tests + emulator UI tests. Playwright: admin console + app API flow. Screenshots go to the `ci-shots` branch | Matches spec section 12 |

## Non-functional targets

| Requirement | How it's met |
|---|---|
| API p95 < 300 ms | Edge Worker + D1 indexed queries; one D1 read per request for auth |
| Cold start < 2 s | Single small bundle, Hono (~14 KB) is the only runtime dependency |
| 99.9% uptime | Cloudflare Workers SLA |
| TLS 1.3 | Cloudflare edge default (set minimum TLS 1.3 in the zone) |
| Auth | HS256 access JWT (1 h) + rotating refresh token (30 d, stored hashed) |
| D1 only via Worker | No D1 HTTP API tokens issued to clients |
| R2 private | Worker-signed URLs (HMAC, 15 min) for PUT and GET |
| US residency | D1 created with `--jurisdiction=us`; R2 buckets created with `--jurisdiction=us` (binding declares it). Cloudflare offers a US jurisdiction, not a US-West-only one; Worker requests still run at the edge nearest SeaTac |
| Accessibility | Dynamic Type (system fonts), VoiceOver labels on map pins, ratings, signature pad |
| Rate limiting | Workers Rate Limiting bindings: sign-in 10 per minute per IP+email; every other write to `/v1` 300 per minute per signed-in token (so an office sharing one connection does not throttle itself) |
| Observability | Workers Logs on; every response has `x-request-id`; errors log one JSON line with the same id; `/v1/health` checks D1 and R2 (503 if either fails). See [10-RUNBOOK.md](10-RUNBOOK.md) |

## API conventions

- Base path `/v1`, JSON in and out, errors as `{ "error": "code", "message": "..." }`.
- Offline-created records (leads, check-ins, appointments, orders) take a **client UUID** `id`; replaying the same request returns the existing record instead of duplicating it.
- Business-rule refusals of offline captures (do-not-knock, out of geofence) return 403/422 **and** create a `sync_conflicts` row for admin review.
- No client-supplied customer IDs: customer-scoped queries always use the JWT subject.

## Secrets

`JWT_SECRET` (32+ characters, the API refuses to start without it), optional `FILE_SIGNING_SECRET` and `PULSE_HASH_SECRET` (each falls back to `JWT_SECRET`), `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, set with `wrangler secret put NAME --env staging|production`. Missing push/email keys turn those features into logged no-ops. A missing Stripe key outside production switches to an instant "mock" settlement so flows can be tested.

## Environments

`development` (local, `wrangler dev`), `staging` and `production`. Each has its own D1 database, R2 bucket and rate-limit namespace (`wrangler.toml`).
