resource "google_cloud_run_v2_service" "api" {
  count               = var.enable_cloud_run ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = var.cloud_run_service_name
  description         = "SmartCareOps DEV IAM-protected REST API"
  labels              = local.labels
  deletion_protection = true
  # Gateway calls the authenticated run.app endpoint, not an internal/LB source.
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "300s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image = var.container_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu = "1", memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = merge(local.runtime_environment, var.enable_hosted_live ? {
          LIVE_SESSION_ENABLED = "true"
          LIVE_SESSION_STORE   = "firestore"
          LIVE_WEBSOCKET_URL   = "${replace(google_cloud_run_v2_service.live[0].uri, "https://", "wss://")}/api/live"
        } : {})
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini.secret_id
            version = var.gemini_secret_version
          }
        }
      }
      startup_probe {
        initial_delay_seconds = 0
        timeout_seconds       = 2
        period_seconds        = 5
        failure_threshold     = 12
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
      readiness_probe {
        timeout_seconds   = 2
        period_seconds    = 10
        failure_threshold = 3
        http_get {
          path = "/readyz"
          port = 8080
        }
      }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.runtime_gemini, google_project_iam_member.runtime_firestore]
}

resource "google_cloud_run_v2_service" "live" {
  count                = var.enable_hosted_live ? 1 : 0
  project              = var.project_id
  location             = var.region
  name                 = var.live_cloud_run_service_name
  description          = "SmartCareOps isolated one-time-session WebSocket transport"
  labels               = local.labels
  deletion_protection  = true
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = false
  template {
    service_account                  = google_service_account.runtime.email
    timeout                          = "900s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = var.container_image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = merge({ for key, value in local.runtime_environment : key => value if !contains(["DEV_AUTH_UIDS", "DEV_PATIENT_UIDS", "HOSPITAL_HANDOFF_CONNECTOR", "COMPUTER_USE_HEADLESS"], key) }, {
          SERVICE_MODE         = "live-transport"
          LIVE_SESSION_ENABLED = "true"
          LIVE_SESSION_STORE   = "firestore"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini.secret_id
            version = var.gemini_secret_version
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
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.runtime_gemini, google_project_iam_member.runtime_firestore]
}
