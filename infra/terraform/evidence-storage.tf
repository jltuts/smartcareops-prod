resource "google_storage_bucket" "patient_evidence" {
  count                       = var.enable_m30 ? 1 : 0
  project                     = var.project_id
  name                        = "${var.project_id}-smartcareops-evidence"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  # A case deletion must actually remove its evidence. No time-based lifecycle
  # is set for committed objects while the product retention period is unresolved.
  soft_delete_policy { retention_duration_seconds = 0 }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket_iam_member" "api_evidence_objects" {
  count  = var.enable_m30 ? 1 : 0
  bucket = google_storage_bucket.patient_evidence[0].name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.runtime.email}"
}
