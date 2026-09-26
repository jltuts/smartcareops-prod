# Hosted Gemini Live session transport

## Status

The reviewed security-hardening deployment is active. Hardened image `sha256:d97c58aa1dffb6cde51014c426314013ae757f320a6d06d522ffe4498c94171e` runs on `smartcareops-live` revision `smartcareops-live-00001-d6r` in `asia-southeast1`. The service URL is `https://smartcareops-live-2bylk5u5mq-as.a.run.app`; Firebase Hosting is release `4f5d294971f693ef` at `https://gen-lang-client-0710663107.web.app`.

Applying `infra/terraform/hosted-live-hardened.tfplan` produced **3 added, 2 changed, 0 destroyed**. A post-apply plan reported no changes. Only `smartcareops-live` grants `roles/run.invoker` to `allUsers`; `smartcareops-api` remains private with only the Gateway service account as invoker.

## Security boundary

**Origin validation is defense-in-depth, not authentication.** A custom client can forge Origin and Fetch Metadata.

**The security boundary is the authenticated bootstrap plus the 60-second, single-use Live session credential.** Firebase Admin verifies the Google identity, the backend assigns the Patient role from the explicit UID allowlist, and only then may `POST /api/live/session` issue a credential.

The credential uses Node `crypto.randomBytes(32)` (256 bits) and base64url encoding. Only its SHA-256 digest is stored. The record binds the verified Firebase UID, Patient role, normalized exact Origin, `/api/live` path, `gemini-live` purpose, creation time, expiration time, and consumption state. It stores no Firebase ID token, Gemini key, authorization header, service-account credential, or raw session credential.

Firestore consumption runs in a transaction. Simultaneous use allows one consumer and rejects the other; expiry, replay, malformed values, wrong Origin, wrong path, wrong purpose, and already-consumed records fail closed. Refresh and reconnect always request a new credential.

## Origin and browser metadata

Hosted Terraform allows exactly:

- `https://gen-lang-client-0710663107.web.app`
- `https://gen-lang-client-0710663107.firebaseapp.com`

The validator parses and compares normalized scheme, lowercase hostname, and explicit/non-default port. It rejects missing Origin, `null`, wildcards, credentials, paths, queries, fragments, malformed values, non-HTTPS hosted origins, and prefix/suffix lookalikes. Local HTTP origins remain only in explicit `backend/.env` and local test configuration.

`Sec-Fetch-Mode` and `Sec-Fetch-Dest` are checked when present. Bootstrap accepts browser CORS/same-origin modes with an empty destination; WebSocket upgrade accepts websocket mode and websocket/empty destinations. Missing metadata is tolerated because browser and proxy behavior is inconsistent, and Hosting-to-Run is cross-site. `Sec-Fetch-Site` is not used as an authorization decision.

## Transport and logging

The browser sends `smartcareops.live.v1` and `smartcareops.session.<opaque credential>` as WebSocket subprotocol values. Credentials never enter the URL, browser storage, history, visible UI, or error messages. Firebase ID tokens and Gemini keys never enter the WebSocket URL.

Bootstrap and upgrade logs contain only outcome, rejection category, normalized Origin, and bootstrap TTL. They do not log tokens, subprotocol credentials, Authorization headers, Firebase verification details, query strings, or Gemini configuration. Client responses use generic `LIVE_SESSION_REJECTED` errors.

## Abuse controls

The IAM-protected bootstrap instance permits at most five issuances per UID per minute, twenty per normalized Origin per minute, and three unexpired issued credentials per UID. The isolated transport permits thirty upgrade attempts per source address per minute. These are bounded, in-memory, per-instance DEV controls; they reset on restart and are not a distributed production quota system. The main API is configured for one instance, while Firestore transaction consumption remains the authoritative cross-instance replay control on the Live service.

Expired Firestore records are rejected regardless of cleanup. Bootstrap deletes at most twenty expired records, and an expired record encountered during consumption is deleted transactionally.

## Infrastructure boundary

The planned `smartcareops-api` remains IAM-protected and API-Gateway-invoked. Gateway publishes only `/health`, `/readyz`, `/api/auth/me`, and authenticated `/api/live/session`; it never publishes the WebSocket route or clinical APIs.

The planned `smartcareops-live` service is an isolated WebSocket transport with `INGRESS_TRAFFIC_ALL` and `roles/run.invoker: allUsers` only if separately approved. It returns 404 for non-health HTTP application routes and requires the one-time session for `/api/live`. No Load Balancer, Cloud Armor, M13, full M14, VPC/NAT/VPN, Pub/Sub, or BigQuery work is included.

## Validation

- Focused backend Live/auth security tests: 17/17 passed.
- Full backend: 566/566 passed.
- Focused desktop/mobile Playwright: 26/26 passed.
- Full desktop/mobile Playwright: 206/206 passed.
- Production build and Terraform format/validate passed; Terraform mocked tests: 8/8.
- Root/backend production audits: 0 vulnerabilities each.
- Secret scan: 290 tracked files, 366 reachable blobs, 0 findings; built frontend scan: 0 findings.

