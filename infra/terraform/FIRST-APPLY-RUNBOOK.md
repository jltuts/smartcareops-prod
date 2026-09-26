# SmartCareOps — Terraform First Apply Runbook

Purpose:

- Perform the first controlled Terraform apply for DEV.
- Adopt the existing Firestore/API resources.
- Create only the approved foundation resources.
- Avoid destructive changes.
- Do not enable deferred runtime/edge resources yet.

Working directory: `C:\Work\AI\googleaicupbuilder2026\infra\terraform`.

**This document is an operator procedure, not authorization to apply. Terraform apply has not been executed as part of preparing this runbook. Do not start M13.**

Before starting, read [PLAN.md](PLAN.md), [README.md](README.md) and [IMPORT.md](IMPORT.md). Use Terraform 1.16.4 on PATH, Python, Google Cloud CLI and existing valid Application Default Credentials. Providers remain pinned to 8.4.0 through the checked-in lock file. Confirm DEV project access, billing, quotas and permissions; a successful plan does not prove apply permissions. Do not read or change `backend/.env`, download service-account keys or rotate credentials.

Use one operator and the existing local backend/workspace. Protect plan/state files with OS access controls and encrypted backups outside Git. Do not migrate the backend, upgrade providers, or use a different empty state. Stop on any command failure. The commands below assume the reviewed default variables; inspect any automatically loaded `.tfvars` files and `TF_VAR_*` / `TF_CLI_ARGS*` overrides privately before planning. Never print credential values.

## 1. Initialize Terraform

```powershell
cd C:\Work\AI\googleaicupbuilder2026\infra\terraform
terraform init
```

Confirm successful initialization of the **local** backend and locked providers. If Terraform asks to migrate/reconfigure state or unexpectedly changes the lock file, stop for review. Do not use `-upgrade`.

## 2. Validate the foundation

```powershell
terraform fmt -check -recursive
if ($LASTEXITCODE -ne 0) { throw 'Terraform formatting check failed.' }
terraform validate
if ($LASTEXITCODE -ne 0) { throw 'Terraform validation failed.' }
terraform test
if ($LASTEXITCODE -ne 0) { throw 'Terraform tests failed.' }
terraform workspace show
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify Terraform workspace.' }
```

Expect five provider-mocked, plan-only tests to pass. Their synthetic optional-infrastructure fixture is not an approved deployment plan. Confirm the existing `default` workspace. If managed state already exists, inspect its provenance before continuing: this may no longer be a first apply. Preserve and securely back up any existing state and backups.

## 3. Generate a fresh saved plan

Preserve `dev-review.tfplan` as the historical reviewed artifact. Its recorded SHA-256 is `6705303d3054c4b1380bcdc33b7e068489a4f1c69805014a842944ce4b441d65` (2026-09-24). Generate a fresh plan for approval; its hash will generally differ.

```powershell
terraform plan '-input=false' '-no-color' '-out=first-apply.tfplan'
if ($LASTEXITCODE -ne 0) { throw 'Plan failed; do not apply.' }
terraform show '-no-color' first-apply.tfplan
if ($LASTEXITCODE -ne 0) { throw 'Cannot read saved plan.' }
$firstApplyJson = terraform show '-json' first-apply.tfplan
if ($LASTEXITCODE -ne 0) { throw 'Cannot export saved plan.' }
$firstApplyJson | Set-Content -LiteralPath first-apply.plan.json -Encoding utf8
python check-plan.py first-apply.plan.json
if ($LASTEXITCODE -ne 0) { throw 'Plan safety check failed; do not apply.' }
Get-FileHash -LiteralPath first-apply.tfplan -Algorithm SHA256
```

The UTF-8 export also works with Windows PowerShell. Treat binary and JSON plans as sensitive metadata; keep them ignored and access-controlled. The checker supplements full human review and does not authorize execution. Do not use `-target`, `-replace`, `-refresh=false` or `-auto-approve`.

## 4. Review every action against the approved scope

Expected baseline: **3 imports, 16 creates, 3 in-place updates, 0 deletes, 0 replacements**. The three imports and three updates refer to the same three resources. Any difference requires investigation and fresh approval, even if the checker passes.

### IMPORT

| Terraform address | Existing resource ID |
|---|---|
| `google_firestore_database.existing` | `projects/gen-lang-client-0710663107/databases/(default)` |
| `google_project_service.required["firestore.googleapis.com"]` | `gen-lang-client-0710663107/firestore.googleapis.com` |
| `google_project_service.required["generativelanguage.googleapis.com"]` | `gen-lang-client-0710663107/generativelanguage.googleapis.com` |

Use the existing declarative import blocks. Do not additionally run CLI imports in this sequence. Adoption is completed when the approved plan is applied and state is written.

