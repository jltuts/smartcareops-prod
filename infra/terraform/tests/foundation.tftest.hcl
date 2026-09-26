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
# Provider-mocked plans only. These do not contact GCP or apply resources.
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
run "default_is_adoption_only" {
  command = plan
  assert {
    condition     = keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = false, enable_hosted_live = false, enable_m15 = false, enable_m16 = false, enable_m17 = false })).paths) == ["/health", "/readyz"]
    error_message = "Only the two verified status routes may be published before user authentication."
  }
  assert {
    condition     = yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", { backend_url = "https://backend.example", enable_auth_routes = false, enable_hosted_live = false, enable_m15 = false, enable_m16 = false, enable_m17 = false }))["x-google-allow"] == "configured"
    error_message = "Gateway must reject unconfigured routes."
  }
  assert {
    condition     = length(google_cloud_run_v2_service.api) == 0 && length(google_api_gateway_gateway.api) == 0 && length(google_compute_global_forwarding_rule.https) == 0
    error_message = "Default foundation must not deploy an image, Gateway or public edge."
  }
  assert {
    condition     = google_firestore_database.existing.name == "(default)" && google_firestore_database.existing.location_id == "asia-southeast1" && google_firestore_database.existing.deletion_policy == "PREVENT"
    error_message = "Existing database identity/location and protection must be preserved."
  }
}
run "missing_image_is_rejected" {
  command = plan
  variables { enable_cloud_run = true }
  expect_failures = [var.enable_cloud_run]
}
run "cloud_run_uses_latest_secret_reference" {
  command = plan
  variables {
    enable_cloud_run = true
    # Synthetic digest used only by mock providers; never deployed.
    container_image = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  assert {
    condition     = anytrue([for env in google_cloud_run_v2_service.api[0].template[0].containers[0].env : env.name == "GEMINI_API_KEY" && try(env.value_source[0].secret_key_ref[0].version == "latest", false)])
    error_message = "Gemini must use a Secret Manager latest reference."
  }
  assert {
    condition     = length(google_api_gateway_gateway.api) == 0 && length(google_compute_global_forwarding_rule.https) == 0
    error_message = "Cloud Run preparation must keep Gateway and edge disabled."
  }
}
run "unsupported_gateway_region_is_rejected" {
  command = plan
  variables { gateway_region = "asia-southeast1" }
  expect_failures = [var.gateway_region]
}
run "production_is_rejected" {
  command = plan
  variables { environment = "prod" }
  expect_failures = [var.environment]
}
run "optional_platform_schema" {
  command = plan
  variables {
    enable_cloud_run     = true
    enable_api_gateway   = true
    enable_load_balancer = true
    enable_monitoring    = true
    # Explicit test fixture, provider-mocked only. Not in deployable tfvars.
    container_image       = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gemini_secret_version = "1"
    gateway_region        = "asia-northeast1"
    domain_name           = "test.example.org"
  }
  assert {
    condition     = google_cloud_run_v2_service.api[0].invoker_iam_disabled == false && google_cloud_run_v2_service_iam_member.gateway_invoker[0].role == "roles/run.invoker"
    error_message = "Gateway invocation must use IAM, never public Cloud Run."
  }
  assert {
    condition     = google_compute_region_network_endpoint_group.gateway[0].region == var.gateway_region && google_compute_backend_service.gateway[0].load_balancing_scheme == "EXTERNAL_MANAGED"
    error_message = "Gateway NEG and gateway must be colocated behind the global external ALB."
  }
  assert {
    condition     = google_compute_region_network_endpoint_group.live[0].region == "asia-southeast1" && google_compute_region_network_endpoint_group.live[0].cloud_run[0].service == "smartcareops-api" && google_compute_backend_service.live[0].log_config[0].enable
    error_message = "Live must use the Singapore Cloud Run NEG with backend logging."
  }
  assert {
    condition     = toset(flatten([for rule in google_compute_url_map.api[0].path_matcher[0].path_rule : rule.paths])) == toset(["/health", "/readyz", "/api/live"])
    error_message = "Edge must use only the actual exact Live path and two status routes."
  }
  assert {
    condition     = alltrue([for rule in google_compute_security_policy.edge[0].rule : rule.action == "allow" || rule.preview])
    error_message = "DEV Armor must not enforce aggressive blocking rules."
  }
}
run "edge_requires_owned_domain" {
  command = plan
  variables {
    enable_cloud_run     = true
    enable_api_gateway   = true
    enable_load_balancer = true
    gateway_region       = "asia-northeast1"
    domain_name          = null
    container_image      = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.enable_load_balancer]
}
run "m16_requires_m15_and_authenticated_gateway" {
  command = plan
  variables { enable_m16 = true }
  expect_failures = [var.enable_m16]
}
run "m17_requires_m16_and_authenticated_gateway" {
  command = plan
  variables { enable_m17 = true }
  expect_failures = [var.enable_m17]
}
run "hosted_live_is_isolated_from_private_api" {
  command = plan
  variables {
    enable_cloud_run            = true
    enable_api_gateway          = true
    enable_firebase_auth_routes = true
    enable_hosted_live          = true
    enable_m15                  = true
    enable_m16                  = true
    enable_m17                  = true
    container_image             = "asia-southeast1-docker.pkg.dev/gen-lang-client-0710663107/smartcareops/test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    gateway_region              = "asia-northeast1"
  }
  assert {
    condition = (google_cloud_run_v2_service.live[0].name == "smartcareops-live" &&
      google_cloud_run_v2_service_iam_member.live_public_invoker[0].name == google_cloud_run_v2_service.live[0].name &&
      google_cloud_run_v2_service_iam_member.live_public_invoker[0].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.gateway_invoker[0].name == google_cloud_run_v2_service.api[0].name &&
    google_cloud_run_v2_service_iam_member.gateway_invoker[0].member != "allUsers")
    error_message = "Only the isolated Live transport may be publicly invokable; the REST API must remain IAM-protected."
  }
  assert {
    condition = contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
      backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
    })).paths), "/api/live/session")
    error_message = "Gateway must publish the authenticated bootstrap endpoint, never the WebSocket route."
  }
  assert {
    condition = alltrue([
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/cases/{caseId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/dispatcher/cases"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/intake-finalization"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/profile"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/doctor/cases"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/clinical"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/clinical/approvals/{approvalId}"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/simulation/advance"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/simulation"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/caretwin"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/caretwin/generate"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/caretwin/decision"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/predictive"),
      contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = true
      })).paths), "/api/predictive/generate"),
      !contains(keys(yamldecode(templatefile("${path.module}/openapi.yaml.tftpl", {
        backend_url = "https://backend.example", enable_auth_routes = true, enable_hosted_live = true, enable_m15 = true, enable_m16 = true, enable_m17 = false
      })).paths), "/api/clinical/executions/{executionId}/confirm")
    ])
    error_message = "Hosted routes must include the role-protected Doctor reasoning surface without publishing execution confirmation routes."
  }
  assert {
    condition = alltrue([for service in [google_cloud_run_v2_service.api[0], google_cloud_run_v2_service.live[0]] :
      anytrue([for env in service.template[0].containers[0].env : env.name == "M17_ENABLED" && env.value == "true"])
    ])
    error_message = "M17 must be enabled in both API and Live runtime revisions when selected."
  }
}
