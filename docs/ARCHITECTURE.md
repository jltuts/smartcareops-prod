# Architecture and boundaries

```mermaid
flowchart TD
  P[Patient portal: voice and text] --> API[Node API: identity, validation, safety]
  D[Doctor portal] --> API
  O[Dispatcher and command center] --> API
  P <--> LIVE[Gemini Live session]
  API --> CASES[Case and evidence stores]
  CASES --> FS[Firestore and Cloud Storage adapters]
  API --> CLINICAL[Clinical assessment and policy evidence]
  CLINICAL --> APPROVAL[Human approval and execution guards]
  APPROVAL --> REST[Fictional hospital REST connector]
  APPROVAL --> LEGACY[Explicit legacy Computer Use connector]
  API --> EVENTS[Pub/Sub and event processing]
  EVENTS --> OPS[Operational projections and notifications]
  API --> SIM[Fictional fleet and planning simulations]
```

The diagram summarizes logical responsibilities; not every arrow is a synchronous HTTP call. Optional cloud components and clinical features are configuration-dependent.

The frontend, API, and clinical runtime are separate source areas. The API is the enforcement boundary for identity, permissions, validated case transitions, approval binding, and connector execution. Browser UI visibility alone is not an authorization mechanism.

Infrastructure definitions describe the cloud architecture and include API contracts exercised by regression tests. Environment-specific state, saved plans, credentials, and import configuration are excluded.

Some application constants and bundled policy records contain existing public project/resource identifiers. Identifiers are not credentials. They identify the implementation environment and preserve policy provenance. Access to those resources requires separate cloud authorization.

The policy corpus is fictional. Its completion receipt is retained because the runtime bundle test checks exact agreement with that receipt. It is not patient data or an access token.

A [supporting architecture illustration](demo/latest/smartcareops-production-architecture.png) is included. The source and explanation above are the authority for configuration and prototype limitations; an illustration is not proof of deployed service state.