### CREATE

| Terraform address | Purpose/location |
|---|---|
| `google_artifact_registry_repository.backend` | Docker repository `smartcareops`, `asia-southeast1` |
| `google_service_account.runtime` | Project-level identity `smartcareops-runtime` |
| `google_project_iam_member.runtime_firestore` | Add `roles/datastore.user` for runtime in the existing project |
| `google_secret_manager_secret.gemini` | Empty `smartcareops-gemini-api-key` container; global automatic replication |
| `google_secret_manager_secret_iam_member.runtime_gemini` | Add runtime `roles/secretmanager.secretAccessor` on this secret only |

The other eleven creates are project-level API enablements at `google_project_service.required["SERVICE"]`, one for each service:

- `apigateway.googleapis.com`
- `artifactregistry.googleapis.com`
- `iam.googleapis.com`
- `iamcredentials.googleapis.com`
- `logging.googleapis.com`
- `monitoring.googleapis.com`
- `run.googleapis.com`
- `secretmanager.googleapis.com`
- `servicecontrol.googleapis.com`
- `servicemanagement.googleapis.com`
- `serviceusage.googleapis.com`

Together with the two adopted APIs, Terraform manages thirteen API services. Existing Datastore and Firebase Rules APIs remain unmanaged and enabled. Enabling APIs does not deploy their optional runtime resources.

Review cost exposure: future artifact storage/transfer, secret versions/access and service usage can incur charges. IAM grants and API enablement alone do not provision a running workload. Existing Firestore/Gemini usage continues to incur its existing charges. This plan uploads neither images nor secret versions.

### UPDATE

| Terraform address | Current → proposed | Expected effect |
|---|---|---|
| `google_firestore_database.existing` | `delete_protection_state`: `DELETE_PROTECTION_DISABLED` → `DELETE_PROTECTION_ENABLED`; `deletion_policy`: `ABANDON` → `PREVENT` | Enable server-side deletion protection and Terraform deletion prevention only; no expected data or availability change |
| `google_project_service.required["firestore.googleapis.com"]` | `deletion_policy`: `DELETE` → `ABANDON`; `disable_on_destroy`: `null` → `false`; `disable_dependent_services`: `null` → `false` | Record retention behavior for imported API; no API disablement or expected availability change |
| `google_project_service.required["generativelanguage.googleapis.com"]` | Same API policy/flag changes as above | Record retention behavior for imported API; no API disablement or expected availability change |

The imported API null flags are provider-state values, not evidence that an API is disabled.

### DELETE

**Zero.**

### REPLACE

**Zero.**

### Required approval checklist

- Firestore remains project `gen-lang-client-0710663107`, database `(default)`, location `asia-southeast1`, `FIRESTORE_NATIVE`, edition `STANDARD`. Concurrency remains `PESSIMISTIC`; PITR remains disabled. Only deletion safeguards change. No database replacement or document deletion is planned.
- The existing project is a read-only data source: no creation, deletion or rename. Its current display name `smartcareops` remains unchanged.
- IAM uses additive member resources only: no Owner/Editor, public grants, authoritative policy/binding or removal of existing users. `roles/datastore.user` grants application data read/write access at project scope; acknowledge that scope when approving the runtime identity.
- Secret container only: no secret-version/key resource, credential input or secret value in configuration, variables, plan or state. Review locally without copying sensitive artifacts into chat or Git.
- Every managed API retains `disable_on_destroy=false`, `disable_dependent_services=false` and `deletion_policy="ABANDON"`. No API disablement.
- All four flags remain false: `enable_cloud_run`, `enable_api_gateway`, `enable_load_balancer`, `enable_monitoring`. Cloud Armor is also disabled because it is gated by `enable_load_balancer`; there is no separate Armor flag. No corresponding runtime, edge or monitoring resources appear in the plan.
- No image, secret version, domain or Gateway region is supplied. Missing deployment prerequisites remain deferred.
- No DELETE or REPLACE anywhere, particularly for persistent resources. No application deployment, credential upload, new milestone or application-data migration.

Disabled APIs limited the original Artifact Registry/Secret Manager/runtime inventory. Review known names and billing/organization-policy constraints before approval. If an existing-resource collision becomes visible after authorized API enablement, stop and follow the failure procedure below; do not delete the existing resource to make creation succeed.

## 5. STOP — obtain approval for this exact saved plan

Record the reviewer, approval time, complete action review and SHA-256 of `first-apply.tfplan` in the operator's approved change record. Approval must explicitly authorize this DEV foundation apply. Creating this runbook, a previous simulated hospital approval, or approval of an older plan does not authorize it.

