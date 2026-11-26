# Public-source validation

Review date: November 25, 2026. Application baseline: 0.18.2.

## Completed checks

- `npm run build`: passed; distributable client generated from an explicit asset list.
- `npm run check`: passed; syntax and the Node.js 22 API package validated, including 16 Functions endpoints.
- `npm run check:ux`, `npm run check:ai`, `npm run check:messaging`: passed.
- `npm test`: 623 tests total; 619 passed, zero failed, four optional live satellite-provider tests skipped.
- `node tests/phase-one-browser-smoke.cjs`: 27 reported check groups passed, including field editing, saved priorities, explanatory Q&A, coverage warnings, clock/brief regressions and 390-pixel layouts; no JavaScript errors.
- `node tests/access-browser-smoke.cjs`: 41 reported check groups passed, including account/access handling, administrator boundaries and 390-pixel layouts; no JavaScript errors.

Browser checks used isolated temporary Chrome profiles and fictional farms. External HTTPS was blocked. The restricted execution sandbox initially prevented the Chrome debugging handshake; the same scoped checks passed with local browser execution permitted. No personal browser profile was used.

## Privacy review

The release copy excludes credential files, private recordings, farm records, operational logs and private Git history. Administrator addresses are replaced by synthetic test identities, and production administrator access must be explicitly configured server-side. A targeted scan compared available local secret values without printing them and checked common credential patterns, personal email addresses, machine-specific paths and candidate telephone numbers. Findings were reviewed before publication; pattern scanning is not a guarantee that every possible secret or vulnerability has been found.

The release preserves the MIT license and the separately bundled third-party notices. Generated `dist`, `node_modules`, private review reports and temporary browser artifacts are not part of the source upload; only the explicitly selected, captioned UI screenshot is included.

## What these results do not establish

These checks are not an independent security audit or a measure of agronomic accuracy. They do not establish real-phone SMS/WhatsApp delivery, unattended scheduling, current live-provider availability, signed-in production AI generation, subjective voice quality, or acceptance by a competition/certificate program. No paid AI request, outgoing phone message, cloud deployment or production-setting change was made for this public-source review.
