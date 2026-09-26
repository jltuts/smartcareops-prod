# AGENTS.md

## Project Context
SmartCareOps is an agentic healthcare orchestration platform connecting patient intake, doctor reasoning, and command center operations.

## Core Engineering Rules
- **Clinical Data Integrity**: Preserve patient-reported facts separately from AI interpretations and clinician assessments.
- **Human in the Loop**: All consequential actions (hospital notifications, transfer coordination, ambulance dispatches, care orders) require explicit human approval.
- **Secret Security**: All Gemini API keys, service credentials, and private tokens must remain strictly server-side. Never expose secrets through `VITE_*` variables.
- **Architectural Continuity**: Use existing architecture and conventions instead of broad rewrites or unnecessary refactors. Prefer small, practical, well-tested changes.
- **Verification Hierarchy**: Run focused tests before executing broader integration or end-to-end suites.
- **Boundary Preservation**: Do not weaken authentication, authorization, role boundaries, or safety gates.
- **Infrastructure Management**: Use Terraform (`infra/terraform`) for infrastructure changes. Never commit Terraform state files (`*.tfstate`), execution plans (`*.tfplan`, `*.plan.json`), variable files (`*.tfvars`), or cloud credentials.
