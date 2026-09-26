resource "google_compute_security_policy" "edge" {
  count       = var.enable_load_balancer ? 1 : 0
  project     = var.project_id
  name        = "smartcareops-${var.environment}"
  description = "Conservative baseline: allow traffic; preview SQL injection rule for review"
  type        = "CLOUD_ARMOR"
  rule {
    priority    = 1000
    action      = "deny(403)"
    preview     = true
    description = "Observe WAF matches before considering enforcement"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
  }
  rule {
    priority = 2147483647
    action   = "allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Allow by default; avoid breaking the DEV demo"
  }
  depends_on = [google_project_service.required]
}
