# Bounded intake recovery and handoff improvements

Scope: preserve M0–M12; no new milestone, model changes, safety-rule changes, or deployment.

## Clarification recovery

The Live instruction treats confusion as an unanswered question, rephrases the same question, and waits. A short Spanish clarification does not itself switch languages. The session pins the original question across repeated or fragmented clarification requests and even intervening model drift. It blocks finalization while that question remains unresolved. A subsequent usable answer or explicit inability releases the question under the existing extraction rules.

The narrow whole-utterance detector covers common English/Spanish clarification requests, including polite variants. It deliberately leaves mixed clinical answers to normal extraction and safety processing. The extractor also filters recognized confusion; the evidence validator independently rejects any update citing it. Raw transcript events still reach the existing audit/display path. Semantic equivalents outside this narrow detector rely on the Live and extraction instructions; arbitrary natural-language behavior is not guaranteed by a phrase list.

Regression cases cover What?, ¿Qué? ¿Qué es eso?, I don't understand, repeated/fragmented requests, pressure after clarification, explicit inability, and forged symptom/denial/note evidence.

## Handoff and progress

Gemini receives a validated PNG of the isolated fictional portal and explicitly calls populate_validated_intake after recognizing the expected form. The helper accepts no model-provided patient data, selectors, or URL. It checks the exact form contract, empty editable fields, and absence of a receipt; fills eleven fixed fields from the completed server-validated intake; reads every value back; and returns a screenshot. The helper allows only one population attempt, including partial failures.

The loop forbids population plus submission in one model response, repeated population, and bypassing requested confirmation. Gemini reviews the resulting screenshot and controls the browser submit action. Success requires both the visible receipt and exact rendered-field verification, plus Gemini reporting the matching receipt ID. The GenerateContent correlation, signatures, PNG validation, isolated browser/network allowlist, action checks, and safety confirmation path remain in place. There is no direct API submission.

The UI shows opening, validating, populating, reviewing, submitting, verifying, and completed stages without model reasoning. Metrics record model requests, browser actions, population calls, verified fields, model time, browser-action time, screenshot time, and total duration. Browser-action counts exclude the separately counted helper call; eleven DOM fills are not represented as one primitive browser operation.

## Files in this bounded implementation

- backend/src/live.js
- backend/src/intake/{confusion,session,extractor,validate}.js
- backend/src/agent/{browser,cases,loop,gemini-computer-use,diagnostics}.js
- src/pages/patient/{handoff.js,patient.css}
- backend/tests/{confusion-recovery,agent-population}.test.js
- tests/e2e/{agent,agent-population}.spec.js
- backend/scripts/{verify-intake-recovery-handoff.js,create-fictional-audio.ps1}
- .gitignore (local fictional audit/audio and verification outputs)

These include implementation already present when this review started; unrelated pre-existing milestone changes remain intact.

## Verification

Full backend: 525 passed. Full Playwright: 178 passed across desktop/mobile. Production build passed. Root and backend npm audits: zero vulnerabilities. Pattern-based tracked/new-source/history secret scan: zero findings. Whitespace check passed.

The opt-in DEV verifier uses Windows-generated fictional PCM audio, real Gemini Live and extraction, canonical automatic voice shutdown, the real handoff relay, and real Computer Use. It does not use the microphone. The same validated intake is used for the optional unassisted baseline. The verifier's shutdown-event and finalization snapshot-field assumptions were corrected to match the existing application contracts. Detailed measured results are recorded separately in intake-recovery-handoff-verification.json when the full scenario passes.

## Measured real DEV result

PASS: fictional synthesized patient audio → real Gemini Live pain-quality question → confusion → one-question rephrase → pressure answer → finalized intake → canonical automatic voice shutdown → real Computer Use helper population → model-controlled submit → verified receipt DEMO-DA1099BB. DEV case: SC-8bea172e-528a-4594-aecc-4e530164bbfc.

| Measurement | Unassisted baseline | Assisted population |
| --- | ---: | ---: |
| Model requests | 11 | 3 |
| Browser actions | 10 | 1 |
| Helper calls | 0 | 1 |
| Fields read back by helper | 0 | 11 |
| Model request time | 49.604 s | 13.958 s |
| Browser action/helper time | 0.088 s | 0.216 s |
| Screenshot time | 0.697 s | 0.355 s |
| Total handoff duration | 50.967 s | 15.399 s |
| Matching receipt verified | Yes | Yes |

This is one sequential comparison using the same validated intake, not a statistical benchmark or a timing estimate for the earlier reported 16-step run. The baseline was run after the optimized path. Total time includes browser setup and loop overhead but ends before browser cleanup. Model round trips dominated both measurements. Elapsed time decreased approximately 70%; model requests decreased approximately 73%. Visual Computer Use and receipt validation were preserved. No model requested confirmation in this run; confirmation denial/bypass regressions remain covered.

Final focused Playwright after the progress assertions: 16 passed. The successful scenario uses synthetic local speech, not a human microphone recording. Earlier verification attempts exposed stale verifier assumptions and one rejected extraction response; validation was retained unchanged and those attempts were not counted as successful acceptance.

Machine-readable evidence: [intake-recovery-handoff-verification.json](intake-recovery-handoff-verification.json).
