# SmartCareOps

**From first contact to the right care.**

SmartCareOps is a healthcare intake and coordination prototype built for Google Cloud AI Builder Cup 2026 by **Constellation Builders**. It combines patient voice or text intake, structured case records, clinician review, and simulated operational coordination.

This repository is the **source showcase for judges**. Development and deployments are maintained separately. This repository has no deployment workflow and does not provision or operate a cloud environment.

## Start here

1. Read the [code walkthrough](docs/CODE_WALKTHROUGH.md) to follow a case through the system.
2. Review the [architecture and boundaries](docs/ARCHITECTURE.md).
3. See [local verification](docs/LOCAL_VERIFICATION.md) for builds and automated tests.
4. Read the [security scope](SECURITY.md) and [third-party attribution](THIRD_PARTY_NOTICES.md).

## What the code implements

- **Patient portal:** Gemini Live voice intake and text intake, structured extraction of patient-reported information, case history, and status updates.
- **Doctor portal:** clinical assessment, laboratory evidence review, and explicit approval gates for proposed hospital actions.
- **Dispatcher portal:** emergency coordination and fictional ambulance workflows.
- **Command center:** operational views, regional aggregation, simulation, CareTwin scenario comparison, pattern detection, and predictive planning.
- **Backend:** authenticated API paths, role checks, durable case/evidence adapters, Pub/Sub processing, notifications, and guarded clinical orchestration.
- **Agent runtime:** a separate clinical runtime with policy evidence and local evaluation tests.

Feature availability depends on configuration, roles, and enabled flags. Included code is not a claim that every integration is enabled in the demonstration.

## Care journey

```text
Patient voice or text intake
  -> structured patient-reported facts
  -> persisted case and deterministic safety checks
  -> clinician review and proposed action
  -> explicit approval and execution checks
  -> hospital connector and verified receipt

Emergency cases follow a separate dispatcher coordination workflow.
```

The primary hospital connector is REST to a fictional provider simulator. Computer Use is an explicitly configured legacy connector; REST errors do not automatically switch to it.

## Technology

Vite and JavaScript power the frontend, with Firebase Authentication integration, GSAP, and Lenis. The Node.js backend integrates Gemini, Firestore, Cloud Storage, Pub/Sub, and Google ADK. Terraform source documents the Cloud Run, API Gateway, IAM, monitoring, and related infrastructure design. Node tests and Playwright cover the application behavior.

See [architecture](docs/ARCHITECTURE.md) for the distinction between application source, optional cloud adapters, and simulated services.

## Review and verification

Use **Node.js 24** and the committed lockfiles. No cloud credentials are required for source review, frontend compilation, or the documented isolated test suites.

```sh
npm ci
npm --prefix backend ci
npm --prefix agent-runtime/clinical-shadow ci
npm run build
npm --prefix backend test
npm --prefix agent-runtime/clinical-shadow test
node --test tests/maps-build-config.test.js
```

See [local verification](docs/LOCAL_VERIFICATION.md) before attempting interactive or live-provider use. Automated tests use fictional data and controlled adapters; they do not certify physical-phone audio or live clinical behavior.

## Scope and limitations

This is a competition prototype, not a clinical service. It does not replace a clinician or establish a medical diagnosis. Patient-reported facts, model interpretation, and clinician decisions are separate. Ambulance and hospital demonstration data are fictional; no real emergency dispatch is provided.

This review snapshot was prepared from development commit `80fbf05` plus the working-tree edits listed in [snapshot provenance](docs/SNAPSHOT.md). It is not a declaration of deployment or release acceptance.
