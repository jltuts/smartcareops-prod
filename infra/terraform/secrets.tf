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
resource "google_secret_manager_secret" "demo_auth" {
  project             = var.project_id
  secret_id           = "smartcareops-demo-auth-config"
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
# The generated JSON value is added out of band; Terraform stores only its version selector.
