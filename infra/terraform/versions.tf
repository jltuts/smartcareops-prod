terraform {
  required_version = ">= 1.16.4, < 2.0.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.4.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "8.4.0"
    }
  }
  # Deliberate local state. No remote bucket is created by this foundation.
  backend "local" {
  }
}
