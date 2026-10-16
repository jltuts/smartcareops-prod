# Code walkthrough

## 1. Enter the application

Start with [`src/app/main.js`](../src/app/main.js) and [`src/app/router.js`](../src/app/router.js). Authentication lives in [`src/auth`](../src/auth), while backend identity and authorization start in [`backend/src/auth.js`](../backend/src/auth.js) and [`backend/src/user-profiles.js`](../backend/src/user-profiles.js).

## 2. Capture the patient's account

[`src/pages/patient`](../src/pages/patient) contains voice/audio handling, text intake, case history, and the intake UI. [`backend/src/live.js`](../backend/src/live.js), [`backend/src/live-session.js`](../backend/src/live-session.js), and [`backend/src/intake`](../backend/src/intake) handle Live sessions, extraction, validation, and finalization. [`shared`](../shared) holds shared contracts and helpers.

Reported information is preserved separately from model interpretation. Follow the finalization tests to see how ambiguous or incomplete information is handled.

## 3. Persist and review

[`backend/src/cases`](../backend/src/cases) contains persistence and evidence handling. [`src/pages/doctor`](../src/pages/doctor) presents the clinician workspace. [`backend/src/clinical`](../backend/src/clinical) implements assessment, plans, evidence, and approval checks. The separate [`agent-runtime/clinical-shadow`](../agent-runtime/clinical-shadow) implements the clinical runtime and policy bundle.

## 4. Approve and coordinate

[`backend/src/hospital`](../backend/src/hospital) owns hospital connectors and receipt handling. [`backend/src/agent`](../backend/src/agent) contains the preserved Computer Use implementation. Intake completion itself does not authorize hospital execution.

[`backend/src/emergency.js`](../backend/src/emergency.js), [`backend/src/safety`](../backend/src/safety), and [`backend/src/ambulance`](../backend/src/ambulance) cover the emergency and fictional fleet paths. [`src/pages/dispatcher`](../src/pages/dispatcher) contains the dispatcher interface.

## 5. Inspect the wider system

[`src/pages/command-center`](../src/pages/command-center), [`backend/src/operations`](../backend/src/operations), [`backend/src/regional`](../backend/src/regional), and [`backend/src/simulation`](../backend/src/simulation) cover operational aggregation and simulations. Infrastructure contracts are in [`infra/terraform`](../infra/terraform).

## 6. Verify the claims

[`backend/tests`](../backend/tests) exercises validation, authorization, approval, persistence, and recovery. [`tests/e2e`](../tests/e2e) exercises browser flows with controlled data. [`agent-runtime/clinical-shadow/tests`](../agent-runtime/clinical-shadow/tests) checks runtime and policy behavior. Test fixtures are intentional source evidence, not generated test reports.
