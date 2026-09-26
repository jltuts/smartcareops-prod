# SmartCareOps DEV GCP foundation

Terraform manages SmartCareOps infrastructure.
Application code manages agent behavior and operational data.

This is a brownfield, review-only infrastructure foundation. It does not start M13, redesign agents, deploy the patient application, or apply infrastructure.

## Verified existing environment

Live metadata confirms project `gen-lang-client-0710663107` (number `909914326545`), actual display name `smartcareops`, and Firestore `(default)`, Native, Standard, `asia-southeast1`, PESSIMISTIC concurrency, PITR disabled. The intended `smartcareops-dev` display name is not silently applied. Existing Firestore/Generative Language APIs are adopted; Datastore/Firebase Rules APIs and the existing Gemini-associated service account are preserved unmanaged. No approved GCS state bucket was found. Inventory for several proposed services was blocked by disabled APIs, so absence is not claimed.

## Architecture and ownership

```text
Optional HTTP platform:
Client → Global external managed HTTPS load balancer + Cloud Armor
       → API Gateway (explicit supported region)
       → IAM-authenticated Cloud Run (asia-southeast1)
       → existing Firestore + Secret Manager reference

Image source: Docker Artifact Registry in asia-southeast1
Identity: smartcareops-runtime; separate optional gateway invoker
Observability: Cloud Run platform logs/metrics + optional alerts/dashboard
```

The first plan creates only the foundation. All deployable runtime/edge/monitoring resources are gated off. The runtime uses a supplied real digest-pinned image and a numeric secret-version reference; no deployable placeholder is included. No application data, transcripts, cases, approvals, receipts, monitoring budgets or clinical history are Terraform resources.

The existing application only had GET `/health`. Two platform aliases, GET `/healthz` and GET `/readyz`, now return the same initialized HTTP-serving response. They do not inspect Firestore or call Gemini; these are process probes, not dependency or clinical readiness guarantees. This is the only application behavior change, made specifically for Terraform/Cloud Run probe integration. Patient intake remains status-only and doctor approval still gates hospital handoff.

## Constraints that prevent a complete app deployment

- API Gateway's documented regions do not include `asia-southeast1`; `gateway_region` has no implicit default. The operator must choose a supported region and assess latency/residency/connectivity to the Singapore backend. The serverless NEG must share the Gateway region. ([Google regions](https://docs.cloud.google.com/api-gateway/docs/deployment-model))
- The REST Gateway does not support the application's Live streaming/WebSocket path. Its baseline OpenAPI covers only health GETs; all patient, clinical and internal action routes remain unpublished. An authenticated streaming design is a later task. ([Gateway limits](https://docs.cloud.google.com/api-gateway/docs/quotas))
- Gateway has no ingress control to disable its generated URL, so the load balancer/Cloud Armor cannot enforce an exclusive edge path. The optional Cloud Armor policy is conservative (default allow, SQLi preview). This is not a complete WAF-protected application perimeter. API Gateway serverless NEG support is Preview. ([Load-balancing constraints](https://docs.cloud.google.com/api-gateway/docs/gateway-load-balancing))
- Cloud Run accepts network ingress with IAM invocation required, permitting Gateway's signed backend requests; no public invoker grant is added. Gateway's backend identity is separate from application data access. ([Backend authentication](https://docs.cloud.google.com/api-gateway/docs/securing-backend-services))
- The app still has local-demo authorization and process-local voice/finalization state. The cloud template disables M8–M12 workers, limits instances conservatively and does not claim HA or durable voice session routing. A Docker image/build pipeline, real domain, DNS/TLS readiness, secret version and deployment-access review remain prerequisites.

## Safety and exclusions

The project is a data source, not a managed project resource. Firestore is imported by full resource name and protected by lifecycle `prevent_destroy`, provider `PREVENT` and a proposed server-side deletion-protection update. Existing database identity, location, mode, edition and contents are unchanged. APIs are additive and retained on destroy. IAM uses individual memberships only. Secrets are empty containers plus scoped access; version values are uploaded separately and never read into Terraform.

State is explicitly local, ignored and not shared concurrently. A future GCS backend needs a separately approved bootstrap, versioning and restricted IAM; no bucket was provisioned. No VPC, subnet, NAT, VPN, Interconnect, Pub/Sub, BigQuery, production environment, Cloud Build pipeline or Firebase project/Hosting/Auth resources were added. Firebase configuration remains outside Terraform until its actual inventory and application use are established. Existing Firebase-related services remain enabled.

## Validation

- Terraform 1.16.4: `fmt -check -recursive` and `validate` pass against locked Google/Google Beta 8.4.0 providers.
- Five provider-mocked, plan-only Terraform scenarios pass, including optional Run/Gateway/LB/Armor/Monitoring configuration and rejected missing image/unsupported region/production inputs.
- Live ADC-backed plan: **3 imports, 16 creates, 3 updates, 0 deletes, 0 replacements**. Two updates set adopted APIs' state-side abandonment policy; Firestore's update enables deletion protection and sets provider PREVENT. Project unchanged. The plan guard passes.
- Focused process-probe regression: **1 passed**. Full backend: **542 passed**.
- Root/backend npm audits: **0 vulnerabilities each**. Existing secret scanner extended to Terraform/HCL/templates/YAML/examples: **0 findings**, including 61 tracked files, 96 reachable Git blobs and new source files.
- No service-account JSON, API-key value, secret-version data resource, sensitive output, broad Owner/Editor/public IAM member or secret-bearing `VITE_*` value added. Ignore checks cover providers, state/backups, plans, sensitive tfvars, crash logs and credential files while keeping the lock file/examples visible.

The earlier architecture correction's 180 browser tests and build are historical validation, not a new Terraform deployment test. Optional cloud resources were not applied or acceptance-tested live. No application image was built/pushed, no secret uploaded, no credential rotated, no GCP resource mutated and no `terraform apply` executed.

Start with [infra README](../infra/terraform/README.md), [inventory/import procedure](../infra/terraform/IMPORT.md), [recorded plan](../infra/terraform/PLAN.md) and [route inventory](../infra/terraform/ROUTES.md). Stop for user review of the first plan.
