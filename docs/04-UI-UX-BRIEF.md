# 04 · UI/UX Design Brief

**Feel:** calm, plain, trustworthy. Think Apple Wallet meets a field-service checklist. Reps use it one-handed on a sidewalk in the sun; customers open it twice a month.

## Principles

1. **One job per screen.** The door sheet asks one question: what happened at this door?
2. **Compliance is visible, not hidden.** Consent text is shown in full, read aloud, toggled, and signed. Do-not-knock is a red hand on the map and a red line in the door sheet.
3. **Offline is normal.** A small chip shows offline / queued / flagged. Saving never waits for the network.
4. **Money screens always say who bills what:** "Your AT&T service charges are billed separately by AT&T."
5. **Bilingual by default.** English and Spanish follow the phone's language; push and email follow the same setting on the server.

## Visual system

| Token | iOS | Admin web |
|---|---|---|
| Type | SF Pro, system text styles (Dynamic Type) | `system-ui` stack, 15 px base |
| Color | System colors, app tint = blue; green = done, orange = attention, red = blocked / overdue | Same semantic set, light + dark via `prefers-color-scheme` |
| Shape | Native lists and forms, capsule status badges | 10 px radius cards, 8 px inputs |
| Icons | SF Symbols (`house.circle.fill` stop, `hand.raised.fill` do-not-knock, `checkmark.circle.fill` knocked) | Text labels + badges |

## Key screens

- **Customer timeline:** vertical stepper, 5 rows, green checks for done, orange triangle for delayed, date under each row, plan + billing notice below.
- **Invoice:** label/value rows, bold balance, two big pay buttons, the "never stored" reassurance under them.
- **Route map:** full-screen map, blue SeaTac outline, numbered-feel house pins, bottom material bar with route name, progress and permit.
- **Lead capture:** single form, sections in the order the conversation happens: address → customer → interest → photo → consent + signature. Save stays disabled until consent + signature exist.
- **Pulse:** three segmented 1–5 scales, "Poor … Great" captions, anonymous toggle on by default.

## Accessibility

- Dynamic Type everywhere (no fixed font sizes for body text).
- VoiceOver labels on map pins, star buttons ("3 stars", selected trait), signature pad, sync chip ("2 waiting to sync").
- Color is never the only signal: badges include words, timeline uses distinct icons.
- Admin web: keyboard focus ring, semantic tables, `role="status"` toasts, responsive down to 390 px.
