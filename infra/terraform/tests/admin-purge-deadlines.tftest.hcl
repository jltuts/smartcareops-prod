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

run "admin_purge_gateway_deadlines" {
  command = plan
  assert {
    condition = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      }))["x-google-backend"] == {
      address          = "https://backend.example", jwt_audience = "https://backend.example",
      path_translation = "APPEND_PATH_TO_ADDRESS", deadline = 15.0
    }
    error_message = "The global Gateway backend configuration must remain unchanged."
  }
  assert {
    condition = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths["/api/admin/purge-preview"].get["x-google-backend"] == {
      address          = "https://backend.example", jwt_audience = "https://backend.example",
      path_translation = "APPEND_PATH_TO_ADDRESS", deadline = 60.0
    }
    error_message = "Purge preview must retain routing and use a 60-second Gateway deadline."
  }
  assert {
    condition = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
      })).paths["/api/admin/purge"].post["x-google-backend"] == {
      address          = "https://backend.example", jwt_audience = "https://backend.example",
      path_translation = "APPEND_PATH_TO_ADDRESS", deadline = 240.0
    }
    error_message = "Purge execution must retain routing and use a 240-second Gateway deadline."
  }
  assert {
    condition = !contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true,
      enable_m15  = true, enable_m16 = true, enable_m17 = true, enable_m18 = true, enable_m43_gateway_routes = false
    })).paths["/api/admin/doctor-applications/{uid}/decision"].post), "x-google-backend")
    error_message = "Unrelated Admin routes must continue using the global deadline."
  }
}
