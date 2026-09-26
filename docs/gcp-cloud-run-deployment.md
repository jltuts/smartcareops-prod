# SmartCareOps DEV Cloud Run deployment

Status: **DEV Cloud Run deployed** on 2026-09-24. Revision `smartcareops-api-00001-dhw` is ready. No API Gateway, load balancer, Cloud Armor or M13 work started.

## Deployment record

- URL: `https://smartcareops-api-2bylk5u5mq-as.a.run.app`; IAM invocation required.
- Service/region: `smartcareops-api` / `asia-southeast1`.
- Image tag: `95d3606574ef9f59fe3cc3fe5aab002751739a64`.
- Image URI: `asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:495ad0dd4eedb4470b1d7985958850ef0d3feda8b880759fbdd5408c88c3c3b9`.
- Plan: 0 imports, 1 create, 0 updates/deletes/replacements; all 19 foundation resources no-op. Apply: 1 added, 0 changed, 0 destroyed. Post-apply plan: no changes.
- Docker Desktop 4.92.0 / Engine 29.8.0, hello-world, Linux AMD64 build, local smoke and push passed. No Dockerfile changes were needed. Local container used non-root `node`, read-only filesystem, dropped capabilities and no credential mounts. `/healthz` and `/readyz` both returned 200 in memory mode; hosted-style missing-key readiness returned 503.
- Live authenticated `/readyz` and `/health`: 200. Direct platform `/healthz` startup/liveness probes passed; **external `/healthz` returns Google frontend 404**. Cloud Run reserves some paths ending in `z`; use `/health` externally and avoid new public paths ending in `z`. See [reserved URL paths](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths).
- Production readiness confirms a read-only Firestore startup operation through runtime identity and injected key presence. No Gemini request, secret-payload tooling access, case creation or hospital submission occurred.
- Cloud Logging verified startup, successful probes and authenticated 200 requests. Sampled logs contained no secret patterns.
- Security: audits 0 vulnerabilities; tracked/history scan 290 files/366 blobs, 0 findings. Layer inspection found no `.env`/service-account JSON or application key material. Generic private-key markers appeared in libraries/docs; remaining key material was in the unchanged public base-image GnuTLS library, whose SHA-256 matched the base exactly. No real secret was supplied to the build or local smoke.
- Terraform fmt/validate and 6 mocked plan tests passed. Test baseline inputs were made explicit so active auto-tfvars do not contaminate foundation tests.

Active deployment variables live in ignored `infra/terraform/cloudrun-dev.auto.tfvars`. The checked-in-safe `environments/dev/cloudrun.tfvars.example` records the exact non-secret settings. Restore it to the auto-tfvars path when operating this existing state from a new checkout. Do not plan against disabled defaults and attempt to remove the deployed service. Preserve local state and backups securely.

The remaining procedure below describes repeatable operations; the deployment record above is the evidence for this run.

## Container and readiness

Build from the repository root using `backend/Dockerfile`. Node 24.21.0 Debian slim, lockfile-based `npm ci --omit=dev --ignore-scripts`, separate dependency stage, non-root `node` user and explicit runtime-only copies keep credentials, tests and local files out. Root `.dockerignore` denies everything except dependency manifests, backend source and shared modules, with explicit sensitive-file exclusions. No secret build arguments or environment values are used. Inspect the actual build context and image layers before push; source review alone is not image verification.

The backend respects `PORT` and binds `0.0.0.0`. Production skips local `.env` loading. Cloud Run uses its attached service account and ADC, never a local credential mount. `/healthz` checks HTTP process liveness; `/readyz` remains 503 until required production startup configuration and a single Firestore read succeed, then serves the cached result. The read targets `_smartcareops_platform/readiness`, creates nothing and does not inspect patient cases. Missing document is acceptable. Gemini key presence is checked without calling Gemini. A failed startup check remains unready until a fresh process; readiness is not continuous dependency monitoring. Provider errors and document contents are not logged.

The first REST-focused image omits Chromium/system browser dependencies. M3 engine source and Playwright package remain preserved, but Computer Use execution is not supported by this slim image. A separately reviewed browser-capable image is required before enabling that explicit legacy fallback. Patient/doctor workflows are unchanged.

## Secret reference — ready

The operator uploaded version `1`, confirmed `ENABLED` using metadata only. Do not access the payload or upload another version for verification. Terraform now defaults `gemini_secret_version` to `"latest"` and permits either that alias or a numeric version. The existing Cloud Run `GEMINI_API_KEY` `value_source.secret_key_ref` references the existing `smartcareops-gemini-api-key` container; no literal secret value, secret-version resource or secret payload data source is used.

The runtime identity remains `smartcareops-runtime@gen-lang-client-0710663107.iam.gserviceaccount.com`, with its existing secret-scoped accessor membership. The `latest` alias is resolved for environment injection at instance startup: a later secret version can affect new instances without an image change. For rollback, explicitly select a known enabled numeric version in a reviewed plan rather than assuming the alias retains its previous target.

## Build and verify locally, then push

Prerequisite: a working local Linux Docker engine. Use a new release tag for future builds; the verified tag above must not be overwritten. Use an explicit release tag because the working tree contains uncommitted changes; do not label it solely with an unrelated Git commit. Do not overwrite an already published release tag.

