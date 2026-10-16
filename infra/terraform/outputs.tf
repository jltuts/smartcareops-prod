output "project_id" {
  value = data.google_project.existing.project_id
}
output "firestore_database" {
  value = google_firestore_database.existing.id
}
output "backend_image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.backend.repository_id}"
}
output "runtime_service_account" {
  value = google_service_account.runtime.email
}
output "gemini_secret_resource" {
  description = "Secret CONTAINER name only. No value/version data is read."
  value       = google_secret_manager_secret.gemini.id
}
output "cloud_run_url" {
  value = try(google_cloud_run_v2_service.api[0].uri, null)
}
output "gateway_hostname" {
  value = try(google_api_gateway_gateway.api[0].default_hostname, null)
}
output "live_cloud_run_url" {
  description = "Isolated application-authenticated Live transport; no REST application routes."
  value       = try(google_cloud_run_v2_service.live[0].uri, null)
}
output "gateway_name" {
  value = try(google_api_gateway_gateway.api[0].gateway_id, null)
}
output "gateway_region" {
  value = try(google_api_gateway_gateway.api[0].region, null)
}
output "gateway_url" {
  value = try("https://${google_api_gateway_gateway.api[0].default_hostname}", null)
}
output "gateway_api_id" {
  value = try(google_api_gateway_api.api[0].id, null)
}
output "gateway_config_id" {
  value = try(google_api_gateway_api_config.health[0].id, null)
}
output "gateway_service_account" {
  value = try(google_service_account.gateway[0].email, null)
}
output "https_ip" {
  value = try(google_compute_global_address.api[0].address, null)
}
output "edge_domain" {
  value = var.enable_load_balancer ? var.domain_name : null
}
output "rest_edge_url" {
  value = var.enable_load_balancer ? "https://${var.domain_name}" : null
}
output "live_edge_url" {
  description = "Exact WebSocket path; requires caller IAM authentication and an allowed Origin."
  value       = var.enable_load_balancer ? "wss://${var.domain_name}/api/live" : null
}
output "cloud_armor_policy_name" {
  value = try(google_compute_security_policy.edge[0].name, null)
}

output "event_topic" {
  description = "Dormant M55 care-event topic; null until explicitly enabled."
  value       = try(google_pubsub_topic.care_events[0].id, null)
}

output "event_subscriptions" {
  description = "M55 pull subscriptions by bounded event family; empty until explicitly enabled."
  value = merge(
    var.enable_m55 ? { audit = google_pubsub_subscription.audit[0].id } : {},
    { for key, subscription in google_pubsub_subscription.event_consumer : key => subscription.id }
  )
}

output "event_workers" {
  description = "M55 publisher worker pool and authenticated audit service; null until explicitly enabled."
  value = var.enable_m55_workers ? merge({
    publisher = google_cloud_run_v2_worker_pool.event_publisher[0].name
    audit     = google_cloud_run_v2_service.event_audit[0].name
    }, var.enable_m55_operations_worker ? {
    operations = google_cloud_run_v2_service.event_operations[0].name
  } : {}, { for family, worker in google_cloud_run_v2_service.event_shadow : family => worker.name }) : null
}

output "m60_agent_runtime" {
  description = "Isolated M60 reasoning-engine name and region; null while disabled."
  value = var.enable_m60_agent_runtime ? {
    name   = google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].name
    region = var.region
  } : null
}

output "m60_phase_d_foundation" {
  description = "Approved fictional policy corpus and inspect-only Model Armor resources; null while disabled."
  value = var.enable_m60_phase_d_foundation ? {
    corpus_name          = google_vertex_ai_rag_corpus.m60_policy[0].name
    corpus_region        = var.region
    corpus_version       = var.m60_policy_corpus_version
    manifest_digest      = var.m60_policy_manifest_digest
    model_armor_template = google_model_armor_template.m60_inspect[0].name
    admission_template   = google_model_armor_template.m60_admission[0].name
    enforcement          = "INSPECT_ONLY"
  } : null
}
