# SmartCareOps DEV Terraform foundation

**Foundation and first DEV Cloud Run deployment completed. M13 is not started.** Cloud Run `smartcareops-api` is ready in Singapore; apply added 1 resource with no other changes, and post-apply plan is clean. See [deployment record](../../docs/gcp-cloud-run-deployment.md). Active settings are in ignored `cloudrun-dev.auto.tfvars`; preserve them alongside local state, or restore from `environments/dev/cloudrun.tfvars.example`. API Gateway `smartcareops-dev` is deployed in Tokyo: 5 additions, no other changes, clean post-apply plan; details in the [Gateway record](../../docs/gcp-api-gateway-deployment.md); LB/Armor/monitoring remain disabled. The current full deployment settings are recorded in `environments/dev/apigateway.tfvars.example`. First-foundation plan instructions below are historical.

Terraform manages SmartCareOps infrastructure.
Application code manages agent behavior and operational data.

This root references existing project `gen-lang-client-0710663107`, adopts its existing Native/Standard `(default)` Firestore database in `asia-southeast1`, and prepares a small DEV platform. It never creates or renames the project, manages application documents, or rotates credentials. The actual project display name is currently `smartcareops`; the intended `smartcareops-dev` name remains documentation only.

## First plan and default scope

See [PLAN.md](PLAN.md) for the recorded live plan and [IMPORT.md](IMPORT.md) for the inventory/adoption table. The default configuration plans:

- Import existing Firestore and two required, already-enabled APIs.
- Enable eleven additional platform APIs, retaining services on destroy.
- Create a Docker Artifact Registry repository, one runtime service account, one empty Gemini secret container, and two additive IAM memberships.
- Enable Firestore server-side deletion protection and set its Terraform deletion policy to `PREVENT`.

Cloud Run, API Gateway, HTTPS load balancing, Cloud Armor and runtime monitoring are fully described but **disabled by default**. No fake application image is configured. No domain, secret value, credential file or frontend deployment is created.

## Prerequisites

1. Terraform `>= 1.16.4, < 2.0.0`; validated with 1.16.4. Google and Google Beta providers are pinned to **8.4.0**, with the signed-provider lock file checked in. The CLI was absent from PATH during this work; a temporary official Windows binary was downloaded and its published SHA-256 checked. Install the pinned CLI normally for continued use; no global installation was made.
2. Existing project access and billing appropriate for the services being planned. A successful plan does not establish billing, quota, organization-policy or apply permissions.
3. Local ADC for Terraform and the existing backend. If ADC is already valid, reuse it. If authentication is needed, run `gcloud auth application-default login` yourself; do not download a service-account key. Terraform does not read `backend/.env`.
4. Review the existing dirty working tree before committing. This foundation does not commit unrelated M0–M12 work.

## Init, validation and review

From the repository root, after installing Terraform on PATH:

```powershell
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
terraform -chdir=infra/terraform plan '-out=dev-review.tfplan'
terraform -chdir=infra/terraform show -no-color dev-review.tfplan
terraform -chdir=infra/terraform show -json dev-review.tfplan > infra/terraform/dev-review.plan.json
python infra/terraform/check-plan.py infra/terraform/dev-review.plan.json
```

The five Terraform tests use mock providers and **plan-only** runs, including an explicitly synthetic optional-platform fixture. They never call GCP, build an image, or apply. The saved real plan uses the disabled deployment defaults. The plan checker rejects deletion/replacement, Firestore creation/identity drift, secret-version/key resources, broad project roles and public IAM grants. It supplements human review; it does not prove every future configuration is safe.

`imports.tf` makes adoption visible in the first plan without writing imported objects into local state. The alternative explicit import commands are in IMPORT.md. Do not remove the import declarations before the database is in state. Do not use `-target`, `-replace`, `-refresh=false`, or a different empty state to bypass adoption checks.

To customize, copy `environments/dev/terraform.tfvars.example` to an ignored `.tfvars` file and pass the same `-var-file=...` to every import/plan. No values in that example are credentials. Project/environment/Firestore region are deliberately restricted to this inspected DEV environment.

## Apply process — separate authorization required

The user must review the first Terraform plan before any apply. This work stops at that review point. Once a specific fresh saved plan is explicitly approved, the operator may run `terraform -chdir=infra/terraform apply dev-review.tfplan`. Do not run a new implicit plan/apply or `-auto-approve` based on an older approval. Import-only operations write local state but do not provision resources; none were performed during this work either.

Before approving: verify no DELETE/REPLACE, Firestore stays `(default)`/Native/Standard/Singapore, the project is untouched, IAM changes are additive, and intended API/billing costs are understood. Disabled APIs limited some inventory queries; re-check naming collisions as soon as an authorized operator enables those APIs. If an intended “new” resource already exists, add its import and re-plan rather than retrying a create blindly.

## State and destroy protection

