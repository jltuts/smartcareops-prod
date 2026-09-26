resource "google_firestore_database" "existing" {
  project = var.project_id
  name    = "(default)"
  # Immutable brownfield facts: never derive these from deployment region.
  location_id                       = "asia-southeast1"
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "STANDARD"
  concurrency_mode                  = "PESSIMISTIC"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  # One intentional in-place safety update from currently DISABLED.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "PREVENT"
  lifecycle {
    prevent_destroy = true
  }
}
