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
