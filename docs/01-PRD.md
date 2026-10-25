# 01 · PRD: Product Requirements

**Product:** DealerDoor, a native iOS app for a third-party AT&T authorized dealer selling internet, TV and bundles door-to-door in **SeaTac, WA**.
**Distribution:** App Store, set to **Unlisted** (only people with the direct link can install).
**Operator:** The dealer, not AT&T.

## Problem

Door-to-door sales today run on paper, texts and spreadsheets. Leads get lost, consent records are spotty, reps knock on doors they shouldn't, customers don't know when their install is, dealer invoices get paid late, and nobody measures how reps feel about the job.

## Who it's for

| User | What they need |
|---|---|
| **Customer** (SeaTac resident or property manager) | See order + install status, pay dealer invoices (0–60 day terms), leave feedback after activation |
| **Field sales coworker** | Today's route on a map, do-not-knock warnings, GPS check-in, lead capture with consent, appointment + order, works offline |
| **Team lead** | Assign routes, review flagged addresses and leads, moderate feedback, see crew scores |
| **Office / back office** | Move orders through install → activation, create invoices, maintain catalog and coverage |
| **Admin** | Everything above, plus commissions, users, settings, audit log, individual scorecards |

## Goals and success metrics

| Goal | Metric | Where it's measured |
|---|---|---|
| Digitize door-to-door sales | 90% of leads and orders tracked in-app within 60 days | Admin → Overview |
| Improve close rate | Appointment→order conversion, +10% over baseline | Overview tiles |
| Faster dealer cash flow | ≥70% of dealer invoices paid within terms; median ≤35 days; overdue <15% | Overview tiles |
| Close the feedback loop | ≥40% post-install feedback; average ≥4.2 | Overview tiles |
| Coworker retention | Pulse response ≥60%; 90-day score flat or up | Overview + Scorecards |
| Local + compliant | 100% of leads with TCPA record; 0 do-not-knock check-ins; all addresses checked against SeaTac polygon | Overview → compliance tiles |
| Distribution | ≥95% of invited users install within 7 days | App Store Connect analytics |

## In scope (v1)

1. Full door-to-door timeline: route → knock → interest → qualification → appointment → order → install scheduled → installed → activated → invoice paid → closed.
2. SeaTac polygon check, do-not-knock list (at route assignment **and** check-in), permit reference, TCPA + door-to-door disclosure capture, English + Spanish.
3. Offline-first lead capture, consent and check-in with queued sync.
4. Product catalog (internet tiers, TV, bundles, add-ons) with serviceability by ZIP/street.
5. Dealer-billed invoices with Net 0/15/30/45/60 terms, card + ACH via processor SDK, reminders at T-3, T0, T+7, T+30.
6. Customer feedback tab (4 ratings, comment ≤1,000 chars, optional photo), admin moderation.
7. Coworker pulse (weekly, 3 questions, anonymous by default), kudos tied to a route or order, scorecards.
8. Web admin console for leads, office and admins.

## Out of scope (v1)

- Processing AT&T recurring service charges (AT&T bills those; the app says so on every money screen).
- Real-time AT&T order system integration (office enters install dates and order refs).
- Android.
- Commission payouts (we estimate and reconcile; payroll pays).

## Compliance guardrails

- Dealer branding only. No AT&T name/logo in the app name or icon without written approval.
- Consent and disclosure text in the seed data is a **placeholder**; counsel must approve before launch.
- Card data never touches dealer servers (PCI SAQ-A).
