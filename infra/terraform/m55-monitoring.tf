locals {
  m55_monitoring_enabled = var.enable_m55_workers && var.enable_monitoring
  m55_subscription_ids = concat(
    ["smartcareops-audit-events"],
    [for family in keys(local.event_subscription_filters) : "smartcareops-${family}-events"]
  )
}

# Application failures are emitted as bounded aggregate records without event
# payloads, patient text, case IDs, or provider error details.
resource "google_logging_metric" "m55_worker_failures" {
  count       = local.m55_monitoring_enabled ? 1 : 0
  project     = var.project_id
  name        = "smartcareops_m55_worker_failures"
  description = "M55 event-worker failures without clinical payloads"
  filter      = "textPayload=~\"^\\[(${join("|", concat(["event-worker", "audit-push"], var.enable_m55_operations_worker ? ["operations-push"] : [], length(local.m55_shadow_workers) > 0 ? ["shadow-push"] : []))})\\]\" AND severity>=ERROR"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "m55_worker_failures" {
  count                 = local.m55_monitoring_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "SmartCareOps DEV M55 worker failure"
  combiner              = "OR"
  notification_channels = var.notification_channels
  user_labels           = local.labels
  conditions {
    display_name = "M55 publisher failure"
    condition_threshold {
      filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.m55_worker_failures[0].name}\" AND resource.type = \"cloud_run_worker_pool\" AND resource.labels.worker_pool_name = \"smartcareops-event-publisher\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
      trigger { count = 1 }
    }
  }
  dynamic "conditions" {
    for_each = var.enable_m55_operations_worker ? [1] : []
    content {
      display_name = "M55 operations projection failure"
      condition_threshold {
        filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.m55_worker_failures[0].name}\" AND resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"smartcareops-operations-worker\""
        comparison      = "COMPARISON_GT"
        threshold_value = 0
        duration        = "0s"
        aggregations {
          alignment_period   = "60s"
          per_series_aligner = "ALIGN_RATE"
        }
        trigger { count = 1 }
      }
    }
  }
  dynamic "conditions" {
    for_each = local.m55_shadow_workers
    content {
      display_name = "M55 ${conditions.key} shadow failure"
      condition_threshold {
        filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.m55_worker_failures[0].name}\" AND resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${conditions.value}\""
        comparison      = "COMPARISON_GT"
        threshold_value = 0
        duration        = "0s"
        aggregations {
          alignment_period   = "60s"
          per_series_aligner = "ALIGN_RATE"
        }
        trigger { count = 1 }
      }
    }
  }
  conditions {
    display_name = "M55 audit receiver failure"
    condition_threshold {
      filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.m55_worker_failures[0].name}\" AND resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"smartcareops-audit-worker\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
      trigger { count = 1 }
    }
  }
  documentation {
    content   = "An M55 event worker reported a bounded failure. Inspect Cloud Run logs and the Firestore outbox status. Existing synchronous application results remain authoritative."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "m55_backlog_age" {
  count                 = local.m55_monitoring_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "SmartCareOps DEV M55 subscription backlog age"
  combiner              = "OR"
  notification_channels = var.notification_channels
  user_labels           = local.labels
  conditions {
    display_name = "Oldest M55 message exceeds five minutes"
    condition_threshold {
      filter                  = "metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.type = \"pubsub_subscription\" AND (${join(" OR ", [for id in local.m55_subscription_ids : "resource.labels.subscription_id = \"${id}\""])})"
      comparison              = "COMPARISON_GT"
      threshold_value         = 300
      duration                = "300s"
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
      }
      trigger { count = 1 }
    }
  }
  documentation {
    content   = "An M55 subscription has retained an unacknowledged event for more than five minutes. Check the relevant consumer before moving additional behavior to Pub/Sub."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "m55_dead_letter" {
  count                 = local.m55_monitoring_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "SmartCareOps DEV M55 dead-letter delivery"
  combiner              = "OR"
  notification_channels = var.notification_channels
  user_labels           = local.labels
  conditions {
    display_name = "An M55 event reached the dead-letter topic"
    condition_threshold {
      filter          = "metric.type = \"pubsub.googleapis.com/subscription/dead_letter_message_count\" AND resource.type = \"pubsub_subscription\" AND (${join(" OR ", [for id in local.m55_subscription_ids : "resource.labels.subscription_id = \"${id}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  documentation {
    content   = "Pub/Sub forwarded an M55 event after bounded delivery attempts. Inspect the source subscription and dead-letter topic; do not replay until the consumer failure is understood."
    mime_type = "text/markdown"
  }
}
