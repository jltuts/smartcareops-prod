# Judges-only test and security corrections

These changes apply only to the local judges repository. The sole runtime source change is the Doctor entrance-animation focus fix described below. No deployments were run and no remote changes were pushed.

## Test corrections and preserved behavior

- **Live completion (`backend/tests/agent.test.js`):** the first event is a minimal persisted case, not the complete case record. Verify its pending enrichment marker, then inspect durable state for zero hospital handoffs. The legacy socket fixture has no patient identity; HTTP uses a different local identity, so its read correctly returns 404. The test now explicitly verifies that denial as well as zero connector calls. Patient ownership, approval gates, and intake behavior remain unchanged.
- **Case history (`backend/tests/patient-case-history.test.js`):** update the strict allowed-field list for the existing appointment/emergency summaries and current approved-review text. Pagination, patient isolation, verified doctor attribution, and absence of side effects remain asserted.
- **Audio (`backend/tests/patient-audio.test.js`):** replace an obsolete gain/limiter test with checks for the current PCM sample contract, playback rate/order, drain notification, interruption, invalid buffers, and clamped microphone encoding. No gain, timing, microphone, emergency playback, or device behavior was changed. This is not physical-device acceptance.
- **Clinical HTTP fixture (`agent-runtime/clinical-shadow/tests/http.test.js`):** construct the fixture with the canonical digest required by the existing runtime validator. Runtime validation and non-publishing assertions remain intact.
- **Browser smoke (`tests/e2e/smoke.spec.js`):** distinguish document titles from the current Patient/Doctor headings and use the existing branded home link. Scroll the portal section into view so its existing scroll-triggered reveal runs before clicking. Preserve navigation, refresh, history, focus, overflow, and script-error checks.

## Doctor entrance-animation focus fix

The browser regression exposed a genuine focus failure on `/doctor`. `src/pages/doctor/motion.js` used GSAP `autoAlpha: 0` for the hero children, which applies `visibility: hidden`; the route then attempted to focus the heading while its container was hidden. The heading never received focus after the animation completed.

Only the entrance tween now uses `opacity` instead of `autoAlpha`. Duration, stagger, translation, easing, reduced-motion handling, later card animations, and cleanup remain unchanged. Routing and authentication were not edited. The existing focus assertion was preserved and now passes on desktop and emulated mobile, alongside navigation, refresh, history, layout, and other portal checks.

## Narrow dependency corrections

Direct dependency versions are unchanged. Lockfiles and scoped npm overrides resolve the vulnerable transitive packages:

| Package | Previous | Prepared version | Scope |
|---|---|---|---|
| `@grpc/grpc-js` | 1.9.16 | 1.13.6 | Firebase Firestore dependency in the root package |
| `source-map-js` | 1.2.1 | 1.2.2 | Root build tooling |
| `uuid` | 9.0.1 | 11.1.1 | Backend `teeny-request`; reuses the existing patched package |

The grpc update adds its required `@js-sdsl/ordered-map` dependency. Firebase pins an older grpc range, so a scoped override is recorded explicitly. The affected backend caller uses `require('uuid').v4()`, which remains available in the selected patched version. Existing dependency overrides are preserved.

Advisory references: [grpc certificate validation](https://github.com/advisories/GHSA-m9gg-hp2v-232j), [source-map offsets](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), and [UUID buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Fresh audits report zero advisories in all three package trees; that is not a general security certification.

## Review boundary

The development checkout was read only. Three development files differed from the earlier packaging baseline during this turn (`src/pages/doctor/clinical.css`, `src/pages/doctor/clinical.js`, and `tests/e2e/clinical.spec.js`); this task did not write or import those changes. The judges snapshot remains based on its recorded source version.

No fixes are hidden by test skipping, dependency removal, altered authorization, or suppression of security findings. See [validation](VALIDATION.md) for executed checks and remaining review limits.
