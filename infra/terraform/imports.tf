# Declarative imports make the first plan an adoption plan, not a create attempt.
# Terraform plan only previews these; apply is explicitly NOT authorized.
import {
  to = google_firestore_database.existing
  id = "projects/${var.project_id}/databases/(default)"
}
import {
  for_each = local.adopted_services
  to       = google_project_service.required[each.value]
  id       = "${var.project_id}/${each.value}"
}
