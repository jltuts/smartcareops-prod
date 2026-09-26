# Security Rules

## Secret & Credential Protection
- **No API Keys in Frontend**: Client code must never contain Gemini API keys, service credentials, or private secrets.
- **No Secrets in VITE Variables**: Never expose private tokens or credentials through `VITE_*` environment variables. Client bundles only receive public endpoints and public identifiers.
- **No Service Account Keys**: Never commit `service-account*.json`, `firebase-admin*.json`, or any GCP credential files to the repository.
- **Ignore Local Environment Files**: Ensure all `.env` and `.env.*` files remain gitignored, preserving only `.env.example`.
- **Infrastructure State**: Never commit Terraform state files (`*.tfstate`, `*.tfstate.*`), execution plans (`*.tfplan`, `*.plan.json`), variable files (`*.tfvars`, `*.tfvars.json`), or cloud credentials.
- **Pre-Release Scans**: Scan for secrets before release.

## Access & Authorization Control
- **Backend Authorization**: Preserve server-side identity verification and role authorization on all protected endpoints.
- **Role Boundaries**: Preserve strict role boundaries between patient, doctor, dispatcher, and command-center contexts.
- **Human Approval Gates**: Preserve human approval gates for consequential actions; never automate or bypass approval boundaries.

## Code Safety
- **Safe DOM Manipulation**: Review uses of `innerHTML`, `eval()`, `new Function()`, and unsafe URLs to prevent injection vulnerabilities.
- **Sanitized Outputs**: Sanitize and validate all model-generated and user-supplied data before rendering or persisting.
