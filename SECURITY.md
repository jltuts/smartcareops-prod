# Security scope

This repository is a public code showcase. Do not add patient records, real transcripts, laboratory reports, private screenshots, credentials, Terraform state/plans, or deployment secrets.

Do not post suspected credentials or personal data in a public issue. Use GitHub private vulnerability reporting if it is enabled; otherwise contact the maintainer privately before sending details. The repository owner must verify this reporting channel before publication.

## Repository controls to verify before publication

- Enable secret scanning, push protection, dependency alerts, and private vulnerability reporting.
- Protect the default branch and require the verification workflow to pass.
- Keep workflow permissions read-only and grant no cloud deployment credentials.
- Review account MFA, collaborators, installed apps, deploy keys, webhooks, and Actions secrets.
- Review all existing branches, tags, pull requests, and historical commits for old material before changing visibility.

The current review removes clutter from the proposed tree; it does not rewrite existing history or delete remote branches. Historical files remain accessible if that history is published.

Application source is preserved for review, including its prototype limitations. Repository cleanup is not a penetration test or certification of the deployed application. Existing project identifiers and URLs are not access credentials; cloud authorization remains a separate responsibility.
