resource "google_secret_manager_secret" "gemini" {
  project             = var.project_id
  secret_id           = "smartcareops-gemini-api-key"
  labels              = local.labels
  deletion_protection = true
  replication {
    auto {
    }
  }
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
# Intentionally NO secret_version resource/data source. Values never enter state.
