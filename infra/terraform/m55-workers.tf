# The outbox relay is continuous background work, so it runs as one manually
# scaled Cloud Run worker-pool instance. It has no HTTP endpoint or invoker.
resource "google_cloud_run_v2_worker_pool" "event_publisher" {
  count               = var.enable_m55_workers ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "smartcareops-event-publisher"
  description         = "SmartCareOps DEV M55 transactional outbox publisher"
  labels              = local.labels
  deletion_protection = true

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }
  template {
    service_account = google_service_account.event_publisher[0].email
    containers {
      image   = var.container_image
      command = ["node"]
      args    = ["src/events/worker-main.js"]
      resources {
        limits = { cpu = "1", memory = "512Mi" }
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
        name  = "M55_WORKER_MODE"
        value = "publisher"
      }
      env {
        name  = "M55_TOPIC"
        value = google_pubsub_topic.care_events[0].name
      }
      env {
        name  = "M55_POLL_INTERVAL_MS"
        value = "1000"
      }
      env {
        name  = "M55_BATCH_SIZE"
        value = "20"
      }
    }
  }
  lifecycle { prevent_destroy = true }
  depends_on = [
    google_project_service.required,
    google_project_iam_member.event_worker_firestore,
    google_pubsub_topic_iam_member.publisher,
  ]
}

# Pub/Sub pushes audit deliveries into a private, authenticated Cloud Run
# service. It scales to zero and acknowledges only after the receipt is durable.
resource "google_cloud_run_v2_service" "event_audit" {
  count                = var.enable_m55_workers ? 1 : 0
  project              = var.project_id
  location             = var.region
  name                 = "smartcareops-audit-worker"
  description          = "SmartCareOps DEV M55 authenticated audit receiver"
  labels               = local.labels
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = false

  template {
    service_account                  = google_service_account.event_consumer["audit"].email
    timeout                          = "30s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image   = var.container_image
      command = ["node"]
      args    = ["src/events/audit-push-main.js"]
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
        name  = "M55_SUBSCRIPTION"
        value = "smartcareops-audit-events"
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
  depends_on = [google_project_service.required, google_project_iam_member.event_worker_firestore]
}

resource "google_cloud_run_v2_service_iam_member" "event_audit_invoker" {
  count    = var.enable_m55_workers ? 1 : 0
  project  = var.project_id
  location = google_cloud_run_v2_service.event_audit[0].location
  name     = google_cloud_run_v2_service.event_audit[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.event_push_invoker[0].email}"
}

variable "m57_operations_container_image" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional immutable image pin for the existing Operations worker during a separate API rollout."
  validation {
    condition     = var.m57_operations_container_image == null ? true : can(regex("^asia-southeast1-docker\\.pkg\\.dev/gen-lang-client-0710663107/[a-z0-9-]+/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$", var.m57_operations_container_image))
    error_message = "An Operations worker image override must be an immutable DEV Artifact Registry digest."
  }
}

resource "google_cloud_run_v2_service" "event_operations" {
  count                = var.enable_m55_operations_worker ? 1 : 0
  project              = var.project_id
  location             = var.region
  name                 = "smartcareops-operations-worker"
  description          = var.enable_m57_agentic_operations ? "SmartCareOps DEV M57 event-driven operations orchestrator" : "SmartCareOps DEV M55 shadow operations projection receiver"
  labels               = local.labels
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = false

  template {
    service_account                  = google_service_account.event_consumer["operations"].email
    timeout                          = var.enable_m57_agentic_operations ? "120s" : "30s"
    max_instance_request_concurrency = var.enable_m57_agentic_operations ? 1 : 20
    scaling {
      min_instance_count = 0
      max_instance_count = var.enable_m57_agentic_operations ? 1 : 3
    }
    containers {
      image   = coalesce(var.m57_operations_container_image, var.container_image)
      command = ["node"]
      args    = ["src/events/operations-push-main.js"]
      ports { container_port = 8080 }
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
        name  = "M55_SUBSCRIPTION"
        value = "smartcareops-operations-events"
      }
      dynamic "env" {
        for_each = var.enable_m57_agentic_operations ? [1] : []
        content {
          name  = "M57_AGENTIC_OPERATIONS_ENABLED"
          value = "true"
        }
      }
      dynamic "env" {
        for_each = var.enable_m57_reviewed_coordination ? [1] : []
        content {
          name  = "M57_REVIEWED_COORDINATION_ENABLED"
          value = "true"
        }
      }
      dynamic "env" {
        for_each = var.enable_m57_agentic_operations ? [1] : []
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
  depends_on = [google_project_service.required, google_project_iam_member.event_worker_firestore, google_secret_manager_secret_iam_member.event_operations_gemini]
}

resource "google_cloud_run_v2_service_iam_member" "event_operations_invoker" {
  count    = var.enable_m55_operations_worker ? 1 : 0
  project  = var.project_id
  location = google_cloud_run_v2_service.event_operations[0].location
  name     = google_cloud_run_v2_service.event_operations[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.event_operations_push_invoker[0].email}"
}

# Required for Pub/Sub to mint the authenticated OIDC token used for push.
resource "google_project_iam_member" "pubsub_push_token_creator" {
  count   = var.enable_m55_workers ? 1 : 0
  project = var.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Firestore has no collection-scoped server IAM role. Only the outbox publisher
# and audit receipt writer receive the existing data-user role.
resource "google_project_iam_member" "event_worker_firestore" {
  for_each = var.enable_m55_workers ? merge({
    publisher = google_service_account.event_publisher[0].email
    audit     = google_service_account.event_consumer["audit"].email
    }, var.enable_m55_operations_worker ? {
    operations = google_service_account.event_consumer["operations"].email
  } : {}) : {}
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${each.value}"
}
