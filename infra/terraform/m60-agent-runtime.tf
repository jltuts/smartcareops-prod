resource "google_service_account" "m60_clinical_agent" {
  count        = var.enable_m60_agent_runtime ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-clinical-agent"
  display_name = "SmartCareOps M60 Clinical Agent"
  description  = "Fictional-data Agent Runtime identity. No Firestore, Storage, Secret Manager, Pub/Sub, Cloud Run, or effect permissions."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_service_account" "m60_evaluation_invoker" {
  count        = var.enable_m60_agent_runtime ? 1 : 0
  project      = var.project_id
  account_id   = "smartcareops-agent-eval"
  display_name = "SmartCareOps M60 evaluation invoker"
  description  = "Queries only the isolated M60 reasoning engine during manually started fictional evaluations."
  lifecycle { prevent_destroy = true }
  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "m60_clinical_agent_vertex" {
  count   = var.enable_m60_agent_runtime ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.m60_clinical_agent[0].email}"
}

resource "google_artifact_registry_repository_iam_member" "m60_runtime_image_reader" {
  count      = var.enable_m60_agent_runtime ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.backend.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
}

resource "google_project_iam_custom_role" "m60_reasoning_engine_query" {
  count       = var.enable_m60_agent_runtime ? 1 : 0
  project     = var.project_id
  role_id     = "smartcareopsM60AgentQuery"
  title       = "SmartCareOps M60 Agent Query"
  description = "Query only the isolated M60 reasoning engine."
  permissions = ["aiplatform.reasoningEngines.query"]
  stage       = "GA"
}

resource "google_vertex_ai_reasoning_engine" "m60_clinical_shadow" {
  count        = var.enable_m60_agent_runtime ? 1 : 0
  project      = var.project_id
  region       = var.region
  display_name = "smartcareops-clinical-shadow"
  description  = "Non-publishing M60 Clinical Review Agent with isolated fixture evaluation and default-off application shadow contracts."
  spec {
    agent_framework = "google-adk"
    service_account = google_service_account.m60_clinical_agent[0].email
    container_spec { image_uri = var.m60_agent_container_image }
    deployment_spec {
      env {
        name  = "GOOGLE_GENAI_USE_ENTERPRISE"
        value = "true"
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = "global"
      }
      env {
        name  = "GEMINI_CLINICAL_MODEL"
        value = "gemini-3.6-flash"
      }
    }
    class_methods = jsonencode([
      { name = "query", api_mode = "" },
      { name = "query_application_shadow", api_mode = "" },
      { name = "stream_query", api_mode = "stream" },
    ])
  }
  lifecycle { prevent_destroy = true }
  depends_on = [
    google_artifact_registry_repository_iam_member.m60_runtime_image_reader,
    google_project_iam_member.m60_clinical_agent_vertex,
  ]
}

resource "google_vertex_ai_reasoning_engine_iam_member" "m60_evaluation_query" {
  count            = var.enable_m60_agent_runtime ? 1 : 0
  project          = var.project_id
  region           = var.region
  reasoning_engine = google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].name
  role             = google_project_iam_custom_role.m60_reasoning_engine_query[0].id
  member           = "serviceAccount:${google_service_account.m60_evaluation_invoker[0].email}"
}

resource "google_vertex_ai_reasoning_engine_iam_member" "m60_application_query" {
  count            = var.enable_m60_application_client ? 1 : 0
  project          = var.project_id
  region           = var.region
  reasoning_engine = google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].name
  role             = google_project_iam_custom_role.m60_reasoning_engine_query[0].id
  member           = "serviceAccount:${google_service_account.runtime.email}"
}