Do not proceed without that approval. If configuration, variables, state, credentials/project selection or cloud inventory changes, or the plan is no longer current, regenerate and review a new plan. Do not overwrite the approved artifact and reuse its approval.

## 6. Apply only the approved saved plan

**Operator-only, after step 5. Applying a saved plan does not provide Terraform's usual interactive approval prompt.** Verify the hash immediately before running the apply command:

```powershell
$approvedPlanSha256 = Read-Host 'Enter the SHA-256 from the explicit plan approval'
$actualPlanSha256 = (Get-FileHash -LiteralPath first-apply.tfplan -Algorithm SHA256).Hash
if ($actualPlanSha256 -ine $approvedPlanSha256.Trim()) { throw 'Approved plan hash mismatch; stop.' }
terraform apply '-input=false' first-apply.tfplan
if ($LASTEXITCODE -ne 0) { throw 'Apply failed or partially completed. Follow the recovery procedure; do not retry blindly.' }
```

Do not substitute plain `terraform apply`, generate a new implicit plan or append variable overrides. Retain the local state and securely back it up after execution.

## 7. Verify the result without changing resources

```powershell
terraform state list
if ($LASTEXITCODE -ne 0) { throw 'Cannot read managed state.' }
terraform output
if ($LASTEXITCODE -ne 0) { throw 'Cannot read outputs.' }
gcloud firestore databases describe '--project=gen-lang-client-0710663107' '--database=(default)'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify Firestore metadata.' }
gcloud artifacts repositories describe smartcareops '--project=gen-lang-client-0710663107' '--location=asia-southeast1'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify repository.' }
gcloud iam service-accounts describe smartcareops-runtime@gen-lang-client-0710663107.iam.gserviceaccount.com '--project=gen-lang-client-0710663107'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify runtime identity.' }
gcloud secrets describe smartcareops-gemini-api-key '--project=gen-lang-client-0710663107'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify secret metadata.' }
gcloud secrets versions list smartcareops-gemini-api-key '--project=gen-lang-client-0710663107'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify secret version inventory.' }
gcloud services list --enabled '--project=gen-lang-client-0710663107'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify enabled APIs.' }
terraform plan '-input=false' '-no-color' '-detailed-exitcode'
$postApplyPlanExitCode = $LASTEXITCODE
if ($postApplyPlanExitCode -eq 1) { throw 'Post-apply plan failed.' }
if ($postApplyPlanExitCode -eq 2) { throw 'Post-apply differences require review; do not apply again automatically.' }
if ($postApplyPlanExitCode -ne 0) { throw 'Unexpected post-apply plan exit code.' }
```

Confirm Firestore identity/mode/edition are unchanged and deletion protection is enabled; the secret has **zero versions**; the thirteen managed APIs are enabled and previously enabled APIs remain enabled. Check IAM membership and scope against the reviewed plan using read-only IAM inspection. Confirm state has the nineteen expected managed addresses (sixteen creates plus three imports), with no optional runtime/edge/monitoring resources. Read-only data sources may also appear in state.

Expect the final plan to report **no changes** (exit code 0). Metadata checks alone do not establish application data integrity: confirm existing application read-only health/data access through the normal authorized DEV workflow without creating cases or external actions. Record any verification limitation. Save verification results and an encrypted state backup; do not commit state, plans or credentials.

## 8. Handle failure or partial completion

Terraform apply is not an atomic transaction. A failure can leave enabled APIs, adopted resources or newly created resources in place.

1. Stop. Preserve state, backups, the reviewed plan and sanitized error details. Do not blindly rerun the saved plan.
2. Inspect state and actual GCP inventory read-only. Resolve permissions, quota or naming conflicts through a separately reviewed action.
3. If a resource already exists, review its identity and import requirements using [IMPORT.md](IMPORT.md). Never delete it to satisfy a create operation.
4. Generate a fresh full plan against the preserved state. Obtain new approval before any further apply or state-changing import.
5. Do not use `terraform destroy`, remove state, remove deletion protection, force replacement or use targeted execution as rollback. Recovery must preserve existing SmartCareOps data and availability.

## 9. Close the foundation change

Record the approved plan hash, operator, apply result, imports/creates/updates, verification results and secure state-backup location. Explicitly record zero deletes/replacements and that deferred resources remain disabled. If anything is incomplete, record it as unresolved rather than reporting a successful foundation rollout.

Secret upload, image build/push, Cloud Run, API Gateway, load balancer, Cloud Armor, monitoring and backend migration each remain outside this first apply. They require their prerequisites, a separate reviewed plan where applicable and explicit authorization. Do not start M13.



# STEPS
cd C:\Work\AI\googleaicupbuilder2026\infra\terraform
terraform init
terraform plan "-out=dev-final.tfplan"
