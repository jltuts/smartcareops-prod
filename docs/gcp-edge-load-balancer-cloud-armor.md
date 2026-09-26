# SmartCareOps DEV edge — prepared, not deployed

## Status and blockers

No edge apply was executed. No global IP, certificate, load balancer or Cloud Armor policy was created. The operator confirmed that no owned DEV hostname is available. `domain_name` remains null; edge deployment is intentionally disabled. Compute API is disabled, so certificate inventory could not be completed without enabling it. That failure does not prove the project has no certificates. No API was enabled for this review.

Terraform structure is prepared and provider-mocked tests cover the enabled topology using a synthetic test-only domain. That fixture is never used in a real plan or apply. The saved real `edge-dev.tfplan` uses the active deployed Cloud Run/Gateway settings with `enable_load_balancer=false`: **0 imports, 0 creates, 0 updates, 0 deletes, 0 replacements; 25 managed resources unchanged**. This is a no-op preservation check, not an edge deployment plan. Plan guard passed. A real domain and a fresh enabled plan are required before any edge apply.

## Exact deferred resources

Directly dependent on hostname/TLS:

| Terraform address | Blocker |
|---|---|
| `google_compute_managed_ssl_certificate.api[0]` | Requires the real owned hostname; issuance requires DNS visibility |
| `google_compute_url_map.api[0]` | Configured host rule requires `domain_name` |
| `google_compute_target_https_proxy.api[0]` | Depends on the certificate and URL map |
| `google_compute_global_forwarding_rule.https[0]` | Depends on the HTTPS proxy; verified HTTPS requires valid TLS |

The following do not intrinsically require a hostname, but are deliberately deferred with the same `enable_load_balancer=false` gate to avoid deploying an incomplete edge:

- `google_compute_global_address.api[0]`
- `google_compute_region_network_endpoint_group.gateway[0]`
- `google_compute_region_network_endpoint_group.live[0]`
- `google_compute_backend_service.gateway[0]`
- `google_compute_backend_service.live[0]`
- `google_compute_security_policy.edge[0]`
- `google_project_service.required["compute.googleapis.com"]` (API enablement)

All ten edge resources plus Compute API enablement remain absent from the real plan. No DNS record resource exists in this root: DNS updates remain an explicit operator step with the domain's DNS provider. No fake domain is configured; the existing synthetic domain is confined to provider-mocked tests.

## Prepared topology

- Global external Application Load Balancer (`EXTERNAL_MANAGED`), global static external IP, HTTPS-only port 443 forwarding rule, target HTTPS proxy, Google-managed certificate and URL map. No HTTP fallback or fabricated deployment domain.
- API Gateway serverless NEG in `asia-northeast1`, using existing `smartcareops-dev`; separate Cloud Run serverless NEG in `asia-southeast1`, using existing `smartcareops-api`. Each has its own backend service and request logging enabled at sample rate 1.0. No backend health-check attachment or unsupported serverless timeout setting.
- Host rule uses `domain_name`. Exact `/health` and `/readyz` paths → Gateway backend → authenticated Cloud Run. Exact `/api/live` → Cloud Run backend directly, never Gateway. Actual path verified in frontend `src/pages/patient/conversation.js` and backend `backend/src/live.js`; there is no `/api/live/*` route.
- Unmatched hosts/paths use the configured-only Gateway backend, which rejects unpublished routes. This preserves the existing two-status-route public surface and does not expose doctor, internal or Computer Use endpoints through the Cloud Run backend. Unknown paths do reach Gateway for rejection, rather than receiving a load-balancer-generated denial.
- Outputs prepared: `https_ip`, `edge_domain`, `rest_edge_url`, `live_edge_url`, `cloud_armor_policy_name`; null while disabled.

## Live authentication boundary

Cloud Run remains IAM-required with ingress ALL, preserving existing authenticated Gateway invocation. No public principal, IAM change, embedded token, new identity service or application behavior change is introduced.

