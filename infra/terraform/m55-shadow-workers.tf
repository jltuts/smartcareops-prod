variable "enable_m55_clinical_shadow_worker" {
  type        = bool
  default     = false
  description = "Receive clinical-family Pub/Sub metadata into an isolated shadow projection; no clinical analysis or case changes."
  validation {
    condition     = !var.enable_m55_clinical_shadow_worker || var.enable_m55_workers
    error_message = "The clinical shadow worker requires the reviewed M55 worker foundation."
  }
}

variable "enable_m55_notifications_shadow_worker" {
  type        = bool
  default     = false
  description = "Receive notifications-family Pub/Sub metadata into an isolated shadow projection; no notification delivery."
  validation {
    condition     = !var.enable_m55_notifications_shadow_worker || var.enable_m55_workers
    error_message = "The notifications shadow worker requires the reviewed M55 worker foundation."
  }
}

variable "m55_shadow_container_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Separate immutable DEV Artifact Registry image for the clinical and notifications shadow workers."
  validation {
    condition = !(var.enable_m55_clinical_shadow_worker || var.enable_m55_notifications_shadow_worker) || (
      var.m55_shadow_container_image != null &&
      can(regex("^asia-southeast1-docker\\.pkg\\.dev/gen-lang-client-0710663107/[a-z0-9-]+/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$", var.m55_shadow_container_image))
    )
    error_message = "Enabled shadow workers require a separately pinned DEV Artifact Registry image digest."
  }
}

variable "enable_m55_case_processing" {
  type        = bool
  default     = false
  description = "Process committed case lifecycle events into Doctor-only clinical assessments and fictional role-scoped in-app notices."
  validation {
    condition = !var.enable_m55_case_processing || (
      var.enable_m55_clinical_shadow_worker && var.enable_m55_notifications_shadow_worker &&
      var.enable_m55_operations_source && var.enable_cloud_run && var.gemini_secret_version != null
    )
    error_message = "Case processing requires both existing shadow receivers, the case outbox publisher, the API, and a Gemini secret version."
  }
}

locals {
  m55_shadow_workers = {
    for family, enabled in {
      clinical      = var.enable_m55_clinical_shadow_worker
      notifications = var.enable_m55_notifications_shadow_worker
    } : family => "smartcareops-${family}-shadow-worker" if enabled
  }
}

resource "google_service_account" "event_shadow_push_invoker" {
  for_each     = local.m55_shadow_workers
  project      = var.project_id
  account_id   = each.key == "notifications" ? "smartcareops-notify-push" : "smartcareops-clinical-push"
  display_name = "SmartCareOps DEV ${each.key} push invoker"
  description  = "Invokes only the private ${each.key} shadow receiver; no data access."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "event_shadow_firestore" {
  for_each = local.m55_shadow_workers
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.event_consumer[each.key].email}"
}

resource "google_secret_manager_secret_iam_member" "event_clinical_gemini" {
  count     = var.enable_m55_case_processing ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.gemini.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.event_consumer["clinical"].email}"
}

resource "google_cloud_run_v2_service" "event_shadow" {
  for_each             = local.m55_shadow_workers
  project              = var.project_id
  location             = var.region
  name                 = each.value
  description          = "SmartCareOps DEV metadata-only ${each.key} event shadow receiver"
  labels               = local.labels
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = false

  template {
    service_account                  = google_service_account.event_consumer[each.key].email
    timeout                          = var.enable_m55_case_processing && each.key == "clinical" ? "120s" : "30s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image   = var.m55_shadow_container_image
      command = ["node"]
      args    = ["src/events/shadow-push-main.js"]
      ports {
        container_port = 8080
      }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "APP_ENV"
        value = "development"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "M55_ENABLED"
        value = "true"
      }
      env {
        name  = "M55_SHADOW_FAMILY"
        value = each.key
      }
      env {
        name  = "M55_SUBSCRIPTION"
        value = "smartcareops-${each.key}-events"
      }
      env {
        name  = "M55_CASE_PROCESSING_ENABLED"
        value = tostring(var.enable_m55_case_processing)
      }
      dynamic "env" {
        for_each = var.enable_m55_case_processing && each.key == "clinical" ? [1] : []
        content {
          name = "GEMINI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.gemini.secret_id
              version = var.gemini_secret_version
            }
          }
        }
      }
      startup_probe {
        timeout_seconds   = 2
        period_seconds    = 5
        failure_threshold = 12
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
      liveness_probe {
        timeout_seconds   = 2
        period_seconds    = 30
        failure_threshold = 3
        http_get {
          path = "/healthz"
          port = 8080
        }
      }
    }
  }
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required, google_project_iam_member.event_shadow_firestore,
  google_secret_manager_secret_iam_member.event_clinical_gemini]
}

resource "google_cloud_run_v2_service_iam_member" "event_shadow_invoker" {
  for_each = local.m55_shadow_workers
  project  = var.project_id
  location = google_cloud_run_v2_service.event_shadow[each.key].location
  name     = google_cloud_run_v2_service.event_shadow[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.event_shadow_push_invoker[each.key].email}"
}