The backend is deliberately **local**. `.terraform/`, state/backups, binary/JSON plans, crash logs, tfvars and credentials are ignored; `.terraform.lock.hcl`, source and safe examples remain visible. Protect state/plan files with local OS access controls and an encrypted, access-controlled backup. Local state must not be used concurrently by separate operators.

No approved state bucket was found and no bucket was created. Later use a separately bootstrapped GCS bucket with versioning, uniform bucket access, public-access prevention and narrowly scoped state-writer IAM. Review its location, retention/recovery and ownership, then migrate with `terraform init -migrate-state` as a separate authorized operation. Do not make this root implicitly bootstrap its own backend.

Firestore has `prevent_destroy = true`, `deletion_policy = "PREVENT"` and server-side deletion protection enabled in the proposed plan. Persistent image/secret/identity resources also have lifecycle protection; secrets and Cloud Run additionally have provider deletion protection. APIs use both `disable_on_destroy = false` and `deletion_policy = "ABANDON"`. No global `ignore_changes` masks drift. Lifecycle protection only works while the resource remains in configuration; removing resource blocks or destroying state is not a safe decommissioning procedure. Never run a blanket `terraform destroy` against this brownfield root.

## Secret handling

Terraform creates only `smartcareops-gemini-api-key` metadata and a secret-level accessor membership for the runtime account. There is **no secret-version resource/data source**, no credential variable, and no service-account key resource. Output definitions contain IDs, service-account email and endpoint metadata only.

After the foundation is approved and applied, an authorized operator adds the existing Gemini credential as a new version **outside Terraform**, preferably using the Secret Manager console's Add version flow. Do not paste it into a terminal argument/history, tfvars, source, a build argument or chat. An alternative is `gcloud secrets versions add smartcareops-gemini-api-key --project=gen-lang-client-0710663107 --data-file=<secure-external-file>` with a separately secured file outside the repository; file creation/disposal is the operator's responsibility. This foundation does not run that command, extract `.env`, copy or rotate the key.

Set only a numeric version identifier or the explicitly requested `latest` alias in `gemini_secret_version` (default `latest`). The Cloud Run template references that version through Secret Manager; Terraform never reads its bytes. Numeric pinning makes later credential rollout an explicit reviewed revision. Gemini uses the existing Developer API/key transport, so no Vertex AI role or credential migration is introduced. No secret or token goes into `VITE_*` variables.

## IAM design

| Identity | Grant | Reason / limit |
|---|---|---|
| `smartcareops-runtime` | Project `roles/datastore.user` | Existing server SDK reads/writes transactional operational data. No schema/admin/project privileges. Project scope covers the current default database; reassess if additional databases are introduced. |
| Same runtime | `roles/secretmanager.secretAccessor` on its one secret | Read the Gemini secret at Cloud Run startup. No access to unrelated secrets. |
| Optional `smartcareops-gateway` | `roles/run.invoker` on the one Cloud Run service | Gateway signs backend ID tokens. No Firestore/secret access. |

All grants use `*_iam_member`, never authoritative policies/bindings. No Owner/Editor, downloaded keys or `allUsers` membership. No logging-writer or monitoring-writer grant: the app writes stdout/stderr, and Cloud Run collects platform logs/metrics without a custom telemetry client. Add a narrow writer only if code later requires it. The runtime has no image-push permission; Cloud Run's managed service agent handles same-project image retrieval. API Gateway's managed service agent uses the standard service-agent role established by enabling its API, not an extra project-wide Token Creator grant from this root.

Terraform **does not manage** developer/deployer/admin roles. An administrator must separately provide scoped permissions for enabling services, reading the project, updating database protection, managing the selected service accounts/IAM memberships, creating the repository and secret container, and later deploying Run/Gateway/Compute/Monitoring resources. Deployment also needs `iam.serviceAccounts.actAs` on the selected runtime/gateway accounts; image builders need repository writer, and secret-version operators need version-add permissions. These are administrative duties, not runtime permissions. ADC is developer authentication only; Cloud Run uses its attached runtime identity.

## Edge preparation status

Edge remains disabled: no owned DEV domain/TLS prerequisite is configured. The prepared URL map separates exact `/api/live` to a Singapore Cloud Run backend from status REST traffic to Tokyo Gateway; both backends attach the conservative Armor policy. Cloud Run IAM remains enabled, so a caller identity token is required for direct Live and the current browser needs a separate authentication design. No edge apply occurred; the saved real plan is a no-op, not an enabled deployment plan. See [edge design and blockers](../../docs/gcp-edge-load-balancer-cloud-armor.md).

## Optional deployment stages

