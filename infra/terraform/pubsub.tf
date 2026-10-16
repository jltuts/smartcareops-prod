locals {
  event_consumer_account_ids = {
    audit         = "smartcareops-audit-worker"
    clinical      = "smartcareops-clinical-worker"
    notifications = "smartcareops-notify-worker"
    operations    = "smartcareops-operations-worker"
  }
  event_subscription_filters = {
    clinical      = "attributes.event_family = \"clinical\""
    notifications = "attributes.event_family = \"notifications\""
    operations    = "attributes.event_family = \"operations\""
  }
}

# M55 phase A is deliberately dormant: no application publisher or worker is
# connected. The topic policy is fixed to Singapore before any patient event can
# enter the plane. Later phases must preserve the transactional outbox boundary.
resource "google_pubsub_topic" "care_events" {
  count   = var.enable_m55 ? 1 : 0
  project = var.project_id
  name    = "smartcareops-care-events"
  labels  = local.labels
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  message_retention_duration = "86400s"
  depends_on                 = [google_project_service.required]
}

resource "google_pubsub_topic" "dead_letter" {
  count   = var.enable_m55 ? 1 : 0
  project = var.project_id
  name    = "smartcareops-care-events-dead-letter"
  labels  = local.labels
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.required]
}

resource "google_pubsub_subscription" "audit" {
  count   = var.enable_m55 ? 1 : 0
  project = var.project_id
  name    = "smartcareops-audit-events"
  topic   = google_pubsub_topic.care_events[0].id

  ack_deadline_seconds       = 30
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[0].id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  dynamic "push_config" {
    for_each = var.enable_m55_workers ? [1] : []
    content {
      push_endpoint = "${google_cloud_run_v2_service.event_audit[0].uri}/events/audit"
      oidc_token {
        service_account_email = google_service_account.event_push_invoker[0].email
        audience              = google_cloud_run_v2_service.event_audit[0].uri
      }
      attributes = { x-goog-version = "v1" }
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.event_audit_invoker, google_project_iam_member.pubsub_push_token_creator]
}

resource "google_pubsub_subscription" "event_consumer" {
  for_each = var.enable_m55 ? local.event_subscription_filters : {}
  project  = var.project_id
  name     = "smartcareops-${each.key}-events"
  topic    = google_pubsub_topic.care_events[0].id
  filter   = each.value

  ack_deadline_seconds       = each.key == "operations" && var.enable_m57_agentic_operations || each.key == "clinical" && var.enable_m55_case_processing ? 120 : 30
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[0].id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
  dynamic "push_config" {
    for_each = each.key == "operations" && var.enable_m55_operations_worker ? [1] : []
    content {
      push_endpoint = "${google_cloud_run_v2_service.event_operations[0].uri}/events/operations"
      oidc_token {
        service_account_email = google_service_account.event_operations_push_invoker[0].email
        audience              = google_cloud_run_v2_service.event_operations[0].uri
      }
      attributes = { x-goog-version = "v1" }
    }
  }
  dynamic "push_config" {
    for_each = contains(keys(local.m55_shadow_workers), each.key) ? [1] : []
    content {
      push_endpoint = "${google_cloud_run_v2_service.event_shadow[each.key].uri}/events/${each.key}"
      oidc_token {
        service_account_email = google_service_account.event_shadow_push_invoker[each.key].email
        audience              = google_cloud_run_v2_service.event_shadow[each.key].uri
      }
      attributes = { x-goog-version = "v1" }
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.event_operations_invoker,
  google_cloud_run_v2_service_iam_member.event_shadow_invoker, google_project_iam_member.pubsub_push_token_creator]
}

resource "google_pubsub_topic_iam_member" "publisher" {
  count   = var.enable_m55 ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.care_events[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.event_publisher[0].email}"
}

resource "google_pubsub_subscription_iam_member" "consumer" {
  for_each = var.enable_m55 ? {
    for key, account in google_service_account.event_consumer : key => account
    if key != "audit" || !var.enable_m55_workers
  } : {}
  project      = var.project_id
  subscription = each.key == "audit" ? google_pubsub_subscription.audit[0].name : google_pubsub_subscription.event_consumer[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${each.value.email}"
}

# Pub/Sub's service agent needs only the documented permissions required to
# forward exhausted deliveries into the dead-letter topic.
resource "google_pubsub_topic_iam_member" "dead_letter_service_agent" {
  count   = var.enable_m55 ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.dead_letter[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_forwarder" {
  for_each     = var.enable_m55 ? merge({ audit = google_pubsub_subscription.audit[0].name }, { for key, subscription in google_pubsub_subscription.event_consumer : key => subscription.name }) : {}
  project      = var.project_id
  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
