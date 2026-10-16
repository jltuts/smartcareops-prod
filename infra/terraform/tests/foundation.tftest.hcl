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
# Provider-mocked plans only. These do not contact GCP or apply resources.
variables {
  enable_cloud_run            = false
  enable_api_gateway          = false
  enable_load_balancer        = false
  enable_monitoring           = false
  enable_firebase_auth_routes = false
  enable_hosted_live          = false
  container_image             = null
  gemini_secret_version       = "latest"
  gateway_region              = null
}
mock_provider "google" {}
mock_provider "google-beta" {}
run "default_is_adoption_only" {
  command = plan
  assert {
    condition     = keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = false, enable_hosted_live = false, enable_m15 = false, enable_m16 = false, enable_m17 = false, enable_m18 = false, enable_m43_gateway_routes = false })).paths) == ["/health", "/readyz"]
    error_message = "Only the two verified status routes may be published before user authentication."
  }
  assert {
    condition     = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = false, enable_hosted_live = false, enable_m15 = false, enable_m16 = false, enable_m17 = false, enable_m18 = false, enable_m43_gateway_routes = false }))["x-google-allow"] == "configured"
    error_message = "Gateway must reject unconfigured routes."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.api) == 0 && length(google_api_gateway_gateway.api) == 0 && length(google_compute_global_forwarding_rule.https) == 0
    error_message = "Default foundation must not deploy an image, Gateway or public edge."
  }
  assert {
    condition     = length(google_pubsub_topic.care_events) == 0 && length(google_pubsub_topic.dead_letter) == 0 && length(google_service_account.event_publisher) == 0 && length(google_service_account.event_consumer) == 0 && length(google_cloud_run_v2_worker_pool.event_publisher) == 0 && length(google_cloud_run_v2_service.event_audit) == 0
    error_message = "The Pub/Sub event plane must remain absent until M55 is explicitly enabled."
  }
  assert {
    condition     = google_firestore_database.existing.name == "(default)" && google_firestore_database.existing.location_id == "asia-southeast1" && google_firestore_database.existing.deletion_policy == "PREVENT"
    error_message = "Existing database identity/location and protection must be preserved."
  }
}

run "m55_pubsub_foundation_is_dormant_regional_and_least_privilege" {
  command = plan
  variables { enable_m55 = true }

  assert {
    condition = (contains(local.services, "pubsub.googleapis.com") &&
      length(google_pubsub_topic.care_events[0].message_storage_policy[0].allowed_persistence_regions) == 1 &&
      contains(google_pubsub_topic.care_events[0].message_storage_policy[0].allowed_persistence_regions, "asia-southeast1") &&
      length(google_pubsub_topic.dead_letter[0].message_storage_policy[0].allowed_persistence_regions) == 1 &&
    contains(google_pubsub_topic.dead_letter[0].message_storage_policy[0].allowed_persistence_regions, "asia-southeast1"))
    error_message = "M55 topics must retain messages only in the existing Singapore region."
  }
  assert {
    condition = (length(google_pubsub_subscription.audit) == 1 &&
      length(google_pubsub_subscription.event_consumer) == 3 &&
      google_pubsub_subscription.event_consumer["clinical"].filter == "attributes.event_family = \"clinical\"" &&
      google_pubsub_subscription.event_consumer["notifications"].filter == "attributes.event_family = \"notifications\"" &&
    google_pubsub_subscription.event_consumer["operations"].filter == "attributes.event_family = \"operations\"")
    error_message = "M55 must provide one complete audit stream and three explicitly filtered domain streams."
  }
  assert {
    condition = (google_pubsub_subscription.audit[0].dead_letter_policy[0].max_delivery_attempts == 5 &&
      alltrue([for subscription in google_pubsub_subscription.event_consumer : subscription.dead_letter_policy[0].max_delivery_attempts == 5]) &&
      google_pubsub_subscription.audit[0].retry_policy[0].maximum_backoff == "600s" &&
    alltrue([for subscription in google_pubsub_subscription.event_consumer : subscription.retry_policy[0].maximum_backoff == "600s"]))
    error_message = "Every M55 subscription must use bounded retries and the dead-letter topic."
  }
  assert {
    condition = (length(google_service_account.event_publisher) == 1 &&
      length(google_service_account.event_consumer) == 4 &&
      google_service_account.event_publisher[0].account_id == "smartcareops-event-publisher" &&
      google_service_account.event_consumer["notifications"].account_id == "smartcareops-notify-worker" &&
      google_pubsub_topic_iam_member.publisher[0].role == "roles/pubsub.publisher" &&
    alltrue([for binding in google_pubsub_subscription_iam_member.consumer : binding.role == "roles/pubsub.subscriber"]))
    error_message = "M55 publisher and consumers must use separate least-privilege service identities."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.api) == 0 && length(google_cloud_run_v2_service.live) == 0 && length(google_cloud_run_v2_worker_pool.event_publisher) == 0 && length(google_cloud_run_v2_service.event_audit) == 0 && length(google_project_iam_member.event_worker_firestore) == 0
    error_message = "The M55 foundation must not create or reroute an application runtime."
  }
}

