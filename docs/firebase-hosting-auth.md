# Firebase Hosting and Google identity — DEV

## Status and ownership

Firebase Hosting and the backend identity route are deployed in the existing project `gen-lang-client-0710663107` / `909914326545`. Google provider is enabled and real hosted Google login succeeded. In DEV/public-demo mode, every successfully verified Firebase Google identity is provisioned by the backend with Patient-only access.

- Firebase Web App: `SmartCareOps Web`; App ID `1:909914326545:web:67dafb82404f4a683353b0`.
- Hosting site: default site `gen-lang-client-0710663107`; corrected auth-state release `1fa757abb984248b` at `https://gen-lang-client-0710663107.web.app`.
- Public Web config: reserved `/__/firebase/init.json` identifies the expected project, App ID and `gen-lang-client-0710663107.firebaseapp.com` auth domain.
- Authentication: initialized; authorized domains are the default `.web.app` and `.firebaseapp.com` origins. Google provider is enabled with the project-owned client. Real hosted login succeeded and the prior empty allowlist correctly rendered authenticated-but-unauthorized rather than signed-out.
- Cloud mutation completed: enabled `firebase.googleapis.com`, `firebasehosting.googleapis.com`, `identitytoolkit.googleapis.com` through gcloud. These APIs are presently CLI-managed, outside Terraform state.
- Firebase association, Web App, Hosting releases and Google provider remain Console/Firebase CLI-owned. Terraform retains Cloud Run, Gateway, IAM and the existing foundation. Do not declare duplicate resources. Provider-supported Auth configuration can entail Identity Platform and OAuth client secrets in state; this phase deliberately does not adopt that approach.
- Backend digest `sha256:9a3459843efd2cbd8465def9c2d745d811d21518c0f38e26cb579936cd16c50d` is deployed. Gateway config `health-20260924190917553000000001` publishes only status and `/api/auth/me`; no IAM grant was added.

## Implementation

`firebase.json` serves only Vite `dist/`, with a SPA fallback to `/index.html`; no Functions or backend rewrite. `.firebaserc` selects the existing project. Production frontend authentication is mandatory. Firebase public Web configuration comes from Hosting's `/__/firebase/init.json`, or the public placeholders in `.env.example` for local configuration. Verify that reserved configuration identifies the intended Web App before release.

Firebase Web SDK owns Google popup login, sign-out, current-user updates and token renewal. The application does not manually persist ID tokens. `apiFetch` retrieves the SDK ID token for each protected REST call and sends a Bearer Authorization header over HTTPS to the explicit Gateway base URL. Tokens and provider errors are not logged. User display names are rendered with textContent.

The backend requires authentication for `/api/*` in production (local legacy demo remains available). Firebase Admin SDK verifies signature, issuer, audience and expiry for the configured project. Only Google-provider identities are accepted. With authenticated Gateway-to-Run invocation, it verifies the original token in `X-Forwarded-Authorization`; otherwise it verifies Authorization. Neither header bypasses verification. Missing/invalid tokens return generic 401 responses. Revocation checking is not enabled: a revoked session's already-issued token can remain valid until expiry.

On first authenticated DEV access, the backend transactionally creates `userProfiles/{verifiedUid}` when absent. The profile stores only identity fields derived from the verified token plus backend-owned authorization fields: `uid`, `email`, `displayName`, `roles: ["patient"]`, `status: "active"`, `createdAt`, and `updatedAt`. Repeat access loads the existing record without duplicating or overwriting its roles or status. Inactive or disabled profiles fail closed.

`DEV_AUTH_UIDS` remains the explicit privileged DEV cohort. Its existing Doctor, Dispatcher, and Command Center behavior is unchanged. `DEV_PATIENT_UIDS` remains backward compatible, but is no longer required for Patient access. Email domains, frontend role selections, headers, query parameters, local storage, form values, and unverified token claims never grant roles. Backend route-family checks still require `doctor`, `dispatcher`, or `command-center`; Admin is never self-assigned. Existing clinical approvals/action gates remain in place and clinical APIs remain unpublished.

## Route matrix

The exhaustive legacy path inventory remains in [ROUTES.md](../infra/terraform/ROUTES.md). Classification for the new backend is:

