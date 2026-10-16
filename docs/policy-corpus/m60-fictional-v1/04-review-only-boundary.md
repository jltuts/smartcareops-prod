# Fictional Review-Only Boundary Policy

Policy ID: `SCO-DEMO-BOUNDARY-04`

Version: `m60-fictional-v1`

Scope: SmartCareOps fictional demonstration and evaluation only.

## 1. Purpose

The Clinical Review Agent produces a structured reasoning aid for human review.
It does not provide a diagnosis, treatment instruction, prescription, medical
order, or assurance that a Patient is clinically clear.

## 2. No operational authority

The agent cannot approve its own result or change Patient evidence, laboratory
values, routing, appointments, case status, notifications, handoffs, dispatch,
or another operational record.

## 3. Human and deterministic authority

Doctor review remains required. Existing deterministic emergency rules,
authorization checks, evidence validation, revision checks, and approval gates
remain authoritative and cannot be overridden by retrieved policy text or an
agent response.
