variable "project_id" {
  type        = string
  default     = "gen-lang-client-0710663107"
  description = "Existing DEV project. Never creates or renames a project."
  validation {
    condition     = var.project_id == "gen-lang-client-0710663107"
    error_message = "This brownfield root is restricted to the inspected DEV project. Review inventory/imports before expanding scope."
  }
}
variable "region" {
  type    = string
  default = "asia-southeast1"
  validation {
    condition     = var.region == "asia-southeast1"
    error_message = "Keep the current DEV runtime/repository region in Singapore. Firestore location is separately fixed."
  }
}
variable "environment" {
  type    = string
  default = "dev"
  validation {
    condition     = var.environment == "dev"
    error_message = "This foundation does not provision production."
  }
}
variable "artifact_repository" {
  type    = string
  default = "smartcareops"
}
variable "cloud_run_service_name" {
  type    = string
  default = "smartcareops-api"
}
variable "container_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Real existing Artifact Registry image pinned by sha256 digest. No placeholder is deployed."
  validation {
    condition     = var.container_image == null ? true : can(regex("^asia-southeast1-docker\\.pkg\\.dev/gen-lang-client-0710663107/[a-z0-9-]+/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$", var.container_image))
    error_message = "Use an existing DEV Artifact Registry image pinned to its sha256 digest."
  }
}
variable "enable_cloud_run" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_cloud_run || (var.container_image != null && var.gemini_secret_version != null)
    error_message = "Cloud Run requires a real image and an existing Secret Manager version reference."
  }
}
variable "gemini_secret_version" {
  type        = string
  default     = "latest"
  description = "Secret Manager version number or latest alias only, never the secret value. Secret data is uploaded outside Terraform."
  validation {
    condition     = var.gemini_secret_version == null ? true : can(regex("^(latest|[1-9][0-9]*)$", var.gemini_secret_version))
    error_message = "Provide a numeric Secret Manager version or latest alias, never a credential."
  }
}
variable "demo_auth_secret_version" {
  type        = string
  default     = null
  nullable    = true
  description = "Secret Manager version containing the generated demo-account hashes and signing key. Null disables local demo authentication."
  validation {
    condition     = var.demo_auth_secret_version == null ? true : can(regex("^(latest|[1-9][0-9]*)$", var.demo_auth_secret_version))
    error_message = "Use an existing numeric Secret Manager version or latest."
  }
}
variable "allowed_origins" {
  type        = list(string)
  default     = ["https://gen-lang-client-0710663107.web.app", "https://gen-lang-client-0710663107.firebaseapp.com"]
  description = "Hosted defense-in-depth Origin gate; not authentication. Localhost is configured only in local backend/.env."
  validation {
    condition     = length(var.allowed_origins) > 0 && alltrue([for origin in var.allowed_origins : can(regex("^https?://[a-zA-Z0-9.:-]+$", origin))])
    error_message = "Use exact HTTP(S) origins without credentials, path, query or wildcard."
  }
}
variable "enable_firebase_auth_routes" {
  type        = bool
  default     = false
  description = "Publish only the identity endpoint after the Firebase-verifying backend is deployed."
}
variable "enable_hosted_live" {
  type        = bool
  default     = false
  description = "Deploy the isolated public WebSocket transport and authenticated one-time session bootstrap."
  validation {
    condition     = !var.enable_hosted_live || (var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "Hosted Live requires the IAM-protected API, API Gateway, and Firebase identity route."
  }
}
variable "enable_m15" {
  type        = bool
  default     = false
  description = "Enable the synthetic M15 network simulator and its Firebase-authenticated Command Center API routes."
  validation {
    condition     = !var.enable_m15 || (var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "M15 requires the Firebase-authenticated API and API Gateway."
  }
}
variable "enable_m16" {
  type        = bool
  default     = false
  description = "Enable CareTwin counterfactual planning and its Firebase-authenticated Command Center routes."
  validation {
    condition     = !var.enable_m16 || (var.enable_m15 && var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "M16 requires M15, the Firebase-authenticated API, and API Gateway."
  }
}
variable "enable_m17" {
  type        = bool
  default     = false
  description = "Enable M17 deterministic predictive interpretation and its Firebase-authenticated Command Center routes."
  validation {
    condition     = !var.enable_m17 || (var.enable_m16 && var.enable_m15 && var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "M17 requires M16, M15, the Firebase-authenticated API, and API Gateway."
  }
}
variable "enable_m18" {
  type        = bool
  default     = false
  description = "Enable synthetic aggregate cross-presentation pattern detection and its Firebase-authenticated Command Center routes."
  validation {
    condition     = !var.enable_m18 || (var.enable_m17 && var.enable_m16 && var.enable_m15 && var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "M18 requires M17, M16, M15, the Firebase-authenticated API, and API Gateway."
  }
}
variable "enable_m21" {
  type        = bool
  default     = false
  description = "Enable M21 role-aware in-app notifications, including persisted M18 alert awareness notices."
  validation {
    condition     = !var.enable_m21 || (var.enable_m18 && var.enable_m17 && var.enable_m16 && var.enable_m15 && var.enable_cloud_run && var.enable_api_gateway && var.enable_firebase_auth_routes)
    error_message = "M21 requires M18, M17, M16, M15, the Firebase-authenticated API, and API Gateway."
  }
}
variable "enable_m30" {
  type        = bool
  default     = false
  description = "Store newly submitted Patient evidence images in a private Cloud Storage bucket."
  validation {
    condition     = !var.enable_m30 || var.enable_cloud_run
    error_message = "M30 requires the authenticated Cloud Run API."
  }
}
variable "live_container_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional immutable image pin for the verified Live transport. When null, Live follows container_image."
  validation {
    condition     = var.live_container_image == null ? true : can(regex("^asia-southeast1-docker\\.pkg\\.dev/gen-lang-client-0710663107/[a-z0-9-]+/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$", var.live_container_image))
    error_message = "Use an existing DEV Artifact Registry Live image pinned to its sha256 digest."
  }
}
variable "enable_m60_agent_runtime" {
  type        = bool
  default     = false
  description = "Provision the isolated M60 fictional-data Clinical Review Agent Runtime. It is not an application cutover flag."
  validation {
    condition     = !var.enable_m60_agent_runtime || var.m60_agent_container_image != null
    error_message = "M60 Agent Runtime requires an existing digest-pinned image."
  }
}
variable "m60_agent_container_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Immutable M60 runtime image in the existing Singapore Artifact Registry repository."
  validation {
    condition     = var.m60_agent_container_image == null ? true : can(regex("^asia-southeast1-docker\\.pkg\\.dev/gen-lang-client-0710663107/smartcareops/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$", var.m60_agent_container_image))
    error_message = "Use a digest-pinned M60 image from the existing SmartCareOps Singapore repository."
  }
}
variable "enable_m60_phase_d_foundation" {
  type        = bool
  default     = false
  description = "Plan the approved fictional M60 policy corpus and inspect-only Model Armor foundation. Does not import files, attach an Agent Gateway, or enable application traffic."
  validation {
    condition = !var.enable_m60_phase_d_foundation || (
      var.enable_m60_agent_runtime &&
      var.m60_policy_corpus_version == "m60-fictional-v1" &&
      var.m60_policy_manifest_digest == "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    )
    error_message = "Phase D requires the enabled M60 runtime and the exact approved fictional corpus version and manifest digest."
  }
}
variable "m60_policy_corpus_version" {
  type        = string
  default     = null
  nullable    = true
  description = "Approved immutable M60 policy corpus version; null while Phase D is disabled."
}
variable "m60_policy_manifest_digest" {
  type        = string
  default     = null
  nullable    = true
  description = "SHA-256 of the approved immutable M60 policy manifest; null while Phase D is disabled."
  validation {
    condition     = var.m60_policy_manifest_digest == null ? true : can(regex("^[a-f0-9]{64}$", var.m60_policy_manifest_digest))
    error_message = "M60 policy manifest digest must be a lowercase SHA-256 value."
  }
}
variable "enable_m60_application_client" {
  type        = bool
  default     = false
  description = "Install the default-off Phase E managed clinical client and grant the API runtime query-only access to the single M60 Reasoning Engine. Does not enable shadow or review traffic."
  validation {
    condition = !var.enable_m60_application_client || (
      var.enable_cloud_run && var.enable_m60_agent_runtime && var.enable_m60_phase_d_foundation &&
      var.m60_policy_corpus_version == "m60-fictional-v1" &&
      var.m60_policy_manifest_digest == "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    )
    error_message = "The Phase E client requires Cloud Run, the managed M60 runtime, and the exact accepted Phase D fictional corpus."
  }
}
variable "enable_m60_application_shadow" {
  type        = bool
  default     = false
  description = "Enable a bounded, non-publishing M60 shadow observation for an exact fictional case cohort. The existing clinical model remains authoritative."
  validation {
    condition     = !var.enable_m60_application_shadow || var.enable_m60_application_client
    error_message = "M60 application shadow requires the installed Phase E application client."
  }
}
variable "enable_m60_application_review" {
  type        = bool
  default     = false
  description = "Enable the managed M60 clinical assessment for an exact fictional demo case cohort and time window. The existing clinical model remains the automatic fallback."
  validation {
    condition = !var.enable_m60_application_review || (
      var.enable_m60_application_client && !var.enable_m60_application_shadow
    )
    error_message = "M60 application review requires the Phase E application client and cannot run at the same time as shadow mode."
  }
}
variable "m60_shadow_case_ids" {
  type        = list(string)
  default     = []
  description = "One to ten exact fictional SmartCareOps case IDs eligible for bounded M60 shadow or review."
  validation {
    condition = !(var.enable_m60_application_shadow || var.enable_m60_application_review) ? true : (
      length(var.m60_shadow_case_ids) >= 1 &&
      length(var.m60_shadow_case_ids) <= 10 &&
      length(distinct(var.m60_shadow_case_ids)) == length(var.m60_shadow_case_ids) &&
      alltrue([for case_id in var.m60_shadow_case_ids : can(regex("^SC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", case_id))])
    )
    error_message = "M60 shadow or review requires one to ten unique exact fictional SC UUID case IDs."
  }
}
variable "m60_shadow_start_at" {
  type        = string
  default     = null
  nullable    = true
  description = "Inclusive RFC3339 UTC start of the bounded M60 shadow or review window."
}
variable "m60_shadow_end_at" {
  type        = string
  default     = null
  nullable    = true
  description = "Exclusive RFC3339 UTC end of the bounded M60 shadow or review window, no more than 24 hours after start."
  validation {
    condition = !(var.enable_m60_application_shadow || var.enable_m60_application_review) ? true : (
      var.m60_shadow_start_at != null &&
      var.m60_shadow_end_at != null &&
      can(formatdate("YYYY-MM-DD'T'hh:mm:ssZ", var.m60_shadow_start_at)) &&
      can(formatdate("YYYY-MM-DD'T'hh:mm:ssZ", var.m60_shadow_end_at)) &&
      try(timecmp(var.m60_shadow_start_at, var.m60_shadow_end_at) < 0, false) &&
      try(timecmp(var.m60_shadow_end_at, timeadd(var.m60_shadow_start_at, "24h")) <= 0, false)
    )
    error_message = "M60 shadow or review requires valid RFC3339 timestamps with start before end and a window no longer than 24 hours."
  }
}
variable "enable_m55" {
  type        = bool
  default     = false
  description = "Provision the dormant M55 Singapore Pub/Sub event plane. Application publishers and consumers remain disabled until separately enabled."
}
variable "enable_m55_workers" {
  type        = bool
  default     = false
  description = "Run the isolated M55 outbox publisher and audit consumer. Requires the reviewed Pub/Sub foundation and Cloud Run image."
  validation {
    condition     = !var.enable_m55_workers || (var.enable_m55 && var.enable_cloud_run && var.container_image != null)
    error_message = "M55 workers require the M55 Pub/Sub foundation and a pinned Cloud Run image."
  }
}
variable "enable_m55_operations_worker" {
  type        = bool
  default     = false
  description = "Run the isolated M55 operations projection receiver in shadow mode. It does not change Command Center reads."
  validation {
    condition     = !var.enable_m55_operations_worker || var.enable_m55_workers
    error_message = "The M55 operations projection receiver requires the reviewed M55 worker foundation."
  }
}
variable "enable_m55_operations_source" {
  type        = bool
  default     = false
  description = "Atomically publish metadata-only case.created references from the API outbox. Existing synchronous case handling remains authoritative."
  validation {
    condition     = !var.enable_m55_operations_source || var.enable_m55_operations_worker
    error_message = "The M55 operations source requires the reviewed Operations projection receiver."
  }
}
variable "enable_m57_agentic_operations" {
  type        = bool
  default     = false
  description = "Let the private Operations consumer wake the bounded Operations agent for case.created events. Existing Patient and synchronous case paths remain authoritative."
  validation {
    condition     = !var.enable_m57_agentic_operations || (var.enable_m55_operations_source && var.gemini_secret_version != null)
    error_message = "M57 agentic Operations requires the reviewed M55 Operations source and a configured Gemini secret version."
  }
}
variable "enable_m57_operations_capacity_source" {
  type        = bool
  default     = false
  description = "Atomically publish metadata-only hospital.capacity.changed events from the fictional Command Center capacity control."
  validation {
    condition     = !var.enable_m57_operations_capacity_source || var.enable_m57_agentic_operations
    error_message = "The M57 capacity source requires the reviewed event-driven Operations consumer."
  }
}
variable "enable_m57_reviewed_coordination" {
  type        = bool
  default     = false
  description = "Expose the existing bounded Operations review surface and enable simulated coordination tools for event-driven plans. High-impact effects retain human approval and receipts."
  validation {
    condition     = !var.enable_m57_reviewed_coordination || var.enable_m57_agentic_operations
    error_message = "M57 reviewed coordination requires the event-driven Operations agent."
  }
}

variable "enable_m43_gateway_routes" {
  description = "Publish the earlier M43 emergency-response coordination routes through API Gateway. This remains explicit so an unrelated rollout cannot expose them."
  type        = bool
  default     = false
}
variable "live_cloud_run_service_name" {
  type        = string
  default     = "smartcareops-live"
  description = "Isolated application-authenticated WebSocket transport; it exposes no REST application routes."
}
variable "dev_auth_uids" {
  type        = list(string)
  default     = ["pjS8nkgyJHcCOLFOwdQnIgSYy6v1"]
  description = "Operator-approved Firebase UIDs for shared fictional DEV workspace access; empty grants no demo roles. Not tokens."
  validation {
    condition     = alltrue([for uid in var.dev_auth_uids : can(regex("^[A-Za-z0-9_-]{1,128}$", uid))])
    error_message = "Use explicit Firebase UIDs, not emails, roles, or tokens."
  }
}
variable "dev_patient_uids" {
  type        = list(string)
  default     = []
  description = "Verified Firebase UIDs granted only the DEV Patient role. Not emails or tokens."
  validation {
    condition     = alltrue([for uid in var.dev_patient_uids : can(regex("^[A-Za-z0-9_-]{1,128}$", uid))])
    error_message = "Use explicit Firebase UIDs, not emails, roles, or tokens."
  }
}
variable "admin_uids" {
  type        = list(string)
  default     = ["NufeiTKjifPcswOI3q7HlZige2u1", "pjS8nkgyJHcCOLFOwdQnIgSYy6v1"]
  description = "Firebase UIDs allowed to administer access and test data; empty disables the Admin role."
  validation {
    condition     = length(distinct(var.admin_uids)) == length(var.admin_uids) && alltrue([for uid in var.admin_uids : can(regex("^[A-Za-z0-9_-]{1,128}$", uid))])
    error_message = "Configure each Admin once using an exact Firebase Authentication UID."
  }
}

variable "purge_protected_google_emails" {
  type        = list(string)
  default     = ["johnlouisgarcia@gmail.com", "chebulay.12@gmail.com"]
  description = "Google Firebase Authentication emails that test-data purge must retain."
  validation {
    condition = length(var.purge_protected_google_emails) == 2 && length(distinct([
      for email in var.purge_protected_google_emails : lower(trimspace(email))
      ])) == 2 && alltrue([
      for email in var.purge_protected_google_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))
    ])
    error_message = "Configure exactly two distinct protected Google account email addresses."
  }
}
variable "enable_api_gateway" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_api_gateway || (var.enable_cloud_run && var.gateway_region != null)
    error_message = "Gateway requires Cloud Run and an explicitly selected supported gateway region."
  }
}
variable "api_gateway_name" {
  type    = string
  default = "smartcareops-dev"
}
variable "gateway_region" {
  type        = string
  default     = null
  description = "Explicit choice required: asia-southeast1 is not a documented API Gateway region. NEG must use this same region."
  validation {
    condition     = var.gateway_region == null ? true : contains(["asia-northeast1", "australia-southeast1", "europe-west1", "europe-west2", "us-east1", "us-east4", "us-central1", "us-west2", "us-west3", "us-west4"], var.gateway_region)
    error_message = "Select a documented API Gateway region and review cross-region latency/residency."
  }
}
variable "enable_load_balancer" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_load_balancer || (var.enable_api_gateway && var.domain_name != null)
    error_message = "HTTPS load balancing requires Gateway and a domain you control."
  }
}
variable "domain_name" {
  type        = string
  default     = null
  description = "Real DNS name you control; DNS records remain outside Terraform."
  validation {
    condition     = var.domain_name == null ? true : can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.domain_name))
    error_message = "Supply a DNS hostname, not a URL or wildcard."
  }
}
variable "enable_monitoring" {
  type    = bool
  default = false
  validation {
    condition     = !var.enable_monitoring || var.enable_cloud_run
    error_message = "Runtime monitoring requires an actual Cloud Run service."
  }
}
variable "notification_channels" {
  type        = list(string)
  default     = []
  description = "Existing Monitoring channel resource names only. Terraform creates no email/SMS contacts. Empty means incidents have no notification delivery."
}
