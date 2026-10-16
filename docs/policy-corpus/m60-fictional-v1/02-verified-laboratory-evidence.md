# Fictional Verified Laboratory Evidence Policy

Policy ID: `SCO-DEMO-LAB-02`

Version: `m60-fictional-v1`

Scope: SmartCareOps fictional demonstration and evaluation only.

## 1. Verification boundary

Only a laboratory revision explicitly corrected and confirmed by a Doctor may
be supplied to the Clinical Review Agent. An extracted, draft, superseded, or
unverified revision is not an approved clinical input.

## 2. Immutable binding

Bind every review to the report identifier, verified revision, and evidence
digest. Recheck that binding after model processing. If the revision or digest
changes, reject the result as stale.

## 3. Fidelity

Preserve the verified printed result, unit, reference range, and source
location exactly. Do not convert units, fill missing values, infer an absent
measurement, or claim that a value establishes a diagnosis.
