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
resource "google_service_account" "live_runtime" {
  count        = var.enable_m30 && var.enable_hosted_live ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-live-runtime"
  display_name = "SmartCareOps DEV Live runtime"
  description  = "Live transport Firestore and Gemini access without Patient evidence object access."
  lifecycle { prevent_destroy = true }
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

resource "google_service_account" "event_publisher" {
  count        = var.enable_m55 ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-event-publisher"
  display_name = "SmartCareOps DEV event publisher"
  description  = "Publishes committed outbox envelopes only; it has no subscription access."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "event_consumer" {
  for_each     = var.enable_m55 ? local.event_consumer_account_ids : {}
  project      = var.project_id
  account_id   = each.value
  display_name = "SmartCareOps DEV ${each.key} event worker"
  description  = "Runs only the ${each.key} event consumer; no application data role is granted by M55 foundation."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "event_push_invoker" {
  count        = var.enable_m55_workers ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-pubsub-push"
  display_name = "SmartCareOps DEV Pub/Sub push invoker"
  description  = "Invokes only the private M55 audit receiver; it has no application data access."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "event_operations_push_invoker" {
  count        = var.enable_m55_operations_worker ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-operations-push"
  display_name = "SmartCareOps DEV operations push invoker"
  description  = "Invokes only the private M55 operations projection receiver; it has no application data access."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}