| Surface | Classification and boundary |
|---|---|
| GET `/health`, `/readyz` | Public status only; already published through Gateway |
| GET `/healthz` | Internal platform probe; external Run reserved-path limitation |
| GET `/api/auth/me` | Authenticated identity; deployed through Gateway; returns backend-owned DEV roles |
| OPTIONS `/api/*` | Public preflight only, exact allowlisted Origin; no application data |
| `/api/cases/*`, `/api/doctor/*` | Future role-protected; token plus explicit DEV cohort required locally; unpublished at Gateway |
| `/api/dispatcher/*`, `/api/ambulances`, ambulance actions | Future role-protected; same DEV gate; unpublished |
| `/api/clinical/*`, `/api/operations/*`, `/api/regional/*`, `/api/notifications/*` | Future role-protected; same DEV gate plus existing action approval checks; unpublished |
| `/api/intake-finalization` | Internal session-bound transport; rejected in authenticated hosted mode pending Live design |
| `/api/live` upgrade | Deferred hosted transport; authenticated/production mode rejects upgrades with 403 |
| `/hospital-demo`, `/internal/hospital-demo/cases` | Internal-only; absent from Gateway; existing Run IAM and connector secret boundary retained |

`enable_firebase_auth_routes=true` publishes only GET/OPTIONS `/api/auth/me`. Gateway end-user JWT validation is deferred; backend verification is authoritative. Gateway's backend IAM token is distinct from the end-user Firebase token.

## CORS and Live

Deployed origins are the exact HTTPS default Hosting origins above plus `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173`. No wildcard authenticated CORS. Live preflight checks returned the matching origin for both Firebase domains and rejected an untrusted origin with 403 and no allow-origin header.

Browser WebSocket cannot supply the Cloud Run IAM Authorization header. Firebase ID tokens also do not satisfy Cloud Run IAM. No public Run grant or token-in-query workaround was introduced. Hosted patient UI therefore shows a Live-unavailable explanation, and backend upgrades fail closed. Local unauthenticated demo transport remains unchanged.

A later bounded design needs an authenticated session bootstrap, short-lived single-use session credential bound to identity/origin, expiry and replay checks, and a reviewed ingress/IAM design that actually permits browser upgrades. It must preserve isolated sessions and approval gates. No working hosted handshake is claimed here; LB/Armor remain deferred.

## Resume procedure

1. Sign in with a new Google account, open `/patient`, and verify the intake/status-only Patient Portal loads immediately and remains loaded after another refresh.
2. Visit `/doctor`, `/dispatcher`, and `/command-center`; each must show authenticated access denied, then sign out and verify the sign-in gate returns.
3. Any later privileged role requires a separate explicit verified-UID assignment and review. Keep clinical routes unpublished and hosted Live deferred.

## Validation and security

Patient auto-provisioning validation: focused backend **25/25**, full backend **578/578**, and full Playwright **208/208** passed. Production build passed. Root/backend audits found 0 vulnerabilities; tracked/history/built scans found 0 secrets. The reviewed deployment changed only the API and Live images in place (**0 added, 2 changed, 0 destroyed**), and the post-apply plan is clean. Missing/invalid token rejection, exact-origin CORS, durable profile behavior, spoofed-role rejection, inactive denial, and privileged API denial remain covered. A new-account hosted browser acceptance remains useful because no controllable signed-in browser surface was available during deployment.

Active image `sha256:7c44275f1e8d4992fe22745855f5941dd2d0b13b5a0a3fa889ba686d12de7ff0` runs on `smartcareops-api-00008-s5m` and `smartcareops-live-00009-nw8`, each at 100% traffic.

Root/backend npm audits found 0 vulnerabilities. Backend pins the transitive gaxios 6 UUID dependency to compatible CommonJS UUID 11.1.1 to resolve its audit finding. Existing secret scan covered 290 tracked files and 366 reachable-history blobs plus new source files with 0 findings. No Gemini payload was accessed; no service-account JSON or backend secret was introduced into frontend config. Firebase public configuration contains placeholders only. Gemini remains Secret Manager-backed in Cloud Run.

References: [Admin token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [Firebase Terraform ownership considerations](https://firebase.google.com/docs/projects/terraform/get-started).

## Hosted Gemini Live implementation awaiting reviewed apply (2026-09-25)

The prior fail-closed placeholder has been replaced in source by the bounded design documented in [hosted-gemini-live-session.md](hosted-gemini-live-session.md). Auth state and backend authorization policy are unchanged: only the explicit DEV Patient UID can obtain a session; Doctor, Dispatcher, Command Center, Admin, and execution privileges are not granted. The production deployment remains pending explicit review of the isolated service's `INGRESS_TRAFFIC_ALL` setting and service-level `allUsers` invoker grant. Until that apply and real hosted verification occur, the currently deployed release remains fail-closed.
