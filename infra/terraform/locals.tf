locals {
  labels = {
    application = "smartcareops", environment = var.environment, managed_by = "terraform"
  }
  # Needed for this platform or existing Gemini Developer API; no Vertex migration.
  services = toset(concat([
    "serviceusage.googleapis.com", "firestore.googleapis.com", "generativelanguage.googleapis.com",
    "run.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com",
    "apigateway.googleapis.com", "servicecontrol.googleapis.com", "servicemanagement.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "storage.googleapis.com"
  ], var.enable_load_balancer ? ["compute.googleapis.com"] : [], var.enable_m55 ? ["pubsub.googleapis.com"] : [], var.enable_m60_agent_runtime ? ["aiplatform.googleapis.com"] : [], var.enable_m60_phase_d_foundation ? ["modelarmor.googleapis.com"] : []))
  # Verified enabled in DEV. Other enabled APIs remain unmanaged, not disabled.
  adopted_services = toset(["firestore.googleapis.com", "generativelanguage.googleapis.com"])
  runtime_environment = {
    APP_ENV                           = "development"
    NODE_ENV                          = "production"
    CASE_STORE                        = "firestore"
    FIREBASE_PROJECT_ID               = var.project_id
    DEV_AUTH_UIDS                     = join(",", var.dev_auth_uids)
    DEV_PATIENT_UIDS                  = join(",", var.dev_patient_uids)
    ADMIN_UIDS                        = join(",", var.admin_uids)
    ALLOWED_ORIGINS                   = join(",", var.allowed_origins)
    COMPUTER_USE_HEADLESS             = "true"
    HOSPITAL_HANDOFF_CONNECTOR        = "rest"
    M8_ENABLED                        = "true"
    M15_ENABLED                       = tostring(var.enable_m15)
    M16_ENABLED                       = tostring(var.enable_m16)
    M17_ENABLED                       = tostring(var.enable_m17)
    M18_ENABLED                       = tostring(var.enable_m18)
    M9_ENABLED                        = "false"
    M10_ENABLED                       = tostring(var.enable_m57_reviewed_coordination)
    M11_ENABLED                       = "false"
    M12_ENABLED                       = tostring(var.enable_m21 || var.enable_m57_reviewed_coordination)
    M57_REVIEWED_COORDINATION_ENABLED = tostring(var.enable_m57_reviewed_coordination)
    RESOURCE_MODE                     = "simulation"
    MAPS_MODE                         = "simulation"
  }
}
