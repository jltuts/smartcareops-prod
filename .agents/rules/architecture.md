# Architecture Rules

## Stack Overview
- **Frontend**: Vite + Vanilla JavaScript (modular ES modules, HTML, CSS, Three.js).
- **Backend**: Node.js (REST endpoints and WebSocket services for live bidirectional communication).
- **AI**: Gemini API and Gemini Live (structured outputs, function calling, live voice interaction).
- **Google Cloud**: Firebase Hosting and Authentication, Cloud Firestore, Cloud Run, API Gateway, Secret Manager, Cloud Logging, and Cloud Monitoring.

## Three Intelligence Layers
1. **Patient Intake**: Present-state understanding. Captures patient-reported symptoms, vitals, and immediate context via Gemini Live voice interaction.
2. **Doctor Portal**: Individual reasoning. Provides AI-assisted case analysis, clinical risk assessment, missing information identification, differential rationale (Why / Why Not), and clinician approval workflows.
3. **Command Center**: System and future reasoning. Delivers real-time network and hospital capacity monitoring, ambulance fleet state, simulation, CareTwin Plan A/B/C counterfactual comparison, and predictive intelligence.

## Operational Constraints
- **Deterministic Simulation**: Keep all operational simulations, routing calculations, and capacity models deterministic.
- **Grounded Interpretation**: Gemini interprets simulated outcomes and factual data; it does not invent metrics, diagnoses, or operational numbers.
- **Module Reuse**: Reuse existing services, stores, contracts, and shared domain modules. Avoid broad refactors or unnecessary rewrites.
