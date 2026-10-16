# Validation results

Verified on 17 October 2026 with Node.js 24.18.0.

| Check | Result |
|---|---|
| Frontend build | Passed; bundle-size warning remains |
| Full backend suite | 946 passed, 0 failed, 1 skipped |
| Full clinical runtime suite | 15 passed, 0 failed |
| Maps configuration checks | 2 passed |
| Focused unit/HTTP regressions | 36 passed |
| Authentication browser regressions | 31 passed in Edge |
| Desktop and emulated-mobile smoke tests | 18 passed in Edge |
| Root, backend, and clinical-runtime dependency audits | Zero reported advisories |
| Secret-pattern scan | No findings |

Tests cover case ownership, clinical approval boundaries, intake finalization, PCM conversion and playback lifecycle, runtime request binding, navigation, and keyboard focus. The backend skip was already present.

Dependency fixes pin patched transitive versions of `@grpc/grpc-js` (1.13.6), `source-map-js` (1.2.2), and backend `uuid` (11.1.1). Direct Firebase, Cloud Storage, and ADK versions are unchanged.

Browser checks use local services, fictional data, and controlled provider responses. The Doctor entrance animation preserves heading focus during its fade; desktop and emulated-mobile navigation tests verify this behavior.

## Limits

These results are point-in-time checks, not a security certification. The full browser suite, physical-phone audio, real Gemini sessions, live cloud integrations, and deployment configuration were not validated by these runs. Emulation does not establish physical-device behavior. The frontend still emits a bundle-size warning, and two simulation source files retain extra EOF blank lines.

See [local verification](LOCAL_VERIFICATION.md) to reproduce the automated checks.