Tests cover exact and normalized allowed origins, lookalikes, missing/null/malformed origins, optional browser metadata, expiry, malformed credentials, replay, simultaneous double-use, UID identity returned from the bound record, wrong role, untrusted bootstrap, bootstrap and upgrade rate limits, generic failures, and credential/log redaction.

## Deployed verification

Direct non-health HTTP application routes on `smartcareops-live` returned 404. API Gateway returned 401 for a bootstrap without a Firebase token, 403 without CORS permission for a wrong Origin, 204 with the exact Hosting Origin for preflight, and 404 for an unpublished clinical route.

Deployed WebSocket probes returned 403 for missing, malformed, expired, replayed, and wrong-Origin credentials. A credential rejected for the wrong Origin remained usable once from the bound Origin. Concurrent consumption produced exactly one 101 and one 403. A 70-attempt invalid-upgrade run produced 21 ordinary rejections and 49 rate-limit responses (429), confirming the bounded transport control. These probes created opaque short-lived credentials directly in the same Firestore store and did not send a Gemini `start` message.

## Remaining verification

No usable browser surface was available in the verification environment. Therefore the real Google → Patient → bootstrap → WebSocket → Gemini Live voice conversation, canonical completion, structured finalization, case persistence, refresh behavior, privileged portal UI denials, and sign-out are **not claimed** by this record. Automated coverage for those state transitions passed, but it is kept separate from real hosted voice evidence. Hosted Gemini Live secure session and security hardening must not be marked complete until one real hosted voice intake reaches `submitted_for_clinical_review` and the resulting status-only state is inspected.

On 2026-09-25, redacted stage diagnostics localized the prior five-second failure to the upstream authentication boundary: Gemini returned close code 1007 with `API key not valid. Please pass a valid API key.` Both the legacy 3.1 Live model and recommended 3.8 Live model reached `setupComplete` with identical minimal audio configuration in an isolated A/B, and the production configuration is a valid subset of the current SDK schema. No model or Live-config change was made.

After Secret Manager version 2 was enabled, fresh revision `smartcareops-live-00005-9jt` resolved the unchanged `smartcareops-gemini-api-key:latest` reference. A hosted probe reached setup-ready, forwarded the first mono PCM16 48 kHz frame, received Gemini transcript/audio, completed the first turn, remained connected beyond 35 seconds, and closed both sockets normally with code 1000. The remaining acceptance requirement is still a real microphone intake through canonical completion and persisted `submitted_for_clinical_review` state.

## Real hosted voice acceptance result

The operator's 2026-09-25 hosted Patient attempt passed the transport and upstream stability boundary. The API issued the session at 21:40:12 UTC; the Live service authorized and accepted it at 21:40:12, Gemini reported setup complete at 21:40:13, and the first client audio was received and forwarded at 21:40:13. The connection remained active for about 47 seconds and the voice state emitted `gemini_intake_complete` at 21:41:00. Client closure used the browser's empty 1005 status; the upstream Gemini connection closed normally with 1000.

The acceptance did not pass structured finalization. At 21:41:13 UTC finalization returned `UNRESOLVED_CLARIFICATION`; one clarification remained unresolved after an invalid extraction response. A read-only Firestore query found no case created or updated in the run window, so persistence, `submitted_for_clinical_review`, and refresh-to-status-only behavior did not occur. A bounded log query found no hospital handoff, Computer Use, or agent execution activity during the run. The backend authorization boundary was not changed; Patient-only identities remain denied Doctor, Dispatcher, and Command Center access under the previously verified policy.

Hosted Gemini Live secure session + security hardening therefore remains **INCOMPLETE**. Completion requires another real hosted intake whose structured finalizer succeeds and whose resulting case is verified in Firestore and after browser refresh. M13 remains unstarted.

## Durable finalization result lifecycle

The prior hosted implementation returned an opaque finalization UUID over the closing WebSocket, but stored its state in a process-local `Map`. The browser also polled a relative `/api/intake-finalization` URL that API Gateway did not publish, so Firebase Hosting returned the SPA fallback. The first missing lifecycle stage in the real run was frontend result retrieval. Process-local storage was an additional Cloud Run correctness defect even if routing had succeeded.

The Live service now creates a UID-bound Firestore `intakeFinalizations` record in `PENDING` state before allowing finalization to continue independently of the WebSocket. Structured extraction, validation, case persistence, and workflow transition resolve that record atomically to `SUCCEEDED` or `FAILED`; repeated resolution is idempotent. The API service reads the same collection through an exact authenticated `/api/intake-finalization` Gateway route. Firebase verification and the backend Patient role remain required, and a result owned by another UID is indistinguishable from a missing result.

