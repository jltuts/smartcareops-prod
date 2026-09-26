# SmartCareOps DEV API Gateway

Terraform-managed REST status baseline in project `gen-lang-client-0710663107`. Deployed and verified on 2026-09-24.

## Deployment results

- Gateway/API: `smartcareops-dev`; config: `health-20260924122722082200000001`.
- URL: `https://smartcareops-dev-bm0bhvrl.an.gateway.dev` (DNS resolves).
- Plan: 0 imports, 5 creates, 0 updates/deletes/replacements; 20 existing resources unchanged. The creates are API, immutable config, Tokyo gateway, dedicated service account and additive Cloud Run invoker membership.
- Apply: 5 added, 0 changed, 0 destroyed. Post-apply plan exit code 0: `No changes. Your infrastructure matches the configuration.`
- Gateway `/health` and `/readyz`: HTTP 200, `{"status":"ok","service":"smartcareops-api"}`. Unpublished `/api/live`, `/api/doctor/cases`, `/internal/hospital-demo/cases`: 404. Direct unauthenticated Cloud Run `/health`: 403. No patient or hospital actions were performed.
- Cloud Logging: Gateway 200 status requests and blocked-route 404s, matching Cloud Run backend 200 requests and direct unauthenticated 403 verified. Sampled logs contain no secret patterns.
- Terraform formatting/validation and 6 mocked plan tests passed, including exact OpenAPI route allowlist and configured-only enforcement. Root/backend npm audits: 0 vulnerabilities each. Tracked/reachable-history scan: 290 files, 366 blobs, 0 findings.
- IAM inspected: service-level `roles/run.invoker` for dedicated gateway identity; no direct project-level roles, no public invoker membership, no secret accessor grant to gateway. Secret accessor remains runtime-only. No Owner/Editor grant, authoritative IAM replacement or API disablement.
- No credentials or secret payloads were added to Terraform/OpenAPI. Existing `.env`, service-account key and Terraform state/plan exclusions remain intact; no new `VITE_*` secret or service-account JSON. No application or Live transport source changes.
- LB/Cloud Armor/Firebase/M13/M14 and all other deferred infrastructure remain untouched.

## Architecture and scope

Gateway/API name: `smartcareops-dev`. Gateway region: Tokyo `asia-northeast1` (Terraform variable `gateway_region`). Backend remains `smartcareops-api` in Singapore `asia-southeast1`, at `https://smartcareops-api-2bylk5u5mq-as.a.run.app`. This intentional region split adds a cross-region network hop; Tokyo is supported for Gateway whereas Singapore is not in its supported region list.

Current REST flow: client → API Gateway → IAM-authenticated Cloud Run. Public client access is limited to `GET /health` and `GET /readyz`, returning non-patient status metadata. The OpenAPI 2.0 template uses an explicit configured-route allowlist, no wildcard, a 15-second backend deadline, `APPEND_PATH_TO_ADDRESS`, and the backend service URL as both address and JWT audience. Readiness is cached startup dependency status, not continuous upstream health. `/healthz` is excluded because the external Cloud Run frontend reserves that path.

All case, clinical, approval, dispatcher, operations, regional, notification, internal demo and Computer Use routes remain unpublished. See [route inventory](../infra/terraform/ROUTES.md). These two status endpoints are the minimal safe verification subset: existing Origin checks are not end-user authorization, so no patient/doctor data routes are made public.

Gateway identity: `smartcareops-gateway@gen-lang-client-0710663107.iam.gserviceaccount.com`. Its only new grant is additive `roles/run.invoker` on `smartcareops-api`. It gets no project-wide grant, Firestore, Secret Manager, Owner/Editor or deployment role. Cloud Run retains ingress ALL with IAM invocation required; no public principal is added. The existing runtime identity and Gemini Secret Manager reference are unchanged. OpenAPI contains no credentials, tokens or secret payloads.

## Authentication roadmap and transport boundary

CURRENT: API Gateway authenticates its backend request using its dedicated service account; status routes do not require end-user JWTs.

LATER: user → Firebase Auth / Google Sign-In → ID token → Gateway JWT validation → backend authorization/RBAC. Introduce reviewed security definitions and per-operation security requirements before publishing sensitive paths. Firebase and M14 RBAC are not implemented here.

Gemini Live/WebSocket is excluded from OpenAPI and is never proxied through API Gateway. Existing `/api/live` behavior is unchanged. Its future route is client → Global External Application Load Balancer → Cloud Run directly → Gemini Live; this future edge path is not deployed yet.

The native Gateway URL remains directly reachable. A future load balancer/Cloud Armor policy is therefore not an exclusive protection boundary for Gateway. Later hardening must address direct endpoint access, domain strategy, authentication, quotas/rate limits and Armor coverage. No edge solution is implemented in this phase.

## Operations

Active ignored settings remain `infra/terraform/cloudrun-dev.auto.tfvars`, now with Gateway enabled and `gateway_region="asia-northeast1"`. Reproducible non-secret settings are in `environments/dev/apigateway.tfvars.example`. Preserve active variables alongside local state; do not restore the older Cloud Run-only example over a deployed Gateway and attempt a destructive plan.

API configs are immutable. Future route changes produce a new config and switch the gateway; review the complete plan, including old config lifecycle actions. Do not change application routes or weaken Cloud Run IAM to troubleshoot a gateway error. Never run blanket destroy or remove state/protection to recover a partial apply.

## References

- [Supported Gateway regions](https://docs.cloud.google.com/api-gateway/docs/deployment-model)
- [Authenticated Cloud Run backend invocation](https://docs.cloud.google.com/api-gateway/docs/securing-backend-services)
- [OpenAPI backend extensions](https://docs.cloud.google.com/api-gateway/docs/oasv2-extensions)
