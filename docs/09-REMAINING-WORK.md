# 09 · Remaining Work

One list of everything still to build, fix or do before launch. Sizes: **S** = under a day, **M** = 1–3 days, **L** = a week or more.

Who does it: 🛠 code (can be built in this repo) · 🙋 needs a person (accounts, legal, data) · 🔎 check first, then decide.

## A. Code to build

| # | Item | Size | Notes |
|---|---|---|---|
| A1 | ✅ **Privacy policy page** at `/privacy` (draft text), linked from the admin console and from both phone apps' sign-in screens | S | Both app stores require a URL. Text must be approved by counsel (see C-Legal). |
| A2 | 🛠 **Account deletion**: endpoint that erases or anonymizes a customer's personal data, plus a "Delete my account" screen on iPhone and Android | M | 🔎 First confirm whether Apple/Google rules apply, since accounts are created by admins. Keep invoices and consent records that the law requires. |
| A3 | 🛠 **Customer cancellation** (3-business-day window): customer-facing request screen, API route, and a review step in the admin Orders dialog | M | Today only office/admin can cancel, and never after activation. Wording needs counsel (C-Legal). |
| A4 | 🛠 **Android push**: register Android devices, send through FCM from the Worker, show notifications | L | Needs a Firebase project first (C-Accounts). |
| A5 | 🛠 **Android notification links**: tapped notification opens Order timeline / Invoice / Feedback tab, like iPhone | S | Depends on A4. |
| A6 | 🛠 **Admin two-step sign-in** (extra code for admin and office roles) | M | The console can see consent records, payments and personal data. |
| A7 | ✅ **CSV export** for leads, orders, invoices (office, admin) and commissions (admin) in the admin console | S | Payroll reconciliation and bookkeeping. Team leads are not offered leads/orders because their normal view is limited to their own crew. |

## B. Docs to fix

- [x] B1 `06-IMPLEMENTATION-PLAN.md`: Phase 0 and Phase 9 added.
- [x] B2 `03-APP-FLOW.md`: rule-stop table, Android push status, cancellation status, exports and privacy added. (Update again when A3 ships.)
- [x] B3 `07-LAUNCH-CHECKLIST.md`: privacy policy URL and draft, account-deletion decision, Firebase note added.
- [x] B4 `README.md`: docs table (09 and 10), export route, `/privacy` and health added.
- [ ] B5 `04-UI-UX-BRIEF.md` (export button and privacy page done) and `05-BACKEND-SCHEMA.md`: add the screens and tables that A2, A3 and A6 introduce when they ship.

## C. Needs a person

### Accounts and keys
- [ ] Stripe account, keys, and webhook `/v1/webhooks/stripe` (events: `payment_intent.succeeded`, `.processing`, `.payment_failed`). Confirm the processor allows these dealer fees.
- [ ] Apple Developer account, App ID `com.dealerdoor.app` (Push + Associated Domains), APNs key, set `DEVELOPMENT_TEAM`, `applinks:` domain, release `API_BASE_URL`.
- [ ] Google Play developer account, app `com.dealerdoor.app`, internal or closed testing track.
- [ ] Firebase project for Android push (FCM).
- [ ] `ANDROID_CERT_SHA256` wrangler var, and build with `-PappLinkHost=<api domain>`.
- [ ] Resend API key (email).

### Deployment
- [ ] Create the production D1 database and R2 bucket (US jurisdiction); replace `REPLACE_WITH_PROD_D1_ID` in `worker/wrangler.toml`.
- [ ] `wrangler secret put` for each secret (`JWT_SECRET` 32+ characters, Stripe, Resend, APNs).
- [ ] Repository variables `STAGING_API_URL` and `PRODUCTION_API_URL` so the deploy health check runs.
- [ ] Create the first admin user (command in `06-IMPLEMENTATION-PLAN.md`).
- [ ] Point an uptime monitor at `/v1/health`.
- [ ] Create the two store review accounts (customer and rep) and set their passwords.

### Legal
- [ ] Counsel approves TCPA and door-to-door disclosure text (en + es), added as `consent_texts` `v2`; set the active consent version.
- [ ] Confirm the 3-business-day cancellation wording (Washington and FTC rules).
- [ ] Confirm the AT&T dealer agreement allows "Authorized Retailer" wording and these dealer-billed fees.
- [ ] Confirm dealer branding only: no AT&T logo or name in the app name or icon.
- [ ] Privacy policy approved.

### Data
- [ ] Official SeaTac boundary (King County GIS) loaded in Admin → Settings.
- [ ] Real rate card and coverage rows replace the placeholders.
- [ ] Do-not-knock list imported.
- [ ] SeaTac solicitation permit number entered.

### Store submissions
- [ ] iPhone: first Xcode build (`08-MAC-XCODE-SETUP.md`), TestFlight, submit, then switch to Unlisted and set `APP_STORE_URL`.
- [ ] Android: fill the Data safety form, upload the release build to the testing track.

### Pilot
- [ ] 3 routes, 10 coworkers, 20 customers; watch Admin → Overview daily and keep the compliance tiles at 0.

## D. Check first

- [ ] D1 Run `npm test && npm run typecheck` in `worker/`, `npx playwright test` in `e2e/`, and the Android unit tests, to confirm today's baseline is green.
- [ ] D2 Do leads and office staff see the do-not-knock "remove" button in the console? The server restricts removal to admin; the doc says the same.
- [ ] D3 List the Android coworker tabs and compare with iPhone (Route / Leads / Me).
- [ ] D4 Decide whether Apple and Google account-deletion rules apply (decides A2 scope).

## Suggested order

1. D1, then B1–B5 (cheap, make the plan honest).
2. A1 and A7 (small, unblock store forms and payroll).
3. A2 and A3 once counsel and the store question are answered.
4. A6 before real staff data goes in.
5. A4 and A5 when the Firebase project exists.
6. Section C in parallel, starting with the accounts, since approvals take the longest.
