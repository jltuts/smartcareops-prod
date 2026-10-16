mock_provider "google" {}
mock_provider "google-beta" {}

override_resource {
  target = google_firestore_database.existing
  values = { id = "projects/gen-lang-client-0710663107/databases/(default)" }
}
override_resource {
  target = google_project_service.required["firestore.googleapis.com"]
  values = { id = "gen-lang-client-0710663107/firestore.googleapis.com" }
}
override_resource {
  target = google_project_service.required["generativelanguage.googleapis.com"]
  values = { id = "gen-lang-client-0710663107/generativelanguage.googleapis.com" }
}

variables {
  enable_cloud_run                       = false
  enable_api_gateway                     = false
  enable_load_balancer                   = false
  enable_monitoring                      = false
  enable_firebase_auth_routes            = false
  enable_hosted_live                     = false
  enable_m15                             = false
  enable_m16                             = false
  enable_m17                             = false
  enable_m18                             = false
  enable_m30                             = false
  enable_m55                             = false
  enable_m55_workers                     = false
  enable_m55_operations_worker           = false
  enable_m55_operations_source           = false
  enable_m55_clinical_shadow_worker      = false
  enable_m55_notifications_shadow_worker = false
  enable_m55_case_processing             = false
  enable_m57_agentic_operations          = false
  enable_m57_operations_capacity_source  = false
  enable_m57_reviewed_coordination       = false
  enable_m60_agent_runtime               = false
  enable_m60_phase_d_foundation           = false
  enable_m60_application_client           = false
  enable_m60_application_shadow           = false
  enable_m60_application_review           = false
  m60_agent_container_image               = null
  m60_policy_corpus_version               = null
  m60_policy_manifest_digest              = null
  container_image                        = null
  gateway_region                         = null
}

run "m60_is_absent_by_default" {
  command = plan
  assert {
    condition = (length(google_vertex_ai_reasoning_engine.m60_clinical_shadow) == 0 &&
      length(google_service_account.m60_clinical_agent) == 0 &&
      length(google_service_account.m60_evaluation_invoker) == 0 &&
      length(google_vertex_ai_rag_corpus.m60_policy) == 0 &&
      length(google_model_armor_template.m60_inspect) == 0 &&
      length(google_model_armor_template.m60_admission) == 0 &&
      !contains(local.services, "aiplatform.googleapis.com") &&
    !contains(local.services, "modelarmor.googleapis.com"))
    error_message = "M60 resources and API must remain absent by default."
  }
}

run "m60_phase_d_requires_the_exact_approved_corpus" {
  command = plan
  variables {
    enable_m60_agent_runtime      = true
    m60_agent_container_image     = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation = true
    m60_policy_corpus_version     = "m60-fictional-v1"
    m60_policy_manifest_digest    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.enable_m60_phase_d_foundation]
}

run "m60_phase_d_foundation_has_isolated_pilot_and_admission_templates" {
  command = plan
  variables {
    enable_m60_agent_runtime      = true
    m60_agent_container_image     = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation = true
    m60_policy_corpus_version     = "m60-fictional-v1"
    m60_policy_manifest_digest    = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
  }
  assert {
    condition = (contains(local.services, "aiplatform.googleapis.com") &&
      contains(local.services, "modelarmor.googleapis.com") &&
      google_vertex_ai_rag_engine_config.m60_policy[0].region == "asia-southeast1" &&
      google_vertex_ai_rag_corpus.m60_policy[0].region == "asia-southeast1" &&
      strcontains(google_vertex_ai_rag_corpus.m60_policy[0].description, "No Patient data") &&
      google_model_armor_template.m60_inspect[0].location == "asia-southeast1" &&
      google_model_armor_template.m60_inspect[0].template_metadata[0].enforcement_type == "INSPECT_ONLY" &&
      google_model_armor_template.m60_inspect[0].template_metadata[0].log_sanitize_operations == false &&
      google_model_armor_template.m60_admission[0].location == "asia-southeast1" &&
      google_model_armor_template.m60_admission[0].template_metadata[0].enforcement_type == "INSPECT_AND_BLOCK" &&
    google_model_armor_template.m60_admission[0].template_metadata[0].log_sanitize_operations == false)
    error_message = "Phase D must keep separate Singapore pilot and admission templates with sanitize-content logging disabled."
  }
  assert {
    condition = (google_project_iam_member.m60_model_armor_callout[0].role == "roles/modelarmor.calloutUser" &&
      google_project_iam_member.m60_model_armor_template_user[0].role == "roles/modelarmor.user" &&
    !contains(local.services, "networkservices.googleapis.com"))
    error_message = "Phase D grants only documented Model Armor service-agent roles and must not create an unattached Agent Gateway."
  }
}

