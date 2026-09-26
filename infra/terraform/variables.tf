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
variable "live_cloud_run_service_name" {
  type        = string
  default     = "smartcareops-live"
  description = "Isolated application-authenticated WebSocket transport; it exposes no REST application routes."
}
variable "dev_auth_uids" {
  type        = list(string)
  default     = []
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
