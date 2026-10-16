resource "google_vertex_ai_rag_engine_config" "m60_policy" {
  count           = var.enable_m60_phase_d_foundation ? 1 : 0
  project         = var.project_id
  region          = var.region
  deletion_policy = "PREVENT"
  rag_managed_db_config {
    basic {}
  }
  depends_on = [google_project_service.required]
}

resource "google_vertex_ai_rag_corpus" "m60_policy" {
  count           = var.enable_m60_phase_d_foundation ? 1 : 0
  project         = var.project_id
  region          = var.region
  display_name    = "smartcareops-fictional-clinical-review-${var.m60_policy_corpus_version}"
  description     = "Fictional SmartCareOps evidence-handling and AI safety policies only. No Patient data, treatment guidance, or clinical-use approval."
  deletion_policy = "PREVENT"

  vector_db_config {
    rag_managed_db {
      knn {}
    }
  }
  depends_on = [google_vertex_ai_rag_engine_config.m60_policy]
}

resource "google_model_armor_template" "m60_inspect" {
  count           = var.enable_m60_phase_d_foundation ? 1 : 0
  project         = var.project_id
  location        = var.region
  template_id     = "smartcareops-m60-inspect"
  deletion_policy = "PREVENT"
  labels          = local.labels

  filter_config {
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
    rai_settings {
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
    }
  }

  template_metadata {
    enforcement_type                   = "INSPECT_ONLY"
    ignore_partial_invocation_failures = false
    log_sanitize_operations            = false
    log_template_operations            = true
    filter_version_selector {
      alias = "FILTER_VERSION_ALIAS_STABLE"
    }
    multi_language_detection {
      enable_multi_language_detection = false
    }
  }
  depends_on = [google_project_service.required]
}

# Admission-only template for synchronous corpus screening. This template is
# not attached to Agent Runtime, Agent Gateway, or application traffic.
resource "google_model_armor_template" "m60_admission" {
  count           = var.enable_m60_phase_d_foundation ? 1 : 0
  project         = var.project_id
  location        = var.region
  template_id     = "smartcareops-m60-admission"
  deletion_policy = "PREVENT"
  labels          = local.labels

  filter_config {
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
    rai_settings {
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
    }
  }

  template_metadata {
    enforcement_type                   = "INSPECT_AND_BLOCK"
    ignore_partial_invocation_failures = false
    log_sanitize_operations            = false
    log_template_operations            = true
    filter_version_selector {
      alias = "FILTER_VERSION_ALIAS_STABLE"
    }
    multi_language_detection {
      enable_multi_language_detection = false
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "m60_model_armor_callout" {
  count   = var.enable_m60_phase_d_foundation ? 1 : 0
  project = var.project_id
  role    = "roles/modelarmor.calloutUser"
  member  = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "m60_model_armor_template_user" {
  count   = var.enable_m60_phase_d_foundation ? 1 : 0
  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:service-${data.google_project.existing.number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com"
}
