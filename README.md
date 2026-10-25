# Empire · DealerDoor

Door-to-door sales system for a third-party AT&T authorized dealer in SeaTac, WA.

| Part | Folder | What it is |
|---|---|---|
| API | [`worker/`](worker) | Cloudflare Worker (TypeScript + Hono), D1 database, R2 files, daily cron, APNs push |
| Admin console | [`admin/`](admin) | Plain HTML / CSS / JS, served by the same Worker at `/` |
| iOS app | [`ios/`](ios) | Native SwiftUI app (iOS 17+) for customers and field coworkers |
| Planning docs | [`docs/`](docs) | 01 PRD · 02 TRD · 03 App Flow · 04 UI/UX · 05 Schema · 06 Implementation Plan · 07 Launch Checklist |

## Run it locally (5 minutes)

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npx wrangler d1 execute DB --local --file seed/dev.sql   # demo users + a route
npm run dev                                             # http://localhost:8787
```

Open http://localhost:8787 and sign in as `admin@dealerdoor.test`. In development the magic link is skipped automatically.
Demo users: `admin@`, `office@`, `lead@`, `rep1@`, `rep2@` (all `@dealerdoor.test`).

```bash
npm test          # 21 end-to-end API tests on a real local D1
npm run typecheck
```

iOS: on a Mac, `brew install xcodegen && cd ios && xcodegen && open DealerDoor.xcodeproj`. Debug builds talk to `http://localhost:8787`.

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

## Before launch

Read [`docs/07-LAUNCH-CHECKLIST.md`](docs/07-LAUNCH-CHECKLIST.md). The consent text, catalog prices and SeaTac boundary in the seed data are **placeholders**.
