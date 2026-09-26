provider "google" {
  project = var.project_id
  region  = var.region
}
provider "google-beta" {
  project = var.project_id
  region  = var.region
}
# Existing project is read-only. No google_project resource or rename.
data "google_project" "existing" {
  project_id = var.project_id
}