A plain load balancer does not mint a Cloud Run backend identity token. A controlled Live test must supply a valid caller ID token whose audience is the existing Cloud Run URL and whose principal has invocation permission, plus an Origin already permitted by the application. Keep tokens in memory and out of logs. A browser's native WebSocket API cannot supply an arbitrary Authorization header, and the current frontend has no hosted identity-token flow. Therefore this structure is **not a complete browser Live authentication solution**. An explicit authenticated browser design is a remaining prerequisite; do not make Cloud Run public or add Firebase/IAP as an unrequested workaround. If a future solution needs IAM/ingress changes, report them before any weakening.

The existing 300-second Cloud Run request timeout and in-memory Live session state still apply. A bounded upgrade-only smoke must send no intake/audio and close promptly, avoiding Gemini invocation. No Live smoke was performed because edge/TLS is not deployed.

## Cloud Armor and scope of protection

Both prepared external backend services attach policy `smartcareops-dev`. Conservative existing policy: default allow; SQL injection rule at sensitivity 1 in preview only. No enforced rate-limit or geo-blocking rule is added without traffic evidence and tests. Preview findings do not block requests. Backend logs will be available after deployment; no edge logs exist yet.

The native API Gateway URL remains directly reachable and bypasses load balancer Cloud Armor. Cloud Run's direct URL also remains reachable to authorized IAM callers; unauthorized requests still return 403. Armor is not an exclusive perimeter. It does not inspect WebSocket messages after upgrade; it is not application authorization. Later edge hardening must address direct endpoints, authentication, quotas/rate limits and domain strategy separately.

## Required domain/TLS sequence

1. Supply an actual owned DEV hostname and confirm DNS control. Inspect existing A/AAAA/CAA records and any existing certificates once inventory is accessible; do not overwrite unrelated records blindly.
2. Set `domain_name` to that hostname and enable the existing `enable_load_balancer` flag in the active deployment variables. Keep Gateway/Cloud Run enabled and monitoring/other deferred resources disabled. No credential values belong in variables.
3. Run fmt/validate/tests and generate a fresh complete `edge-dev.tfplan`. Review ten edge resource creates plus Compute API enablement as the expected structure, not as the result of today's disabled plan. Stop for deletes, replacements, data/secret changes, IAM removals or public Run exposure.
4. Only when ownership, DNS access and verification prerequisites are established, apply the reviewed plan. Point the hostname A record to the allocated global IP. Resolve conflicting AAAA/CAA records through explicit DNS review. A Google-managed certificate can remain PROVISIONING until DNS and load-balancer configuration propagate; wait for ACTIVE before HTTPS acceptance.
5. Verify HTTPS `/health` and `/readyz`, bounded authenticated direct `/api/live` upgrade, Armor attachments and load-balancer logs. Recheck direct Gateway reachability and unauthenticated Run 403. Do not use insecure HTTP or an invalid certificate to bypass missing prerequisites.

## Checks completed

- Terraform fmt/validate passed; 7 mocked plan tests passed, including exact path set, Singapore Live NEG, enabled logging, conservative Armor rules and rejection of missing domain.
- Real disabled-edge plan: no changes; no apply/post-apply run in this phase.
- Existing Gateway `/health` and `/readyz`: 200. Direct unauthenticated Cloud Run `/health`: 403. Cloud Run IAM still has only the dedicated Gateway invoker service-level membership.
- Root/backend npm audits: 0 vulnerabilities. Tracked/reachable-history secret scan: 290 files/366 blobs, 0 findings. No secret payload access, service-account JSON, VITE secret or token values added.
- No backend/frontend workflow changes. LB HTTPS/Live/Armor/logging tests remain blocked, not passed.
- Firebase Hosting/Auth, M13/M14, VPC/NAT/VPN/Interconnect, Pub/Sub and BigQuery were not started.

References: [Gateway load balancing and direct-URL limitation](https://docs.cloud.google.com/api-gateway/docs/gateway-load-balancing), [serverless load-balancer setup](https://docs.cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless), [Cloud Run identity tokens](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).
