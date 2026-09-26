resource "google_compute_region_network_endpoint_group" "gateway" {
  provider              = google-beta
  count                 = var.enable_load_balancer ? 1 : 0
  project               = var.project_id
  region                = var.gateway_region
  name                  = "smartcareops-${var.environment}-gateway"
  network_endpoint_type = "SERVERLESS"
  serverless_deployment {
    platform = "apigateway.googleapis.com"
    resource = google_api_gateway_gateway.api[0].gateway_id
  }
  depends_on = [google_project_service.required]
}
resource "google_compute_backend_service" "gateway" {
  count                 = var.enable_load_balancer ? 1 : 0
  project               = var.project_id
  name                  = "smartcareops-${var.environment}-gateway"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge[0].id
  backend {
    group = google_compute_region_network_endpoint_group.gateway[0].id
  }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
  # Serverless NEGs must not have a health_checks attachment.
}
resource "google_compute_url_map" "api" {
  count           = var.enable_load_balancer ? 1 : 0
  project         = var.project_id
  name            = "smartcareops-${var.environment}"
  default_service = google_compute_backend_service.gateway[0].id
  # Unknown paths go to the configured-only Gateway and are rejected there.
  host_rule {
    hosts        = [var.domain_name]
    path_matcher = "smartcareops"
  }
  path_matcher {
    name            = "smartcareops"
    default_service = google_compute_backend_service.gateway[0].id
    path_rule {
      paths   = ["/health", "/readyz"]
      service = google_compute_backend_service.gateway[0].id
    }
    path_rule {
      paths   = ["/api/live"]
      service = google_compute_backend_service.live[0].id
    }
  }
}
resource "google_compute_region_network_endpoint_group" "live" {
  count                 = var.enable_load_balancer ? 1 : 0
  project               = var.project_id
  region                = var.region
  name                  = "smartcareops-${var.environment}-live"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.api[0].name
  }
  depends_on = [google_project_service.required]
}
resource "google_compute_backend_service" "live" {
  count                 = var.enable_load_balancer ? 1 : 0
  project               = var.project_id
  name                  = "smartcareops-${var.environment}-live"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge[0].id
  backend {
    group = google_compute_region_network_endpoint_group.live[0].id
  }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
  # No public IAM grant or injected credential. Caller must authenticate to Run.
  # Serverless NEGs do not use backend health checks or timeout_sec.
}
resource "google_compute_global_address" "api" {
  count   = var.enable_load_balancer ? 1 : 0
  project = var.project_id
  name    = "smartcareops-${var.environment}-https"
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}
resource "google_compute_managed_ssl_certificate" "api" {
  count   = var.enable_load_balancer ? 1 : 0
  project = var.project_id
  name    = "smartcareops-${var.environment}"
  managed {
    domains = [var.domain_name]
  }
  depends_on = [google_project_service.required]
}
resource "google_compute_target_https_proxy" "api" {
  count            = var.enable_load_balancer ? 1 : 0
  project          = var.project_id
  name             = "smartcareops-${var.environment}"
  url_map          = google_compute_url_map.api[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.api[0].id]
}
resource "google_compute_global_forwarding_rule" "https" {
  count                 = var.enable_load_balancer ? 1 : 0
  project               = var.project_id
  name                  = "smartcareops-${var.environment}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.api[0].address
  port_range            = "443"
  target                = google_compute_target_https_proxy.api[0].id
}
