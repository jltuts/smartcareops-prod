locals {
  run_metric_filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.cloud_run_service_name}\" AND resource.labels.location = \"${var.region}\""
}
resource "google_monitoring_alert_policy" "errors" {
  count                 = var.enable_monitoring ? 1 : 0
  project               = var.project_id
  display_name          = "SmartCareOps DEV sustained HTTP 5xx ratio"
  combiner              = "OR"
  notification_channels = var.notification_channels
  user_labels           = local.labels
  documentation {
    content   = "More than 5% of Cloud Run HTTP responses are 5xx for five minutes. Review revision logs and request volume. Missing data is not treated as failure; scale-to-zero is normal. No clinical interpretation."
    mime_type = "text/markdown"
  }
  conditions {
    display_name = "HTTP 5xx ratio > 5% for 5 minutes"
    condition_threshold {
      filter             = "${local.run_metric_filter} AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      denominator_filter = "${local.run_metric_filter} AND metric.type = \"run.googleapis.com/request_count\""
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      comparison              = "COMPARISON_GT"
      threshold_value         = 0.05
      duration                = "300s"
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"
      trigger {
        count = 1
      }
    }
  }
  depends_on = [google_project_service.required, google_cloud_run_v2_service.api]
}
resource "google_monitoring_uptime_check_config" "health" {
  count        = var.enable_monitoring && var.enable_api_gateway ? 1 : 0
  project      = var.project_id
  display_name = "SmartCareOps DEV HTTP health baseline"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path         = "/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.enable_load_balancer ? var.domain_name : google_api_gateway_gateway.api[0].default_hostname
    }
  }
  depends_on = [google_project_service.required]
}
resource "google_monitoring_alert_policy" "availability" {
  count                 = var.enable_monitoring && var.enable_api_gateway ? 1 : 0
  project               = var.project_id
  display_name          = "SmartCareOps DEV health endpoint unavailable"
  combiner              = "OR"
  notification_channels = var.notification_channels
  conditions {
    display_name = "Two probes fail for five minutes"
    condition_threshold {
      filter          = "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type = \"uptime_url\" AND metric.labels.check_id = \"${google_monitoring_uptime_check_config.health[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
      }
      trigger {
        count = 1
      }
    }
  }
  documentation {
    content   = "Health-only HTTP path. Does not certify Gemini, Firestore, Live voice, clinical correctness or worker progress. TLS/DNS must be ready when checking the custom domain."
    mime_type = "text/markdown"
  }
}
resource "google_monitoring_dashboard" "api" {
  count   = var.enable_monitoring ? 1 : 0
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "SmartCareOps DEV platform"
    gridLayout = {
      columns = 2, widgets = [
        for metric in ["request_count", "container/instance_count", "container/startup_latencies"] : {
          title = "Cloud Run ${metric}"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "${local.run_metric_filter} AND metric.type = \"run.googleapis.com/${metric}\""
                  aggregation = {
                    alignmentPeriod = "60s", perSeriesAligner = metric == "request_count" ? "ALIGN_RATE" : metric == "container/startup_latencies" ? "ALIGN_PERCENTILE_95" : "ALIGN_MEAN"
                  }
                }
              }
              }
              ], yAxis = {
              label = metric, scale = "LINEAR"
            }
          }
        }
      ]
    }
    }
  )
  depends_on = [google_project_service.required]
}
# Cloud Run stdout/stderr and request logs are collected by the platform.
# No log sink, retention override, notification channel or application telemetry agent.
