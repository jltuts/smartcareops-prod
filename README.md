# SmartCareOps

SmartCareOps — AI that doesn’t just assess. It coordinates care.

SmartCareOps is an AI-powered healthcare coordination platform. It connects patient intake, clinical review, hospital capability and capacity, ambulance dispatch, and command center monitoring into a unified operational workflow.

## Core Idea

Most healthcare AI stops after giving an answer, while SmartCareOps helps coordinate what happens next.

It connects:
patient intake → clinical review → hospital capability/capacity → ambulance coordination → command center monitoring → predictive planning

Patient Intake understands the present.
Doctor Portal reasons about the individual.
Command Center reasons about the future of the healthcare system.

Journey:
first contact → understand → reason → triage → route → coordinate → respond → monitor → learn

## Three Intelligence Layers

### Patient Intake
- Gemini Live voice intake
- Captures patient-reported symptoms, vitals, and context

### Doctor Portal
- AI-assisted case analysis
- Risks
- Missing information
- Recommendations
- Why / Why Not
- Human approval

### Command Center
- Hospital/network monitoring
- Ambulance state
- Simulation
- CareTwin Plan A/B/C comparison
- Predictive intelligence

## Main Features

- Gemini Live patient intake
- Structured patient case records
- Doctor reasoning workspace
- Hospital capability/capacity monitoring
- Ambulance simulation
- Healthcare network simulation
- CareTwin counterfactual planning
- Predictive Command Center
- Human approval for important actions

## Technology

### AI
- Gemini API
- Gemini Live
- Structured output
- Function calling

### Google Cloud
- Firebase Hosting
- Firebase Authentication
- Firestore
- Cloud Run
- API Gateway
- Secret Manager
- Cloud Logging
- Cloud Monitoring

### Frontend
- Vite
- Vanilla JavaScript
- HTML
- CSS
- Three.js

### Testing
- Playwright
- Node.js tests
- GitHub Actions

## Safety

SmartCareOps separates:
- Patient-reported facts
- AI interpretation
- Doctor assessment

Important actions require human approval.

API keys remain server-side.

## Local Development

```bash
npm install
npm --prefix backend install
```

Frontend:
```bash
npm run dev
```

Backend:
```bash
npm --prefix backend start
```

## Routes

- /patient
- /doctor
- /dispatcher
- /command-center
- /profile

## Competition

Built for Google AI Builder Cup 2026.

Team: Constellation Builders