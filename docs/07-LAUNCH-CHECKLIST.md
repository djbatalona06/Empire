# 07 · Launch Checklist (human sign-off)

The code enforces the rules; these items need a real person.

## Legal & brand

- [ ] Counsel approves TCPA and door-to-door disclosure text (en + es). Add as `consent_texts` version `v2`, then set Settings → active consent version = `v2`. Never edit `v1` in place.
- [ ] Confirm the 3-business-day cancellation wording matches Washington and FTC Cooling-Off rules for your sales.
- [ ] AT&T dealer agreement allows "Authorized Retailer" wording and these dealer-billed fees.
- [ ] App name and icon use dealer branding only (no AT&T logo without written approval).
- [ ] SeaTac solicitation permit number entered in Settings.
- [ ] Privacy policy URL (App Store and Google Play both require one) covering location, photos, contact data, payments.

## Sign-in, email and maps

- [ ] `npx wrangler secret put MASTER_EMAIL --env <env>` with the owner's address (staging and production). Without it nobody is bootstrapped as owner.
- [ ] Email works: `SMTP_HOST`, `SMTP_PORT` (465 or 587, never 25), `SMTP_USER`, `SMTP_PASS` as secrets, and `EMAIL_FROM` set to an address on a domain you have verified with your mail provider (SPF and DKIM records). A Gmail app password works for a first test but is not for production: mail from a personal address lands in spam.
- [ ] Sign in as the owner on staging: the emailed link arrives, opens the locked screen, and you create the password straight away. **Do this right after the first deploy.** Until the first password exists, whoever can read the owner's mailbox can set it.
- [ ] Confirm a wrong password five times locks the account, and that the emailed link alone cannot open invoices.
- [ ] Map tiles: the public OpenStreetMap server is for light use (its usage policy applies). Before many people use the map, switch `TILE_URL` in `admin/map-core.js` to a hosted tile provider.
- [ ] Privacy policy mentions that rep and customer locations are shown on an internal map.

## Data

- [ ] Official SeaTac boundary polygon loaded (Admin → Settings).
- [ ] Real catalog/rate card and coverage rows replace the placeholders.
- [ ] Do-not-knock list imported (Admin → Do-not-knock).

## App Review notes (paste into App Store Connect)

> This app is for customers and door-to-door sales coworkers of a third-party AT&T authorized dealer in SeaTac, WA. It is unlisted and distributed by direct link only.
>
> Demo accounts: customer `review-customer@<domain>` / password `<set one>`; coworker `review-rep@<domain>` / password `<set one>`. Sign in with "Sign in with a password".
>
> Location is used to verify a sales rep is at the property during check-in. Payments are for dealer installation/setup fees only; AT&T service is billed by AT&T.

Create the two review accounts in Admin → Users, then set their passwords via `POST /v1/auth/password` while signed in as them.

## Google Play (Android)

- [ ] Google Play developer account; create the app with package `com.dealerdoor.app`.
- [ ] Fill the **Data safety** form to match the privacy policy: location (rep check-in), photos, name/email/phone, payment info (handled by Stripe).
- [ ] Use an **internal** or **closed testing** track so only invited people can install, the closest match to App Store "Unlisted".
- [ ] Copy the app-signing SHA-256 fingerprint (Play Console → App integrity) into the `ANDROID_CERT_SHA256` wrangler var, and build with `-PappLinkHost=<your api domain>` so sign-in emails open the app.
- [ ] Paste the same review notes and demo accounts as above into **App content → App access**.
