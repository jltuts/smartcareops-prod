# Security

Do not commit patient records, real transcripts, laboratory reports, private screenshots, credentials, Terraform state/plans, or deployment secrets.

## Reporting a vulnerability

Do not include credentials or personal data in a public issue. Use GitHub private vulnerability reporting when available; otherwise contact the maintainer privately before sharing sensitive details.

## Repository safeguards

- Use secret scanning, push protection, and dependency alerts.
- Protect the default branch and require automated verification.
- Keep CI permissions read-only and exclude cloud deployment credentials.
- Review account MFA, collaborators, installed apps, deploy keys, webhooks, and Actions secrets.
- Review historical commits as well as current files for sensitive material.

## Application scope

SmartCareOps is a prototype. Automated tests and dependency scans are not a penetration test or certification of the deployed application. Project identifiers and URLs are not access credentials; cloud authorization must be configured separately. See [validation results](docs/VALIDATION.md) for the checks performed.
