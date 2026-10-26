# 03 · App Flow

## Sign-in (everyone)

```mermaid
flowchart LR
  A[Open app] --> B{Saved session?}
  B -- yes --> C[Face ID / fingerprint / passcode] --> D{Role}
  B -- no --> E[Enter email] --> F[Email with magic link] --> G[Tap link on the phone<br/>universal link / App Link opens app] --> D
  E -. optional .-> P[Password] --> D
  D -- customer --> CU[Customer tabs]
  D -- coworker / lead / office / admin --> CW[Coworker tabs]
```

Desktop staff click the same link and land in the **admin console** (`/auth/verify` → `/#magic=…`).

## Customer: 3 tabs

| Tab | Screen | Actions |
|---|---|---|
| **My order** | Order cards: status, install date, "Invoice due" badge | Tap → **Order timeline**: Order received → Install scheduled → Installed → Activated → Feedback available. Plan + "AT&T bills separately" notice |
| **Invoices** | List with balance, due date, status | Tap → **Invoice**: amount, paid, balance, terms, payments → **Pay with card** or **Pay from bank (ACH)** → Stripe sheet → back to invoice |
| **Feedback** | Locked until activation | 4 star ratings + comment (≤1,000) + optional photo → submit → "pending" until moderated. Shows public average rating |

Push notifications deep-link into the right tab (`screen`: timeline / invoice / feedback).

## Coworker: 3 tabs + banner

```mermaid
flowchart TD
  R[Route map<br/>SeaTac outline, stops, red do-not-knock hands] --> S[Tap stop]
  S -->|do-not-knock| X[Skip this address]
  S --> CI{Check in<br/>GPS must be within 100 m}
  CI -- no answer / not interested / come back --> R
  CI -- interested --> L[Lead capture]
  L --> L1[Address + customer + interest + photo]
  L1 --> L2[Read disclosure + TCPA aloud<br/>two toggles + signature]
  L2 --> Q[(Offline queue)]
  Q -- online --> API[(API)]
  API -- refused: DNK / too far --> CF[Flagged: sent to team lead]
  LD[Lead detail] --> SV[Check serviceability] --> AP[Book appointment] --> OR[Submit order]
```

| Tab | Screens |
|---|---|
| **Route** | Map, route picker, progress "3 of 12 doors · Permit …", sync chip (offline / queued / flagged) |
| **Leads** | "Waiting to sync" section (with flagged items + reason), my leads → lead detail (serviceability, appointment, order) |
| **Me** | 90-day sales stats, my pulse trend chart, crew average (hidden until 3+ answers), kudos, "Give kudos" |
| Banner | "Weekly check-in: 3 quick questions" → pulse sheet (anonymous toggle, optional named follow-up) |

## Admin console (web)

Sidebar sections, shown by role:

| Section | Lead | Office | Admin | What happens |
|---|---|---|---|---|
| Overview | ✓ | ✓ | ✓ | Success-metric tiles with targets |
| Review queue | ✓ | | ✓ | Approve/deny out-of-area addresses; resolve sync conflicts |
| Routes | ✓ | | ✓ | Paste addresses → geocode → DNK removed → assign rep + date + permit |
| Do-not-knock | ✓ | ✓ | ✓ | Add (also pulls address off future routes); admin can remove |
| Leads | ✓ (crew) | ✓ | ✓ | Search + filter |
| Orders | ✓ (crew) | ✓ | ✓ | Order dialog: update each timeline stage, notes, AT&T ref, cancel, create invoice |
| Invoices | | ✓ | ✓ | List, send drafts |
| Feedback | ✓ | | ✓ | Approve / reject with internal note |
| Scorecards | | | ✓ | Crew aggregates, people sales, named pulse responses |
| Commissions | | | ✓ | Reconcile actual vs estimate (required before closing an order) |
| Catalog & coverage | | ✓ | ✓ | Rate card items, ZIP/street coverage |
| Users & crews | | | ✓ | Add users, deactivate (revokes sessions) |
| Settings | ✓ (view) | | ✓ | Permit ref, default terms, consent version, geofence, stale-lead days, service-area polygon |
| Audit log | | | ✓ | Every admin action |

## Order stage rules

- Stages complete **in order**. "Invoice paid" may complete any time (auto-completes when all invoices are paid) but must be done before **Closed**.
- **Install scheduled** needs a date/time. **Activated** unlocks customer feedback and sends the "How did we do?" push.
- **Closed** is admin-only and requires a reconciled commission.
