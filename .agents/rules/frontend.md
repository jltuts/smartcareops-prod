# Frontend Rules

## Design & Usability
- **Simplicity & Readability**: Keep UI simple, legible, and focused on clinical and operational clarity.
- **Visual Language**: Preserve current SmartCareOps visual language, layout structure, and design conventions.
- **Motion Restraint**: Avoid unnecessary animations that degrade performance or distract from critical workflows.

## Role & Data Boundaries
- **Visually Distinct Roles**: Keep Patient, Doctor, Dispatcher, and Command Center roles visually distinct.
- **Backend Data Boundaries**: Do not expose backend-only data or internal debugging information to end-user views.
- **Logic Separation**: Do not duplicate logic already handled by the backend.

## Accessibility & Status
- Use accessible labels and structured status messaging for all states, live sessions, and async interactions.
