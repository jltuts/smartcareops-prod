override_resource {
  target = google_firestore_database.existing
  values = { id = "projects/gen-lang-client-0710663107/databases/(default)" }
}
override_resource {
  target = google_project_service.required["firestore.googleapis.com"]
  values = { id = "gen-lang-client-0710663107/firestore.googleapis.com" }
}
override_resource {
  target = google_project_service.required["generativelanguage.googleapis.com"]
  values = { id = "gen-lang-client-0710663107/generativelanguage.googleapis.com" }
}

mock_provider "google" {}
mock_provider "google-beta" {}

variables {
  enable_cloud_run             = false
  enable_api_gateway           = false
  enable_load_balancer         = false
  enable_monitoring            = false
  enable_firebase_auth_routes  = false
  enable_hosted_live           = false
  enable_m55                   = false
  enable_m55_workers           = false
  enable_m55_operations_worker = false
  enable_m55_operations_source = false
  container_image              = null
  gemini_secret_version        = "latest"
  gateway_region               = null
}

run "shadow_workers_default_off" {
  command = plan
  variables { enable_m55 = true }
  assert {
    condition = (length(google_cloud_run_v2_service.event_shadow) == 0 &&
      length(google_service_account.event_shadow_push_invoker) == 0 &&
      length(google_project_iam_member.event_shadow_firestore) == 0 &&
      length(google_cloud_run_v2_service_iam_member.event_shadow_invoker) == 0 &&
      length(google_pubsub_subscription.event_consumer["clinical"].push_config) == 0 &&
    length(google_pubsub_subscription.event_consumer["notifications"].push_config) == 0)
    error_message = "Shadow workers must be absent unless explicitly enabled."
  }
}

run "clinical_shadow_requires_worker_foundation" {
  command = plan
  variables { enable_m55_clinical_shadow_worker = true }
  expect_failures = [var.enable_m55_clinical_shadow_worker]
}

run "notifications_shadow_requires_worker_foundation" {
  command = plan
  variables { enable_m55_notifications_shadow_worker = true }
  expect_failures = [var.enable_m55_notifications_shadow_worker]
}

run "shadow_requires_immutable_image" {
  command = plan
  variables {
    enable_cloud_run                  = true
    enable_m55                        = true
    enable_m55_workers                = true
    enable_m55_clinical_shadow_worker = true
    container_image                   = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.m55_shadow_container_image]
}

run "clinical_shadow_is_isolated" {
  command = plan
  variables {
    enable_cloud_run                  = true
    enable_m55                        = true
    enable_m55_workers                = true
    enable_m55_clinical_shadow_worker = true
    container_image                   = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    m55_shadow_container_image        = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  assert {
    condition = (length(google_cloud_run_v2_service.event_shadow) == 1 &&
      google_cloud_run_v2_service.event_shadow["clinical"].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.event_shadow["clinical"].template[0].containers[0].image == var.m55_shadow_container_image &&
      google_cloud_run_v2_service.api[0].template[0].containers[0].image == var.container_image &&
      google_service_account.event_shadow_push_invoker["clinical"].account_id == "smartcareops-clinical-push" &&
      length(google_pubsub_subscription.event_consumer["clinical"].push_config) == 1 &&
    length(google_pubsub_subscription.event_consumer["notifications"].push_config) == 0)
    error_message = "Clinical shadow push must remain private and independently pinned."
  }
}

run "notifications_shadow_is_isolated" {
  command = plan
  variables {
    enable_cloud_run                       = true
    enable_m55                             = true
    enable_m55_workers                     = true
    enable_m55_notifications_shadow_worker = true
    container_image                        = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    m55_shadow_container_image             = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  assert {
    condition = (length(google_cloud_run_v2_service.event_shadow) == 1 &&
      google_cloud_run_v2_service.event_shadow["notifications"].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.event_shadow["notifications"].template[0].containers[0].image == var.m55_shadow_container_image &&
      google_cloud_run_v2_service.api[0].template[0].containers[0].image == var.container_image &&
      google_service_account.event_shadow_push_invoker["notifications"].account_id == "smartcareops-notify-push" &&
      length(google_pubsub_subscription.event_consumer["notifications"].push_config) == 1 &&
    length(google_pubsub_subscription.event_consumer["clinical"].push_config) == 0)
    error_message = "Notifications shadow push must remain private and independently pinned."
  }
}
