# Existing backend route inventory

Inspected `backend/src/server.js`, `live.js`, `finalization-results.js` and the case/clinical/operations/regional/notifications/ambulance HTTP handlers. This is an inventory, not authorization to publish every route.

The first deployed OpenAPI baseline publishes only `GET /health` and `GET /readyz`, public non-patient status metadata with authenticated backend invocation. `/health` reports HTTP liveness; `/readyz` reports cached startup Firestore/key-presence readiness (200 or 503), without per-request external work. `/healthz` remains an internal platform probe: external Cloud Run requests encounter reserved-path behavior. No patient/clinical REST surface is published before end-user authentication and authorization.


| Existing surface | Methods | Gateway baseline |
|---|---|---|
| `/health`, `/readyz` | GET | Included; public status metadata, authenticated backend invocation |
| `/healthz` | GET | Excluded: Cloud Run external reserved-path behavior |
| `/api/live` | WebSocket upgrade | Excluded: Live streaming transport needs a separate design |
| `/api/intake-finalization` | POST with opaque ticket | Excluded: ticket/session transport needs hosted-runtime review |
| `/api/cases/{caseId}` | GET | Excluded pending identity/access controls |
| `/api/cases/{caseId}/route` | POST | Excluded; internal doctor routing, never a patient UI control |
| `/api/doctor/cases`, `/api/doctor/cases/{caseId}` | GET | Excluded pending doctor authorization |
| `/api/cases/{caseId}/evaluate-emergency` | POST | Excluded |
| `/api/dispatcher/cases`, `/api/dispatcher/cases/{caseId}` | GET | Excluded |
| `/api/dispatcher/cases/{caseId}/acknowledge` | POST | Excluded |
| `/api/ambulances` | GET | Excluded |
| `/api/cases/{caseId}/ambulance/{unitId}/assign`, `/api/cases/{caseId}/ambulance/dispatch` | POST | Excluded |
| `/api/clinical` | GET, optional `caseId` query | Excluded |
| `/api/clinical/observations`, `/api/clinical/resources/capacity`, `/api/clinical/run` | POST | Excluded |
| `/api/clinical/approvals/{approvalId}`, `/api/clinical/executions/{executionId}/confirm` | POST | Excluded; clinical approval remains backend-gated |
| `/api/operations` | GET | Excluded |
| `/api/operations/members`, `/api/operations/capacity`, `/api/operations/run`, `/api/operations/approvals/{approvalId}` | POST | Excluded |
| `/api/regional` | GET | Excluded |
| `/api/regional/seed`, `/api/regional/capacity`, `/api/regional/run`, `/api/regional/approvals/{approvalId}` | POST | Excluded |
| `/api/notifications` | GET, optional recipient type | Excluded |
| `/api/notifications/{notificationId}/decision` | POST | Excluded |
| `/hospital-demo` | GET | Excluded: isolated legacy browser target |
| `/internal/hospital-demo/cases` | GET/POST, backend bearer secret | Never publish: local fictional connector endpoint |

The removed `/api/agent/handoff` patient WebSocket is not an API to restore. No wildcard Gateway route forwards undocumented paths. Firebase identity middleware and exact-origin CORS are now prepared in application source, not deployed. The optional Gateway identity route remains disabled. See [Firebase route classification](../../docs/firebase-hosting-auth.md) for the new authenticated/future-role/internal boundaries. Origin checks do not authorize cloud users. No agent logic, orchestration behavior, patient handoff control or M13 resilience behavior is changed by this infrastructure work.
