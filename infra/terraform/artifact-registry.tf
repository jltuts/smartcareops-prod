resource "google_artifact_registry_repository" "backend" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_repository
  description   = "SmartCareOps DEV backend container images"
  format        = "DOCKER"
  labels        = local.labels
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
