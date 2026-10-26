# Empire · DealerDoor

Door-to-door sales system for a third-party AT&T authorized dealer in SeaTac, WA.
Customers track their install, pay dealer fees and leave feedback. Field reps walk a route, check in at each door, sign up customers (with consent and a signature) and see their scorecard. Office staff and admins run everything from a web console.

| Part | Folder | What it is |
|---|---|---|
| API | [`worker/`](worker) | Cloudflare Worker (TypeScript + Hono), D1 database, R2 files, daily cron, APNs push, Stripe |
| Admin console | [`admin/`](admin) | Plain HTML / CSS / JS, served by the same Worker at `/` |
| iPhone app | [`ios/`](ios) | Native SwiftUI (iOS 17+), XcodeGen project, XCUITest smoke tests |
| Android app | [`android/`](android) | Native Kotlin + Jetpack Compose (Android 8+), Gradle, Compose UI tests |
| Browser + API tests | [`e2e/`](e2e) | Playwright: admin console at desktop and phone width, plus the API flow both apps use |
| CI helpers | [`ci/`](ci) | Publishes test screenshots to the `ci-shots` branch |
| Planning docs | [`docs/`](docs) | 01 PRD · 02 TRD · 03 App Flow · 04 UI/UX · 05 Schema · 06 Implementation Plan · 07 Launch Checklist · 08 Mac setup |

## What each app does

Both phone apps have the same screens and talk to the same API. Sign-in picks the experience from the account's role.

| Customer | Field coworker (rep, lead, office, admin) |
|---|---|
| **My order**: install timeline in 5 simple steps, plan and prices | **Route**: map of today's doors, SeaTac outline, do-not-knock pins, permit number |
| **Invoices**: dealer fees, Net 0–60 terms, pay by card or bank (Stripe) | **Door check-in**: no answer / not interested / come back / interested, verified by GPS |
| **Feedback**: 4 star ratings, comment and photo, after activation | **Lead capture**: contact, interests, door photo, disclosure + TCPA consent, signature |
| | **Leads**: serviceability, appointment, submit order, offline queue with conflict flags |
| | **Me**: 90-day stats, weekly check-in trend, crew average, kudos |

Shared: magic-link or password sign-in, Face ID / fingerprint unlock, works offline in the field, English and Spanish.

| | iPhone | Android |
|---|---|---|
| UI | SwiftUI | Jetpack Compose (Material 3) |
| Map | MapKit | OpenStreetMap (osmdroid), no API key |
| Offline queue | SwiftData | JSON file + photo files in app storage |
| Session storage | Keychain | Android Keystore (AES-GCM) |
| Sign-in links | Universal links | App Links (`/.well-known/assetlinks.json`) + `dealerdoor://` |
| Push | APNs | Not yet (needs Firebase). Customers get email instead |

## Run it locally

**1 · API + admin console** (any computer with Node 22)

```bash
cd worker && npm ci && cd ..
e2e/start-api.sh            # migrates, loads demo data, serves http://localhost:8787
```

Open http://localhost:8787 and sign in as `admin@dealerdoor.test`. In development the magic link is skipped automatically.

Demo users (all `@dealerdoor.test`): `admin@`, `office@`, `lead@`, `rep1@`, `rep2@`. For a customer with an order and invoices, run once:

```bash
cd e2e && npm ci && npm run seed:customer   # adds customer@dealerdoor.test
```

**2 · iPhone app** (Mac with Xcode)

```bash
brew install xcodegen
cd ios && xcodegen && open DealerDoor.xcodeproj   # ⌘R to run, ⌘U for UI tests
```

Debug builds talk to `http://localhost:8787`.

**3 · Android app** (Android Studio, any OS)

Open the `android` folder in Android Studio and press ▶ Run, or:

```bash
cd android && ./gradlew installDebug              # emulator: reaches your computer at 10.0.2.2:8787
./gradlew installDebug -PapiBaseUrl=http://<your-computer-ip>:8787   # real phone on the same Wi-Fi
./gradlew connectedDebugAndroidTest               # UI tests on a running emulator
```

Full step-by-step for a new Mac: [docs/08-MAC-XCODE-SETUP.md](docs/08-MAC-XCODE-SETUP.md).

## Tests

```bash
cd worker && npm test && npm run typecheck        # 22 end-to-end API tests on a real local D1
cd e2e && npx playwright test                     # admin console (desktop + phone) and the app API flow
cd android && ./gradlew testDebugUnitTest lintDebug
```

## CI (every pull request)

| Workflow | Runs on | What it checks |
|---|---|---|
| `Worker API` | Linux | Typecheck, API tests, Playwright e2e. Deploys `main` to staging (production by manual run) |
| `iOS app` | macOS | Compiles, then runs the app in an iPhone simulator and taps through every screen |
| `Android app` | Linux | Builds, lints, unit tests, then runs the app in an Android emulator and taps through every screen |

Each UI-test job saves a screenshot of every screen and pushes them to the [`ci-shots`](../../tree/ci-shots) branch under `pr-<number>/ios`, `android`, `admin-desktop` and `admin-phone`. The run's **Summary** tab has a pass/fail table. The Android debug APK is attached to each `Android app` run.

## API map (`/v1`)

| Area | Endpoints |
|---|---|
| Auth | `POST auth/login` (magic link or password) · `auth/verify` · `auth/refresh` · `auth/logout` · `auth/password` · `GET/PATCH me` · `POST devices` |
| Field | `GET routes/mine` · `service-area` · `dnk/map` · `POST properties/validate` · `POST check-ins` |
| Leads | `GET/POST leads` · `GET/PATCH leads/:id` · `POST leads/:id/serviceability` · `POST appointments` · `PATCH appointments/:id` |
| Orders | `GET/POST orders` · `GET/PATCH orders/:id` · `GET orders/:id/timeline` · `PATCH timeline/:id` |
| Money | `GET/POST invoices` · `GET/PATCH invoices/:id` · `POST invoices/:id/send` · `POST invoices/:id/pay` · `POST webhooks/stripe` |
| Feedback | `POST feedback/customer` · `GET feedback/customer/mine` · `GET feedback/summary` · `GET feedback/customer` · `PATCH feedback/customer/:id/status` |
| People | `GET pulse/status` · `POST pulse` · `POST kudos` · `GET coworkers` · `GET scorecards/me` · `GET scorecards/crew` · `GET admin/scorecards` |
| Files | `POST uploads` · `POST files/sign` · `PUT/GET files/*` (signed) · `GET catalog` · `GET consent-texts` |
| Admin | `admin/users` · `crews` · `routes` · `dnk` · `properties` · `service-area` · `catalog` · `coverage` · `commissions` · `conflicts` · `settings` · `audit` · `metrics` |

Outside `/v1`: `GET /auth/verify` (magic-link landing), `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json`.

## Before launch

Read [`docs/07-LAUNCH-CHECKLIST.md`](docs/07-LAUNCH-CHECKLIST.md). The consent text, catalog prices and SeaTac boundary in the seed data are **placeholders**. App Store and Google Play steps are listed there too.
