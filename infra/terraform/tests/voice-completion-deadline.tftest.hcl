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
  enable_cloud_run            = false
  enable_api_gateway          = false
  enable_load_balancer        = false
  enable_monitoring           = false
  enable_firebase_auth_routes = false
  enable_hosted_live          = false
  container_image             = null
  gemini_secret_version       = "latest"
  gateway_region              = null
}
mock_provider "google" {}
mock_provider "google-beta" {}

run "voice_completion_has_bounded_extraction_deadline" {
  command = plan
  assert {
    condition = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths["/api/intake/voice/complete"].post["x-google-backend"] == {
      address          = "https://backend.example", jwt_audience = "https://backend.example",
      path_translation = "APPEND_PATH_TO_ADDRESS", deadline = 60.0
    }
    error_message = "Voice completion must allow bounded extraction and persistence to finish without changing other Gateway deadlines."
  }
  assert {
    condition = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
    }))["x-google-backend"].deadline == 15.0
    error_message = "The global Gateway deadline must remain unchanged."
  }
}
