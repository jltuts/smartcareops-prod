resource "google_project_service" "required" {
  for_each                   = local.services
  project                    = var.project_id
  service                    = each.value
  deletion_policy            = "ABANDON"
  disable_on_destroy         = false
  disable_dependent_services = false
}