1. **Cloud Run:** Supply a real digest-pinned image already in the DEV Artifact Registry and an existing secret version, then set `enable_cloud_run=true`. No Dockerfile/build pipeline is invented here: build from the repository root because backend imports `shared/` outside `backend/`; include required browser binaries only if that separate legacy runtime is intentionally supported. Never bake `.env`, ADC or Terraform state into an image. Health probes require the current source with `/healthz` and `/readyz` aliases. Both mean initialized HTTP serving, not Gemini/Firestore health.
2. **Gateway:** Set `enable_api_gateway=true` and explicitly choose a documented `gateway_region`. Singapore is not currently listed; `asia-northeast1` is one possible operator choice, not a silently selected default. Review cross-region latency/residency and verify backend connectivity before rollout. The NEG uses the gateway's region; Run and Firestore stay in Singapore. Cloud Run uses `INGRESS_TRAFFIC_ALL` **with IAM invocation required**, because Gateway's authenticated call to `run.app` is not a direct internal/LB ingress source. Do not make the service unauthenticated to fix a connectivity error.
3. **HTTPS edge:** Supply an owned `domain_name`, `enable_load_balancer=true`, and DNS access. The optional global external managed Application Load Balancer uses a beta serverless NEG targeting Gateway, HTTPS backend, URL map, managed TLS certificate, global IP and port-443 forwarding rule. DNS remains external: point the domain's A record at `https_ip`, check conflicting AAAA/CAA records, and wait for TLS provisioning. No invented production domain, HTTP listener, VPC or NAT. Cloud Armor defaults to allow with a SQL-injection rule in preview only.
4. **Monitoring:** Set `enable_monitoring=true` only with a real Run service. This creates a sustained 5xx-ratio alert and a requests/instances/startup-latency dashboard. With Gateway, it adds `/readyz` uptime checks and an availability alert. Existing notification-channel names are optional; an empty list creates incidents without delivery. The uptime checker uses the custom domain when the LB is enabled, so DNS/TLS must be ready. No new email/SMS recipient, log sink/retention change or custom application telemetry agent is created. Log-based error alerts are deferred: the existing app logs safely recoverable events too, so a generic ERROR trigger would not be a reliable platform outage signal.

These stages require a **new reviewed plan**, not applying the foundation plan with changed variables. Scaling is conservative (0–1 instance, concurrency 20); this is not HA or a fix for the existing in-memory Live/finalization session ownership. M8–M12 background workers remain disabled in the cloud template, and `NODE_ENV=production` preserves their existing DEV-only guard. Local application behavior and `.env` remain intact. Enabling those agents in a hosted multi-instance runtime needs a later explicit design review, not an environment flag workaround.

## Gateway and Firebase limits

The minimum OpenAPI baseline exposes only GET `/health` and `/readyz`; `/healthz` is excluded because of Cloud Run reserved external path behavior. It uses backend ID-token authentication and no wildcard pass-through. Sensitive case/clinical/approval routes remain **unpublished** until end-user identity/RBAC is designed; Origin checks are not authorization. See [ROUTES.md](ROUTES.md) for the inspected existing surface.

The current REST Gateway cannot carry the Live WebSocket/streaming path. Also, Gateway's generated URL cannot be disabled by an ingress setting: clients can bypass the LB/Cloud Armor and reach Gateway directly. Consequently this is a platform foundation, not a complete secured voice-app deployment. A separate authorized streaming/access-control design is needed before publishing the patient application. API Gateway serverless NEG integration is documented as Preview and uses the beta provider.

Firebase is associated with the existing project. Web App `1:909914326545:web:67dafb82404f4a683353b0`, the default Hosting site and its live SPA release are Firebase CLI/Console-owned; Terraform retains Run, Gateway and IAM. The deployed runtime uses exact default Hosting origins and `enable_firebase_auth_routes=true`, publishing only GET/OPTIONS `/api/auth/me`; clinical routes remain unpublished and `dev_auth_uids` remains empty. Google login succeeded. `dev_patient_uids` grants only the minimum Patient role to explicitly reviewed verified UIDs; it never derives access from email. Do not create duplicate resources or put OAuth secrets in Terraform state. See [Firebase status and ownership](../../docs/firebase-hosting-auth.md).
## References

- [Firestore provider/import contract](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/firestore_database)
- [API Gateway deployment regions](https://docs.cloud.google.com/api-gateway/docs/deployment-model)
- [Gateway protocol limits](https://docs.cloud.google.com/api-gateway/docs/quotas)
- [Gateway load-balancing limitations](https://docs.cloud.google.com/api-gateway/docs/gateway-load-balancing)
- [Gateway serverless NEG setup](https://docs.cloud.google.com/api-gateway/docs/gateway-serverless-neg)
- [Authenticated Gateway backend invocation](https://docs.cloud.google.com/api-gateway/docs/securing-backend-services)
- [Cloud Run ingress](https://docs.cloud.google.com/run/docs/securing/ingress)

Provider field/import behavior was checked against installed 8.4.0 schemas and a live read-only adoption plan. Optional resources were schema-validated and provider-mocked, not deployed.
