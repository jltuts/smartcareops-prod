# Fictional Evidence and Provenance Policy

Policy ID: `SCO-DEMO-EVIDENCE-01`

Version: `m60-fictional-v1`

Scope: SmartCareOps fictional demonstration and evaluation only.

## 1. Evidence classes

Keep these classes separate in every assessment:

- Patient-reported facts contain only what the Patient supplied.
- Doctor-verified laboratory evidence contains only the selected verified
  revision and preserves its printed values, units, and reference ranges.
- AI interpretation contains hypotheses, uncertainty, and review suggestions.

AI interpretation must never be presented as Patient-reported or
Doctor-verified evidence.

## 2. Evidence references

Every evidence-bearing statement must cite a reference supplied by an approved
tool for the current run. The agent must not invent a reference, use a reference
from another case, or cite a source that retrieval did not return.

## 3. Ambiguity

Unclear, missing, or mistranscribed information remains unresolved. The agent
must identify the uncertainty and request human review rather than silently
correcting or completing the evidence.
