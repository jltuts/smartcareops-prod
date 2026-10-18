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
        for_each = merge(local.runtime_environment, var.enable_m55_operations_source ? { M55_OPERATIONS_SOURCE_ENABLED = "true" } : {}, var.enable_m55_case_processing ? { M55_CASE_LIFECYCLE_SOURCE_ENABLED = "true", M55_CASE_NOTICES_ENABLED = "true" } : {}, var.enable_m57_operations_capacity_source ? { M57_OPERATIONS_CAPACITY_SOURCE_ENABLED = "true" } : {}, var.enable_m60_application_client ? merge({
          M60_CLINICAL_AGENT_MODE    = var.enable_m60_application_review ? "review" : var.enable_m60_application_shadow ? "shadow" : "off"
          M60_AGENT_PROJECT_ID       = var.project_id
          M60_AGENT_REGION           = var.region
          M60_AGENT_ENGINE_ID        = google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].name
          M60_POLICY_VERSION         = var.m60_policy_corpus_version
          M60_POLICY_MANIFEST_DIGEST = var.m60_policy_manifest_digest
          }, var.enable_m60_application_shadow || var.enable_m60_application_review ? {
          M60_GATE_C_ACCEPTED = "true"
          M60_GATE_D_ACCEPTED = "true"
          M60_SHADOW_CASE_IDS = join(",", var.m60_shadow_case_ids)
          M60_SHADOW_START_AT = var.m60_shadow_start_at
          M60_SHADOW_END_AT   = var.m60_shadow_end_at
          } : {}, var.enable_m60_application_review ? {
          M60_REVIEW_CUTOVER_APPROVED = "true"
          } : {}) : {}, var.enable_hosted_live ? {
          LIVE_SESSION_ENABLED = "true"
          LIVE_SESSION_STORE   = "firestore"
          LIVE_WEBSOCKET_URL   = "${replace(google_cloud_run_v2_service.live[0].uri, "https://", "wss://")}/api/live"
        } : {}, var.enable_m30 ? { EVIDENCE_BUCKET = google_storage_bucket.patient_evidence[0].name } : {})
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
      dynamic "env" {
        for_each = var.demo_auth_secret_version == null ? [] : [var.demo_auth_secret_version]
        content {
          name = "DEMO_LOCAL_AUTH_CONFIG"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.demo_auth.secret_id
              version = env.value
            }
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
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.runtime_gemini, google_secret_manager_secret_iam_member.runtime_demo_auth,
    google_project_iam_member.runtime_firestore, google_storage_bucket_iam_member.api_evidence_objects,
  google_cloud_run_v2_service.event_shadow]
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
    service_account                  = var.enable_m30 ? google_service_account.live_runtime[0].email : google_service_account.runtime.email
    timeout                          = "900s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }
    containers {
      image = coalesce(var.live_container_image, var.container_image)
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = merge({ for key, value in local.runtime_environment : key => value if !contains(["DEV_AUTH_UIDS", "DEV_PATIENT_UIDS", "ADMIN_UIDS", "PURGE_PROTECTED_GOOGLE_EMAILS", "DEMO_LOCAL_AUTH_ENABLED", "HOSPITAL_HANDOFF_CONNECTOR", "COMPUTER_USE_HEADLESS", "M57_REVIEWED_COORDINATION_ENABLED"], key) }, {
          M10_ENABLED          = "false"
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
  depends_on = [google_project_service.required, google_secret_manager_secret_iam_member.runtime_gemini, google_project_iam_member.runtime_firestore, google_secret_manager_secret_iam_member.live_runtime_gemini, google_project_iam_member.live_runtime_firestore]
}
