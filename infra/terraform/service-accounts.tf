resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = "smartcareops-runtime"
  display_name = "SmartCareOps DEV API runtime"
  description  = "Application Firestore access and access to its single Gemini secret. No deployment privileges."
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
resource "google_service_account" "gateway" {
  count        = var.enable_api_gateway ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-gateway"
  display_name = "SmartCareOps DEV Gateway invoker"
  description  = "Invokes only the SmartCareOps Cloud Run service; no data or secret access."
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
