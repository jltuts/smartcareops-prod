resource "google_api_gateway_api" "api" {
  provider     = google-beta
  count        = var.enable_api_gateway ? 1 : 0
  project      = var.project_id
  api_id       = var.api_gateway_name
  display_name = "SmartCareOps DEV health baseline"
  labels       = local.labels
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
resource "google_api_gateway_api_config" "health" {
  provider             = google-beta
  count                = var.enable_api_gateway ? 1 : 0
  project              = var.project_id
  api                  = google_api_gateway_api.api[0].api_id
  api_config_id_prefix = "health-"
  display_name         = "Health-only baseline; no clinical data or Live streaming"
  labels               = local.labels
  openapi_documents {
    document {
      path = "openapi.yaml"
      contents = base64encode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url               = google_cloud_run_v2_service.api[0].uri
        enable_auth_routes        = var.enable_firebase_auth_routes
        enable_hosted_live        = false
        enable_m15                = var.enable_m15
        enable_m16                = var.enable_m16
        enable_m17                = var.enable_m17
        enable_m18                = var.enable_m18
        enable_m43_gateway_routes = var.enable_m43_gateway_routes
        }
      ))
    }
  }
  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway[0].email
    }
  }
  # API configs are immutable; preserve old config until gateway switches.
  lifecycle {
    create_before_destroy = true
  }
  depends_on = [google_cloud_run_v2_service_iam_member.gateway_invoker]
}
resource "google_api_gateway_api_config" "live" {
  provider             = google-beta
  count                = var.enable_hosted_live ? 1 : 0
  project              = var.project_id
  api                  = google_api_gateway_api.api[0].api_id
  api_config_id_prefix = "live-session-"
  display_name         = "Firebase-authenticated Live session bootstrap; no WebSocket route"
  labels               = local.labels
  openapi_documents {
    document {
      path = "openapi.yaml"
      contents = base64encode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url               = google_cloud_run_v2_service.api[0].uri
        enable_auth_routes        = var.enable_firebase_auth_routes
        enable_hosted_live        = true
        enable_m15                = var.enable_m15
        enable_m16                = var.enable_m16
        enable_m17                = var.enable_m17
        enable_m18                = var.enable_m18
        enable_m43_gateway_routes = var.enable_m43_gateway_routes
        }
      ))
    }
  }
  gateway_config {
    backend_config {
      google_service_account = google_service_account.gateway[0].email
    }
  }
  lifecycle {
    create_before_destroy = true
  }
  depends_on = [
    google_cloud_run_v2_service_iam_member.gateway_invoker,
    google_api_gateway_api_config.health,
  ]
}
resource "google_api_gateway_gateway" "api" {
  provider   = google-beta
  count      = var.enable_api_gateway ? 1 : 0
  project    = var.project_id
  region     = var.gateway_region
  gateway_id = var.api_gateway_name
  api_config = var.enable_hosted_live ? google_api_gateway_api_config.live[0].id : google_api_gateway_api_config.health[0].id
  labels     = local.labels
  lifecycle {
    prevent_destroy = true
  }
}