```powershell
cd C:\Work\AI\googleaicupbuilder2026
$image = 'asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend:dev-cloudrun-20260924-01'
docker build --platform linux/amd64 -f backend/Dockerfile -t $image .
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
docker run --detach --name smartcareops-cloudrun-smoke --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:18080:8080 -e APP_ENV=development -e CASE_STORE=memory $image
if ($LASTEXITCODE -ne 0) { throw 'Container startup failed.' }
Invoke-RestMethod http://127.0.0.1:18080/healthz
Invoke-RestMethod http://127.0.0.1:18080/readyz
docker inspect smartcareops-cloudrun-smoke --format '{{.Config.User}}'
docker logs smartcareops-cloudrun-smoke
docker history --no-trunc $image
# After verification, remove only this disposable smoke container.
docker rm -f smartcareops-cloudrun-smoke
```

Retry health probes briefly while the process starts. Require HTTP 200 from both endpoints and user `node`. The smoke run deliberately uses memory, no key and no ADC; it verifies process packaging, not GCP connectivity. Inspect image filesystem/layers for credentials and unexpected files before publication. Test a production Firestore configuration with a missing key to confirm readiness fails closed. Do not mount local ADC into a deployed container.

Only after local checks pass:

```powershell
gcloud auth configure-docker asia-southeast1-docker.pkg.dev
docker push $image
if ($LASTEXITCODE -ne 0) { throw 'Image push failed.' }
docker inspect $image --format '{{json .RepoDigests}}'
```

Record the pushed `backend@sha256:...` URI and local verification evidence. The tag above is proposed, not an existing published image. Pin that real digest in the deployment variables.

## Terraform deployment gate

Service: `smartcareops-api`; project: `gen-lang-client-0710663107`; region: `asia-southeast1`; runtime identity: `smartcareops-runtime@gen-lang-client-0710663107.iam.gserviceaccount.com`.

Existing Cloud Run configuration uses 0–1 instances, 1 CPU, 512 MiB and concurrency 20. Keep these conservative defaults. Ingress remains `INGRESS_TRAFFIC_ALL` with IAM invocation required, allowing authenticated operator verification and later Gateway backend calls. No public invoker, VPC or edge resources are added. The future Live load-balancer route is not implemented in this phase.

Once prerequisites exist, create an ignored deployment variable file containing only `enable_cloud_run=true`, the real digest and `gemini_secret_version="latest"`; retain all other optional flags false. Use that same variable file for every subsequent plan. Do not enable Cloud Run with placeholders.

```powershell
cd C:\Work\AI\googleaicupbuilder2026\infra\terraform
terraform fmt -check
terraform validate
terraform plan '-var-file=cloudrun-dev.tfvars' '-out=cloudrun-dev.tfplan'
terraform show cloudrun-dev.tfplan
```

Stop on command failure. Review imports/creates/updates/deletes/replacements; expect only the Cloud Run service create against a clean foundation, with no persistent replacement, API disablement, IAM removal or Firestore/project change. Run the plan checker after exporting UTF-8 JSON, and review every difference. Apply only a current approved saved plan; unexpected destructive actions require a stop and explicit review. Never use `-target`, `-replace` or disable protections to force deployment.

After an authorized successful apply, rerun `terraform plan '-var-file=cloudrun-dev.tfvars'` and require no changes. Record the actual Cloud Run URL from Terraform output. The actual URL and results for this deployment are recorded above.

## Live verification and rollback

Use an authenticated operator with existing service invocation permission, for example `gcloud run services proxy smartcareops-api --project=gen-lang-client-0710663107 --region=asia-southeast1 --port=18081`, then probe localhost `/healthz` and `/readyz`. Do not grant public invocation to make probes work. Inspect a fresh revision's startup and Cloud Logging output without displaying secrets or patient data. Successful production readiness proves startup Firestore read access under runtime ADC and injected key presence, not Gemini validity, write access or ongoing upstream health. Do not submit a hospital case or invoke Computer Use.

For a later revision rollback, select the previously verified immutable image digest and secret version, review a new Terraform plan and apply it through the same approval process. For this first deployment there is no previous application revision: preserve the foundation and investigate a failed rollout; do not destroy infrastructure or remove deletion protection. After a partial apply, preserve state, inspect actual resources and generate a fresh plan rather than blindly retrying.

## Verification record and remaining work

- Focused readiness/health tests: 5 passed; full backend suite: 546 passed. Host production-mode smoke with an isolated environment, memory store, no key and no ADC: `/healthz` and `/readyz` both 200. This is not a container test.
- Root/backend npm audits: 0 vulnerabilities each. Tracked/reachable-history secret scan: 0 findings (61 files, 96 blobs).
- Terraform formatting and validation: passed; version-reference validation/default updated for the explicitly requested `latest` alias.
- Build, local verification, layer inspection, push, plan/apply, runtime readiness and logging completed; external `/healthz` has the documented frontend limitation. No browser fallback execution or Gemini model call was tested.
- User authentication/RBAC, Live session affinity/recovery and continuous dependency health remain outside this first infrastructure rollout. IAM must stay enforced while application endpoints lack end-user authorization.
- Next infrastructure phase after verified Cloud Run: API Gateway for REST traffic, under a separate instruction. No M13 or edge work started.

References: [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract), [local container testing](https://docs.cloud.google.com/run/docs/testing/local), [official Node image](https://hub.docker.com/_/node).
