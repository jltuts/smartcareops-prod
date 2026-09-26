# Additive members preserve every unrelated existing IAM principal.
resource "google_project_iam_member" "runtime_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_secret_manager_secret_iam_member" "runtime_gemini" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.gemini.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_cloud_run_v2_service_iam_member" "gateway_invoker" {
  count    = var.enable_api_gateway ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.gateway[0].email}"
}
resource "google_cloud_run_v2_service_iam_member" "live_public_invoker" {
  count    = var.enable_hosted_live ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.live[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
# The existing API never grants allUsers. The isolated Live service requires
# public network invocation because browser WebSockets cannot attach Google IAM.
# API Gateway's Google-managed service agent uses its standard serviceAgent role
# (created by API enablement); do not grant it project-wide Token Creator.