run "m55_workers_require_foundation_and_cloud_run" {
  command = plan
  variables { enable_m55_workers = true }
  expect_failures = [var.enable_m55_workers]
}

run "m55_operations_worker_requires_worker_foundation" {
  command = plan
  variables { enable_m55_operations_worker = true }
  expect_failures = [var.enable_m55_operations_worker]
}

run "m55_operations_source_requires_projection_receiver" {
  command = plan
  variables { enable_m55_operations_source = true }
  expect_failures = [var.enable_m55_operations_source]
}

run "m55_workers_are_private_isolated_and_explicit" {
  command = plan
  variables {
    enable_cloud_run            = true
    enable_api_gateway          = true
    enable_firebase_auth_routes = true
    enable_hosted_live          = true
    enable_m55                  = true
    enable_m55_workers          = true
    gateway_region              = "asia-northeast1"
    container_image             = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    live_container_image        = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }

  assert {
    condition = (length(google_cloud_run_v2_worker_pool.event_publisher) == 1 &&
      google_cloud_run_v2_worker_pool.event_publisher[0].scaling[0].scaling_mode == "MANUAL" &&
      google_cloud_run_v2_worker_pool.event_publisher[0].scaling[0].manual_instance_count == 1 &&
      length(google_cloud_run_v2_service.event_audit) == 1 &&
      google_cloud_run_v2_service.event_audit[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.event_audit[0].invoker_iam_disabled == false &&
      google_cloud_run_v2_service.event_audit[0].template[0].scaling[0].min_instance_count == 0 &&
    google_cloud_run_v2_service.event_audit[0].template[0].scaling[0].max_instance_count == 3)
    error_message = "M55 must use one continuous publisher worker pool and a scale-to-zero authenticated audit receiver."
  }
  assert {
    condition = (google_cloud_run_v2_service.api[0].template[0].containers[0].image == var.container_image &&
      google_cloud_run_v2_worker_pool.event_publisher[0].template[0].containers[0].image == var.container_image &&
      google_cloud_run_v2_service.event_audit[0].template[0].containers[0].image == var.container_image &&
    google_cloud_run_v2_service.live[0].template[0].containers[0].image == var.live_container_image)
    error_message = "M55 rollout must update the API and event workers without changing the verified Live transport image."
  }
  assert {
    condition = (google_cloud_run_v2_worker_pool.event_publisher[0].template[0].containers[0].command[0] == "node" &&
      google_cloud_run_v2_worker_pool.event_publisher[0].template[0].containers[0].args[0] == "src/events/worker-main.js" &&
      google_cloud_run_v2_service.event_audit[0].template[0].containers[0].command[0] == "node" &&
    google_cloud_run_v2_service.event_audit[0].template[0].containers[0].args[0] == "src/events/audit-push-main.js")
    error_message = "M55 runtimes must use only their isolated publisher and audit entry points."
  }
  assert {
    condition = (!anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : startswith(env.name, "M55_")]) &&
      anytrue([for env in google_cloud_run_v2_worker_pool.event_publisher[0].template[0].containers[0].env : env.name == "M55_WORKER_MODE" && env.value == "publisher"]) &&
      anytrue([for env in google_cloud_run_v2_worker_pool.event_publisher[0].template[0].containers[0].env : env.name == "M55_TOPIC" && env.value == "smartcareops-care-events"]) &&
      anytrue([for env in google_cloud_run_v2_service.event_audit[0].template[0].containers[0].env : env.name == "M55_SUBSCRIPTION" && env.value == "smartcareops-audit-events"]) &&
      length(google_pubsub_subscription.audit[0].push_config) == 1 &&
      length(google_pubsub_subscription.audit[0].push_config[0].oidc_token) == 1 &&
    google_service_account.event_push_invoker[0].account_id == "smartcareops-pubsub-push")
    error_message = "M55 workers must not activate an API event source without its separate source flag."
  }
  assert {
    condition = (length(google_project_iam_member.event_worker_firestore) == 2 &&
      google_project_iam_member.event_worker_firestore["publisher"].role == "roles/datastore.user" &&
      google_project_iam_member.event_worker_firestore["audit"].role == "roles/datastore.user" &&
      google_service_account.event_publisher[0].account_id == "smartcareops-event-publisher" &&
      google_service_account.event_consumer["audit"].account_id == "smartcareops-audit-worker" &&
      !contains(keys(google_pubsub_subscription_iam_member.consumer), "audit") &&
      google_cloud_run_v2_service_iam_member.event_audit_invoker[0].role == "roles/run.invoker" &&
    google_project_iam_member.pubsub_push_token_creator[0].role == "roles/iam.serviceAccountTokenCreator")
    error_message = "M55 workers must retain separate identities and receive Firestore access only when explicitly enabled."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.event_operations) == 0 && length(google_service_account.event_operations_push_invoker) == 0 && length(google_pubsub_subscription.event_consumer["operations"].push_config) == 0
    error_message = "The operations projection receiver must remain absent until its separate shadow-mode flag is enabled."
  }
}

