# DEV inventory and adoption

Inspected 2026-09-24 using existing local gcloud/ADC credentials. No cloud mutations, actual state imports, API enablement, credential reads/rotation or apply were performed. Plan-time declarative imports read metadata and are not completed adoption until an approved apply writes state.

## Existing inventory

| Resource | Status / Terraform address | Adoption and expected plan | Risk |
|---|---|---|---|
| Project `gen-lang-client-0710663107`, number `909914326545`, display name `smartcareops`, ACTIVE | Existing; `data.google_project.existing` | Read-only reference, no import/create/rename | Never introduce `google_project` here |
| Firestore `(default)`, Native, STANDARD, Singapore, PESSIMISTIC, PITR disabled | Existing; `google_firestore_database.existing` | Import; one intentional in-place protection update; no location/mode/edition/concurrency/PITR/data changes | Persistent application data: reject every replacement/delete/create |
| `firestore.googleapis.com` | Enabled; `google_project_service.required["firestore.googleapis.com"]` | Import; state-side deletion policy becomes ABANDON; service stays enabled | Never disable on destroy |
| `generativelanguage.googleapis.com` | Enabled; `google_project_service.required["generativelanguage.googleapis.com"]` | Import; state-side deletion policy becomes ABANDON; existing Gemini access stays enabled | No API-key/IAM changes for existing credentials |
| `datastore.googleapis.com` | Enabled, unmanaged | No import/change; preserve existing dependency | Do not disable |
| `firebaserules.googleapis.com` | Enabled, unmanaged | No import/change; no Firebase association inferred | Do not disable or replace Firebase resources |
| `ais-gemini-key-67d6c22202814b5@909914326545.iam.gserviceaccount.com` | Existing enabled account, display name Gemini API Key; unmanaged | No import or IAM/credential changes | Preserve existing developer access |
| Storage buckets | Read-only project list returned no buckets | No approved remote-state bucket; local backend only | No automatic bootstrap |
| Run services / Secret Manager / Artifact Registry | Inventory unavailable while APIs disabled (Artifact Registry CLI also returned an SDK error) | Treat new names as proposed, not proof of absence; re-inventory before apply | Import any discovered naming collision instead of recreating |
| API keys | Alpha metadata command unavailable; key strings were never queried | Existing Gemini credential remains unmanaged | Do not infer absence or rotate |
| Firebase association/Hosting/Auth | No repository config/web SDK; project labels empty; cloud resources not conclusively inventoried | Remain outside this root; inspect before any future enablement/import | Avoid duplicate association/site/user configuration |

## Exact imports

Run from `infra/terraform` after `terraform init`, **if choosing CLI import instead of the checked-in declarative imports**:

```powershell
terraform import google_firestore_database.existing 'projects/gen-lang-client-0710663107/databases/(default)'
```

The full identifier above is verified against Google provider 8.4.0 and the successful live plan. It avoids an ambiguous short `(default)` identifier. The project itself is not imported because it is only a data source.

The service identifiers are `gen-lang-client-0710663107/firestore.googleapis.com` and `gen-lang-client-0710663107/generativelanguage.googleapis.com`. Shell-neutral Terraform addresses are exactly the bracketed addresses in the table. In Bash, the CLI alternatives are:

```sh
terraform import 'google_project_service.required["firestore.googleapis.com"]' 'gen-lang-client-0710663107/firestore.googleapis.com'
terraform import 'google_project_service.required["generativelanguage.googleapis.com"]' 'gen-lang-client-0710663107/generativelanguage.googleapis.com'
```

On Windows, prefer the provided `imports.tf` to avoid native-command quote differences between PowerShell versions. Do not change resource addresses just to work around quoting. CLI import only writes local state; it does not replace the requirement to review the subsequent plan. Never import the same resource into multiple states.

`google_project_service` can safely enable/adopt a service already enabled without disabling it. We explicitly import the two observed, required services to show ownership in the first plan. Other required APIs are modeled as enables; if already enabled by another operator before apply, re-inventory and add their import where appropriate. Both `disable_on_destroy=false` and `deletion_policy="ABANDON"` protect services. Version 8.4.0 initially reports imported disable flags as null; explicit abandonment avoids relying on that import-state ambiguity.

## New resources, no import expected

| Address | Proposed object | Initial plan |
|---|---|---|
| `google_project_service.required[...]` for eleven remaining entries in `locals.tf` | Required platform APIs | 11 CREATE/enable actions; none disabled |
| `google_artifact_registry_repository.backend` | Singapore Docker repo `smartcareops` | CREATE, lifecycle protected |
| `google_service_account.runtime` | `smartcareops-runtime` | CREATE, lifecycle protected |
| `google_project_iam_member.runtime_firestore` | Additive runtime `roles/datastore.user` member | CREATE; preserves other access |
| `google_secret_manager_secret.gemini` | Empty `smartcareops-gemini-api-key` container | CREATE; protected; no secret version |
| `google_secret_manager_secret_iam_member.runtime_gemini` | Accessor on that one secret | CREATE; no project-wide secret accessor |

Optional, disabled resources: `google_cloud_run_v2_service.api[0]`; `google_service_account.gateway[0]`; `google_cloud_run_v2_service_iam_member.gateway_invoker[0]`; `google_api_gateway_api.api[0]`; `google_api_gateway_api_config.health[0]`; `google_api_gateway_gateway.api[0]`; `google_compute_region_network_endpoint_group.gateway[0]`; `google_compute_backend_service.gateway[0]`; `google_compute_url_map.api[0]`; `google_compute_global_address.api[0]`; `google_compute_managed_ssl_certificate.api[0]`; `google_compute_target_https_proxy.api[0]`; `google_compute_global_forwarding_rule.https[0]`; `google_compute_security_policy.edge[0]`; `google_monitoring_alert_policy.errors[0]`; `google_monitoring_uptime_check_config.health[0]`; `google_monitoring_alert_policy.availability[0]`; `google_monitoring_dashboard.api[0]`.

These have **no actions in the initial live plan**. An explicit enablement requires a new inventory and reviewed plan. If an existing object is discovered under a proposed name, stop before apply and use that resource's installed-provider import contract. Do not fabricate inventory/import IDs for inaccessible services.

## Plan review checklist

1. Firestore is imported; never CREATE, DELETE or REPLACE. Only protection may change.
2. Existing project identity/display name remain untouched.
3. Existing APIs remain enabled; no authoritative IAM policy/binding is introduced.
4. Foundation creations match the table; optional deployments stay absent until prerequisites are real.
5. State is local and ignored. Secret values and application documents never enter Terraform.
6. Review the fresh saved plan and `check-plan.py` results. Apply only after explicit user approval.