The browser transports the opaque UUID in `X-SmartCareOps-Finalization-Id`, never as authorization. Firebase ID-token authorization remains in the normal `Authorization` header supplied by `apiFetch`. Pending polling survives voice closure and stores only the opaque UUID in session storage so a refresh resumes retrieval. HTTP 202 and a bounded initial 404 creation race remain pending; a terminal success loads the Firestore-backed Patient case/status, while a genuine durable failure remains visible. The original WebSocket is not required for completion or retrieval.

Diagnostics are limited to finalization ID, transition, timestamps/duration, result presence, case ID, workflow state, and error category. Tokens, Live credentials, Gemini keys, authorization headers, and transcript content are excluded.

Validation passed: focused browser **44/44**, backend **572/572**, full browser **208/208**, production build, zero-vulnerability root/backend audits, zero findings in tracked/history/built secret scans, and clean `git diff --check`. Image `sha256:939c730afc0996886b50303c2e2ffafe2cca8501f4549f4b2454fdf3a5aa22fb` is deployed to both Cloud Run services. The Gateway route and Firebase Hosting version `0bc6e48148d4bd1a` are active; the post-apply Terraform plan is clean.

Real acceptance remains pending. It must prove a normal hosted intake reaches canonical completion, durable finalization, case persistence, `submitted_for_clinical_review`, status-only UI, and the same state after refresh, with no automatic handoff or Computer Use and unchanged privileged-portal denial.

## Structured extraction response-shape correction

The next real normal run passed authentication, Live bootstrap, Gemini readiness, canonical completion, and durable cross-service retrieval, but finalization `2eacc8bf-b0d5-4199-90c7-d1790184a6ec` failed `INVALID_RESPONSE`. Safe diagnostics localized the first failure to two of four normalized symptom updates at `symptom.update`; two independent updates were accepted. No case or workflow was created, and no emergency, handoff, or Computer Use activity occurred.

The extraction JSON schema had allowed additional properties while the server validator required an exact nine-key update. The schema now explicitly forbids additional properties at both levels. Normalization reports bounded structural metadata for missing or unexpected keys before evidence validation; it does not log patient text or field values, discard unknown fields, infer facts, or relax enums/evidence rules. Omitted and JSON-null required wire placeholders continue to fail safely under the documented empty-string wire contract.

Automated verification passed: focused backend **30/30**, full backend **584/584**, focused Playwright **44/44**, full Playwright **208/208**, production build, zero-vulnerability root/backend audits, zero findings in tracked/history/built scans, and clean whitespace checks apart from existing line-ending notices. Image `sha256:d8cb535e955ed6408a6e258298330d5ea2695295ae676cd968695511f6de833e` is active on API revision `smartcareops-api-00009-6qz` and Live revision `smartcareops-live-00010-xjp`. The reviewed Terraform apply changed only those two image references in place; post-apply plan is clean. Hosting did not change.

Real hosted acceptance remains pending and is the only completion gate. Hosted Gemini Live + Secure Session + Durable Finalization remains **INCOMPLETE** until a normal microphone intake produces `SUCCEEDED`, exactly one persisted case in `submitted_for_clinical_review`, and the same status after refresh, while privileged portals remain denied and no emergency, automatic handoff, or Computer Use activity occurs.

## Pending finalization refresh recovery

A later real attempt reached canonical completion and the visible finalizing state, but an immediate refresh rendered the idle Patient state. The frontend had two reload races: it persisted the opaque finalization UUID only after final audio playback settled, and an in-flight result request aborted by `pagehide` could clear the UUID through the generic error path.

The frontend now stores only `smartcareops-finalization-id` in `sessionStorage` as soon as the validated `completion-pending` message arrives. Page teardown marks the old polling loop disposed before media/socket cleanup; after Firebase identity and backend Patient authorization restore, mounting the Patient workspace reads the UUID, renders finalizing, and resumes authenticated polling. Successful normal or emergency terminal results clear the key. A backend terminal failure retains the UUID so the same safe failure can be retrieved after another refresh. Starting a new intake explicitly clears stale recovery state.

Focused Patient Live Playwright passed **28/28** and full Playwright passed **210/210** across desktop/mobile. The production build and root/backend audits passed; tracked/history/built secret scans found no findings; whitespace checks passed apart from existing line-ending notices. This was frontend-only: Cloud Run, Gateway, Firestore, auth/authorization, Live security controls, extraction, emergency rules, and connector behavior did not change. Firebase Hosting version `6af094de4c27293f` serves bundle `index-BKtHs9ls.js` at `https://gen-lang-client-0710663107.web.app`.

Real immediate-refresh acceptance remains pending. Do not mark the hosted capability complete until the operator observes finalizing after the first refresh, then the persisted `submitted_for_clinical_review` case and the same status after a second refresh.