run "m55_operations_worker_is_private_idempotent_shadow_infrastructure" {
  command = plan
  variables {
    enable_cloud_run             = true
    enable_m55                   = true
    enable_m55_workers           = true
    enable_m55_operations_worker = true
    container_image              = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (length(google_cloud_run_v2_service.event_operations) == 1 &&
      google_cloud_run_v2_service.event_operations[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.event_operations[0].template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.event_operations[0].template[0].containers[0].args[0] == "src/events/operations-push-main.js" &&
      length(google_pubsub_subscription.event_consumer["operations"].push_config) == 1 &&
      length(google_pubsub_subscription.event_consumer["operations"].push_config[0].oidc_token) == 1 &&
    google_service_account.event_operations_push_invoker[0].account_id == "smartcareops-operations-push")
    error_message = "The operations projection must use a private, scale-to-zero, authenticated push receiver."
  }
  assert {
    condition = (length(google_project_iam_member.event_worker_firestore) == 3 &&
      google_project_iam_member.event_worker_firestore["operations"].role == "roles/datastore.user" &&
      google_cloud_run_v2_service_iam_member.event_operations_invoker[0].role == "roles/run.invoker" &&
      google_service_account.event_consumer["operations"].account_id == "smartcareops-operations-worker" &&
    google_cloud_run_v2_service.event_operations[0].template[0].containers[0].image == var.container_image)
    error_message = "The operations projection runtime and push identity must remain separate and least privilege."
  }
}

run "m55_operations_source_is_explicit_and_metadata_only" {
  command = plan
  variables {
    enable_cloud_run             = true
    enable_m55                   = true
    enable_m55_workers           = true
    enable_m55_operations_worker = true
    enable_m55_operations_source = true
    container_image              = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M55_OPERATIONS_SOURCE_ENABLED" && env.value == "true"]) &&
    !anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M55_ENABLED"]))
    error_message = "The API must enable only the reviewed Operations source, not every M55 event family."
  }
}

run "m57_agentic_operations_is_explicit_private_and_bounded" {
  command = plan
  variables {
    enable_cloud_run                      = true
    enable_api_gateway                    = true
    enable_firebase_auth_routes           = true
    enable_hosted_live                    = true
    gateway_region                        = "asia-northeast1"
    enable_m55                            = true
    enable_m55_workers                    = true
    enable_m55_operations_worker          = true
    enable_m55_operations_source          = true
    enable_m57_agentic_operations         = true
    enable_m57_operations_capacity_source = true
    enable_m57_reviewed_coordination      = true
    container_image                       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (google_cloud_run_v2_service.event_operations[0].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.event_operations[0].template[0].timeout == "120s" &&
      google_cloud_run_v2_service.event_operations[0].template[0].max_instance_request_concurrency == 1 &&
      google_cloud_run_v2_service.event_operations[0].template[0].scaling[0].max_instance_count == 1 &&
      google_pubsub_subscription.event_consumer["operations"].ack_deadline_seconds == 120 &&
      anytrue([for env in google_cloud_run_v2_service.event_operations[0].template[0].containers[0].env : env.name == "M57_AGENTIC_OPERATIONS_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.event_operations[0].template[0].containers[0].env : env.name == "GEMINI_API_KEY" && length(env.value_source) == 1]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M57_OPERATIONS_CAPACITY_SOURCE_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M10_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M12_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M57_REVIEWED_COORDINATION_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.event_operations[0].template[0].containers[0].env : env.name == "M57_REVIEWED_COORDINATION_ENABLED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.live[0].template[0].containers[0].env : env.name == "M10_ENABLED" && env.value == "false"]) &&
      !anytrue([for env in google_cloud_run_v2_service.live[0].template[0].containers[0].env : env.name == "M57_REVIEWED_COORDINATION_ENABLED"]) &&
    google_secret_manager_secret_iam_member.event_operations_gemini[0].role == "roles/secretmanager.secretAccessor")
    error_message = "M57 must remain an authenticated private consumer with a bounded request window and secret-scoped Gemini access."
  }
}

run "m55_monitoring_is_explicit_and_payload_free" {
  command = plan
  variables {
    enable_cloud_run   = true
    enable_monitoring  = true
    enable_m55         = true
    enable_m55_workers = true
    container_image    = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  assert {
    condition = (length(google_logging_metric.m55_worker_failures) == 1 &&
      length(google_monitoring_alert_policy.m55_worker_failures) == 1 &&
      length(google_monitoring_alert_policy.m55_backlog_age) == 1 &&
    length(google_monitoring_alert_policy.m55_dead_letter) == 1)
    error_message = "M55 operational monitoring must exist only when both workers and monitoring are enabled."
  }
  assert {
    condition = (strcontains(google_logging_metric.m55_worker_failures[0].filter, "event-worker") &&
      strcontains(google_logging_metric.m55_worker_failures[0].filter, "audit-push") &&
      !strcontains(google_logging_metric.m55_worker_failures[0].filter, "subjectId") &&
      strcontains(google_monitoring_alert_policy.m55_backlog_age[0].conditions[0].condition_threshold[0].filter, "oldest_unacked_message_age") &&
      strcontains(google_monitoring_alert_policy.m55_backlog_age[0].conditions[0].condition_threshold[0].filter, "resource.labels.subscription_id = \"smartcareops-audit-events\"") &&
      !strcontains(google_monitoring_alert_policy.m55_backlog_age[0].conditions[0].condition_threshold[0].filter, "\\") &&
    strcontains(google_monitoring_alert_policy.m55_dead_letter[0].conditions[0].condition_threshold[0].filter, "dead_letter_message_count"))
    error_message = "M55 monitoring must use bounded failure markers and official backlog/dead-letter metrics without clinical identifiers."
  }
}
run "missing_image_is_rejected" {
  command = plan
  variables { enable_cloud_run = true }
  expect_failures = [var.enable_cloud_run]
}
run "cloud_run_uses_latest_secret_reference" {
  command = plan
  variables {
    enable_cloud_run = true
    # Synthetic digest used only by mock providers; never deployed.
    container_image = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "GEMINI_API_KEY" && try(env.value_source[0].secret_key_ref[0].version == "latest", false)])
    error_message = "Gemini must use a Secret Manager latest reference."
  }
  assert {
    condition     = length(google_api_gateway_gateway.api) == 0 && length(google_compute_global_forwarding_rule.https) == 0
    error_message = "Cloud Run preparation must keep Gateway and edge disabled."
  }
}
run "unsupported_gateway_region_is_rejected" {
  command = plan
  variables { gateway_region = "asia-southeast1" }
  expect_failures = [var.gateway_region]
}
run "production_is_rejected" {
  command = plan
  variables { environment = "prod" }
  expect_failures = [var.environment]
}
run "optional_platform_schema" {
  command = plan
  variables {
    enable_cloud_run     = true
    enable_api_gateway   = true
    enable_load_balancer = true
    enable_monitoring    = true
    # Explicit test fixture, provider-mocked only. Not in deployable tfvars.
    container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gemini_secret_version = "1"
    gateway_region        = "asia-northeast1"
    domain_name           = "test.example.org"
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].invoker_iam_disabled == false && google_cloud_run_v2_service_iam_member.gateway_invoker[0].role == "roles/run.invoker"
    error_message = "Gateway invocation must use IAM, never public Cloud Run."
  }
  assert {
    condition     = google_compute_region_network_endpoint_group.gateway[0].region == var.gateway_region && google_compute_backend_service.gateway[0].load_balancing_scheme == "EXTERNAL_MANAGED"
    error_message = "Gateway NEG and gateway must be colocated behind the global external ALB."
  }
  assert {
    condition     = google_compute_region_network_endpoint_group.live[0].region == "asia-southeast1" && google_compute_region_network_endpoint_group.live[0].cloud_run[0].service == "smartcareops-api" && google_compute_backend_service.live[0].log_config[0].enable
    error_message = "Live must use the Singapore Cloud Run NEG with backend logging."
  }
  assert {
    condition     = toset(flatten([for rule in google_compute_url_map.api[0].path_matcher[0].path_rule : rule.paths])) == toset(["/health", "/readyz", "/api/live"])
    error_message = "Edge must use only the actual exact Live path and two status routes."
  }
  assert {
    condition     = alltrue([for rule in google_compute_security_policy.edge[0].rule : rule.action == "allow" || rule.preview])
    error_message = "DEV Armor must not enforce aggressive blocking rules."
  }
}
run "edge_requires_owned_domain" {
  command = plan
  variables {
    enable_cloud_run     = true
    enable_api_gateway   = true
    enable_load_balancer = true
    gateway_region       = "asia-northeast1"
    domain_name          = null
    container_image      = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.enable_load_balancer]
}
run "m16_requires_m15_and_authenticated_gateway" {
  command = plan
  variables { enable_m16 = true }
  expect_failures = [var.enable_m16]
}
run "m17_requires_m16_and_authenticated_gateway" {
  command = plan
  variables { enable_m17 = true }
  expect_failures = [var.enable_m17]
}
run "m18_requires_m17_and_authenticated_gateway" {
  command = plan
  variables {
    enable_m18                = true
    enable_m43_gateway_routes = false
  }
  expect_failures = [var.enable_m18]
}
run "m21_requires_m18_and_authenticated_gateway" {
  command = plan
  variables { enable_m21 = true }
  expect_failures = [var.enable_m21]
}
run "m30_requires_cloud_run" {
  command = plan
  variables { enable_m30 = true }
  expect_failures = [var.enable_m30]
}
run "m30_uses_private_bucket_and_api_only_object_access" {
  command = plan
  variables {
    enable_cloud_run = true
    enable_m30       = true
    container_image  = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = (google_storage_bucket.patient_evidence[0].public_access_prevention == "enforced" &&
      google_storage_bucket.patient_evidence[0].uniform_bucket_level_access &&
      google_storage_bucket.patient_evidence[0].force_destroy == false &&
    google_storage_bucket.patient_evidence[0].soft_delete_policy[0].retention_duration_seconds == 0)
    error_message = "Patient evidence must use a private PAP-enforced bucket without an independent delete retention."
  }
  assert {
    condition = (google_storage_bucket_iam_member.api_evidence_objects[0].role == "roles/storage.objectUser" &&
    anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "EVIDENCE_BUCKET"]))
    error_message = "Only the authenticated API runtime receives bucket object access and its bucket identifier."
  }
}
run "admin_allowlist_rejects_duplicate_firebase_uids" {
  command = plan
  variables { admin_uids = ["same-admin-uid", "same-admin-uid"] }
  expect_failures = [var.admin_uids]
}
run "hosted_live_is_isolated_from_private_api" {
  command = plan
  variables {
    enable_cloud_run            = true
    enable_api_gateway          = true
    enable_firebase_auth_routes = true
    enable_hosted_live          = true
    enable_m15                  = true
    enable_m16                  = true
    enable_m17                  = true
    enable_m18                  = true
    enable_m43_gateway_routes   = false
    enable_m21                  = true
    enable_m30                  = true
    container_image             = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway_region              = "asia-northeast1"
  }
  assert {
    condition = (google_cloud_run_v2_service.live[0].name == "smartcareops-live" &&
      google_cloud_run_v2_service_iam_member.live_public_invoker[0].name == google_cloud_run_v2_service.live[0].name &&
      google_cloud_run_v2_service_iam_member.live_public_invoker[0].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.gateway_invoker[0].name == google_cloud_run_v2_service.api[0].name &&
    google_cloud_run_v2_service_iam_member.gateway_invoker[0].member != "allUsers")
    error_message = "Only the isolated Live transport may be publicly invokable; the REST API must remain IAM-protected."
  }
  assert {
    condition = (length(google_service_account.live_runtime) == 1 &&
      length(google_project_iam_member.live_runtime_firestore) == 1 &&
      length(google_secret_manager_secret_iam_member.live_runtime_gemini) == 1 &&
    !anytrue([for env in google_cloud_run_v2_service.live[0].template[0].containers[0].env : env.name == "EVIDENCE_BUCKET"]))
    error_message = "The isolated Live runtime must not receive Patient evidence object access or bucket configuration."
  }
  assert {
    condition = (anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "ADMIN_UIDS" && env.value == "NufeiTKjifPcswOI3q7HlZige2u1,pjS8nkgyJHcCOLFOwdQnIgSYy6v1"]) &&
    !anytrue([for env in google_cloud_run_v2_service.live[0].template[0].containers[0].env : env.name == "ADMIN_UIDS"]))
    error_message = "All Admin UIDs must be configured only on the authenticated API and never on Live transport."
  }
  assert {
    condition = contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
    })).paths), "/api/live/session")
    error_message = "Gateway must publish the authenticated bootstrap endpoint, never the WebSocket route."
  }
  assert {
    condition = alltrue([for route in ["/api/intake/medicine/scan", "/api/intake/medicine/confirm", "/api/intake/evidence/share"] :
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), route) &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "post") &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "options")
    ])
    error_message = "Patient medicine and evidence routes must be published with exact-origin preflight forwarding."
  }
  assert {
    condition = alltrue([for route in ["/api/regional", "/api/operations", "/api/notifications"] :
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), route) &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "get") &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "options")
    ])
    error_message = "Command Center supporting GET routes must be published with unauthenticated Gateway preflight forwarding."
  }
  assert {
    condition = alltrue([for route in ["/api/operations/capacity", "/api/operations/run", "/api/operations/reset"] :
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), route) &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "post") &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "options")
    ])
    error_message = "Hospital Operations capacity, assessment and demo-reset controls must publish POST and CORS preflight routes."
  }
  assert {
    condition = alltrue([for operation in ["post", "options"] : contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
    })).paths["/api/doctor/application"]), operation)])
    error_message = "The pending Doctor application must publish POST and CORS preflight without an approval operation."
  }
  assert {
    condition = alltrue([
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/doctor-applications"]), "get"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/doctor-applications"]), "options"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/doctor-applications/{uid}/decision"]), "post"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/doctor-applications/{uid}/decision"]), "options"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/approved-doctors/{uid}/specialties/{specialty}"]), "delete"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/approved-doctors/{uid}/specialties/{specialty}"]), "options"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/patient-applications"]), "get"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/patient-applications/{uid}/decision"]), "post"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/settings/patient-access"]), "put"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/purge-preview"]), "get"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/admin/purge"]), "post"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false })).paths["/api/patient/application"]), "post")
    ])
    error_message = "Admin controls and Patient access application operations must be published through the Gateway."
  }
  assert {
    condition = alltrue([
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/cases"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/cases/{caseId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/cases/{caseId}/evidence/{evidenceId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/dispatcher/cases"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/intake-finalization"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/profile"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/doctor/application"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/doctor/cases"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/doctor/cases/{caseId}/medicine-image"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/doctor/cases/{caseId}/evidence/{evidenceId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/clinical"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/clinical/approvals/{approvalId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths["/api/operations/approvals/{approvalId}"]), "post"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/clinical/case-review"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/simulation/advance"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/simulation"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/caretwin"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/caretwin/generate"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/caretwin/decision"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/predictive"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/predictive/generate"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/patterns"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/patterns/refresh"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/patterns/acknowledge"),
      !contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths), "/api/clinical/executions/{executionId}/confirm")
    ])
    error_message = "Hosted routes must include the role-protected Doctor reasoning surface without publishing execution confirmation routes."
  }
  assert {
    condition = alltrue([for route, method in {
      "/api/doctor/cases/{caseId}/appointment"   = "post"
      "/api/cases/{caseId}/appointment/response" = "post"
      "/api/notifications/appointments"          = "get"
      } :
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), method) &&
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths[route]), "options")
    ])
    error_message = "M38 appointment and UID-scoped notification routes must publish only explicit authenticated operations with CORS preflight."
  }
  assert {
    condition = alltrue([for route, methods in {
      "/api/intake/chat/session" = ["get", "post", "delete", "options"]
      "/api/intake/chat/message" = ["post", "options"]
      } : alltrue([for method in methods :
        contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
          backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
        })).paths[route]), method)
      ])
    ])
    error_message = "M41 Patient chat intake routes must publish the explicit session and message operations with CORS preflight."
  }
  assert {
    condition = alltrue([for service in [google_cloud_run_v2_service.api[0], google_cloud_run_v2_service.live[0]] :
      anytrue([for env in service.template[0].containers[0].env : env.name == "M17_ENABLED" && env.value == "true"])
    ])
    error_message = "M17 must be enabled in both API and Live runtime revisions when selected."
  }
  assert {
    condition = alltrue([for service in [google_cloud_run_v2_service.api[0], google_cloud_run_v2_service.live[0]] :
      anytrue([for env in service.template[0].containers[0].env : env.name == "M18_ENABLED" && env.value == "true"])
    ])
    error_message = "M18 must be enabled in both API and Live runtime revisions when selected."
  }
  assert {
    condition = alltrue([for service in [google_cloud_run_v2_service.api[0], google_cloud_run_v2_service.live[0]] :
      anytrue([for env in service.template[0].containers[0].env : env.name == "M12_ENABLED" && env.value == "true"])
    ])
    error_message = "M21 must enable the existing notification service in both API and Live runtime revisions when selected."
  }
}
