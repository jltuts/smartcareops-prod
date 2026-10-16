# Snapshot provenance

Prepared on 17 October 2026 (Philippine time).

- Source commit: `80fbf0552c9efca86f50845d04b6fdf4b1dcf1bc`.
- Includes the current development working-tree versions of the files below. These edits were already present before this packaging task.
- The runtime snapshot is preserved except for the narrowly scoped Doctor entrance-animation focus fix. Judges-only test corrections, dependency patches, and that UI fix are documented in [review fixes](REVIEW_FIXES.md).
- Showcase-specific changes are documentation, example environment files, read-only CI, exclusions of operational artifacts, and source-attribution cleanup.
- The development repository and deployments are not modified.
- No cloud rollout is required.

## Included uncommitted source changes

- `ackend/src/admin/http.js`
- `backend/src/user-profiles.js`
- `backend/tests/admin.test.js`
- `backend/tests/user-profiles.test.js`
- `infra/terraform/openapi.yaml.tftpl`
- `infra/terraform/tests/foundation.tftest.hcl`
- `src/app/router.js`
- `src/pages/admin/admin.css`
- `src/pages/admin/index.js`
- `src/pages/doctor/clinical.css`
- `src/pages/doctor/clinical.js`
- `src/pages/doctor/doctor.css`
- `src/pages/doctor/index.js`
- `src/pages/manual.js`
- `tests/e2e/admin-approved-doctors.spec.js`
- `tests/e2e/auth-ui.spec.js`
- `tests/e2e/clinical.spec.js`
- `tests/e2e/doctor.spec.js`
- `tests/e2e/hospital-handoff.spec.js`
- `tests/e2e/landing.spec.js`
- `tests/e2e/startup-shell.spec.js`

## Historical material

This proposal is based on the existing judges repository history. Removing old decks or other files here does not erase their earlier commits or remote branches. No history rewrite or remote branch deletion has been performed.

## Verification

See [validation results](VALIDATION.md) for the checks actually run on this snapshot.