run "m60_requires_an_immutable_image" {
  command = plan
  variables {
    enable_m60_agent_runtime  = true
    m60_agent_container_image = null
  }
  expect_failures = [var.enable_m60_agent_runtime]
}

run "m60_runtime_is_isolated_and_query_only" {
  command = plan
  variables {
    enable_m60_agent_runtime  = true
    m60_agent_container_image = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition = (contains(local.services, "aiplatform.googleapis.com") &&
      google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].region == "asia-southeast1" &&
      google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].container_spec[0].image_uri == var.m60_agent_container_image &&
      anytrue([for env in google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].deployment_spec[0].env : env.name == "GOOGLE_GENAI_USE_ENTERPRISE" && env.value == "true"]) &&
      anytrue([for env in google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].deployment_spec[0].env : env.name == "GOOGLE_CLOUD_LOCATION" && env.value == "global"]) &&
      anytrue([for env in google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].deployment_spec[0].env : env.name == "GEMINI_CLINICAL_MODEL" && env.value == "gemini-3.6-flash"]) &&
      !anytrue([for env in google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].deployment_spec[0].env : env.name == "GOOGLE_CLOUD_PROJECT"]) &&
    google_service_account.m60_clinical_agent[0].account_id == "smartcareops-clinical-agent")
    error_message = "M60 must use the dedicated identity, Singapore region, immutable reviewed image, and no reserved project environment variable."
  }
  assert {
    condition = (google_project_iam_member.m60_clinical_agent_vertex[0].role == "roles/aiplatform.user" &&
      google_artifact_registry_repository_iam_member.m60_runtime_image_reader[0].role == "roles/artifactregistry.reader" &&
      length(google_project_iam_custom_role.m60_reasoning_engine_query[0].permissions) == 1 &&
      contains(google_project_iam_custom_role.m60_reasoning_engine_query[0].permissions, "aiplatform.reasoningEngines.query") &&
      google_service_account.m60_evaluation_invoker[0].account_id == "smartcareops-agent-eval" &&
    length(google_vertex_ai_reasoning_engine_iam_member.m60_evaluation_query) == 1)
    error_message = "M60 identities must remain separate and the evaluator must receive query-only access."
  }
}

run "m60_application_client_is_query_only_and_default_off" {
  command = plan
  variables {
    enable_cloud_run              = true
    container_image               = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_m60_agent_runtime      = true
    m60_agent_container_image     = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation = true
    m60_policy_corpus_version     = "m60-fictional-v1"
    m60_policy_manifest_digest    = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    enable_m60_application_client = true
  }
  assert {
    condition = (length(google_vertex_ai_reasoning_engine_iam_member.m60_application_query) == 1 &&
      length(google_project_iam_custom_role.m60_reasoning_engine_query[0].permissions) == 1 &&
      contains(google_project_iam_custom_role.m60_reasoning_engine_query[0].permissions, "aiplatform.reasoningEngines.query") &&
    strcontains(google_vertex_ai_reasoning_engine.m60_clinical_shadow[0].spec[0].class_methods, "query_application_shadow"))
    error_message = "The application identity may receive only the existing single-engine query role, and the runtime must expose the separate application-shadow method."
  }
  assert {
    condition = (anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_CLINICAL_AGENT_MODE" && env.value == "off"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_AGENT_PROJECT_ID" && env.value == var.project_id]) &&
    anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_POLICY_MANIFEST_DIGEST" && env.value == var.m60_policy_manifest_digest]))
    error_message = "The installed application client must remain off and bind the exact managed engine and accepted policy manifest."
  }
}

run "m60_application_shadow_is_exact_bounded_and_non_reviewing" {
  command = plan
  variables {
    enable_cloud_run                = true
    container_image                 = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_m60_agent_runtime        = true
    m60_agent_container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation   = true
    m60_policy_corpus_version       = "m60-fictional-v1"
    m60_policy_manifest_digest      = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    enable_m60_application_client   = true
    enable_m60_application_shadow   = true
    m60_shadow_case_ids             = ["SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]
    m60_shadow_start_at             = "2026-10-16T00:00:00Z"
    m60_shadow_end_at               = "2026-10-16T01:00:00Z"
  }
  assert {
    condition = (anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_CLINICAL_AGENT_MODE" && env.value == "shadow"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_GATE_C_ACCEPTED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_GATE_D_ACCEPTED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_CASE_IDS" && env.value == "SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_START_AT" && env.value == "2026-10-16T00:00:00Z"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_END_AT" && env.value == "2026-10-16T01:00:00Z"]) &&
      !anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_REVIEW_CUTOVER_APPROVED"]))
    error_message = "Phase E2 must use only the exact fictional cohort and bounded shadow window without enabling managed review output."
  }
}

run "m60_application_shadow_rejects_an_unbounded_window" {
  command = plan
  variables {
    enable_cloud_run                = true
    container_image                 = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_m60_agent_runtime        = true
    m60_agent_container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation   = true
    m60_policy_corpus_version       = "m60-fictional-v1"
    m60_policy_manifest_digest      = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    enable_m60_application_client   = true
    enable_m60_application_shadow   = true
    m60_shadow_case_ids             = ["SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]
    m60_shadow_start_at             = "2026-10-16T00:00:00Z"
    m60_shadow_end_at               = "2026-10-17T00:00:01Z"
  }
  expect_failures = [var.m60_shadow_end_at]
}

run "m60_application_review_is_exact_bounded_and_keeps_fallback" {
  command = plan
  variables {
    enable_cloud_run                = true
    container_image                 = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_m60_agent_runtime        = true
    m60_agent_container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation   = true
    m60_policy_corpus_version       = "m60-fictional-v1"
    m60_policy_manifest_digest      = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    enable_m60_application_client   = true
    enable_m60_application_review   = true
    m60_shadow_case_ids             = ["SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]
    m60_shadow_start_at             = "2026-10-16T00:00:00Z"
    m60_shadow_end_at               = "2026-10-16T01:00:00Z"
  }
  assert {
    condition = (anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_CLINICAL_AGENT_MODE" && env.value == "review"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_REVIEW_CUTOVER_APPROVED" && env.value == "true"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_CASE_IDS" && env.value == "SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_START_AT" && env.value == "2026-10-16T00:00:00Z"]) &&
      anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "M60_SHADOW_END_AT" && env.value == "2026-10-16T01:00:00Z"]))
    error_message = "Fictional review must be limited to the exact case cohort and bounded window with explicit review approval."
  }
}

run "m60_application_review_rejects_shadow_at_the_same_time" {
  command = plan
  variables {
    enable_cloud_run                = true
    container_image                 = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/backend@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    enable_m60_agent_runtime        = true
    m60_agent_container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/clinical-shadow@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    enable_m60_phase_d_foundation   = true
    m60_policy_corpus_version       = "m60-fictional-v1"
    m60_policy_manifest_digest      = "831f6962ce002e0c5e6d5ea2303c469f80e188e3398fc2cd65207b25350f5356"
    enable_m60_application_client   = true
    enable_m60_application_shadow   = true
    enable_m60_application_review   = true
    m60_shadow_case_ids             = ["SC-774d9ea3-8e85-43d5-b16e-5fcdc1f8bd65"]
    m60_shadow_start_at             = "2026-10-16T00:00:00Z"
    m60_shadow_end_at               = "2026-10-16T01:00:00Z"
  }
  expect_failures = [var.enable_m60_application_review]
}
