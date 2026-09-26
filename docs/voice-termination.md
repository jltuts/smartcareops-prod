# Permanent voice termination — September 17, 2026

## Authority and states

`backend/src/voice-state.js` accumulates Gemini `outputTranscription.text` and evaluates it only on `turnComplete`. The canonical sentence `Your intake is complete.` changes voice from ACTIVE to ENDING once. Partial transcript, `generationComplete` alone, patient ASR, patient finish grammar, and noncanonical closing variants do not trigger shutdown. Interrupted unfinished output is discarded.

`backend/src/live.js` owns the terminal guard. Once ENDING, it rejects new microphone audio, ignores patient/model turns and interruption requests, and cannot reopen. The finalized turn's audio is relayed before `completion-pending`. The frontend stops forwarding capture immediately, lets already queued playback drain, stops microphone tracks, acknowledges playback, and closes audio/WebSocket through its shared cleanup. The backend acknowledgment calls its idempotent cleanup, closes Gemini, and marks voice CLOSED.

The existing patient recognizer remains a workflow helper (including identifying extraction no-ops). Its approval, pending hint, revision, and phrase grammar no longer control voice shutdown or token issuance.

Independently, intake moves COLLECTING → FINALIZING → COMPLETED or FINALIZATION_FAILED. A finalization failure never asks Gemini to clarify or restarts the microphone. Success displays Completed and enables the existing fictional M3 handoff; failure displays `Intake ended — summary needs review`, the preserved valid snapshot, and safe developer diagnostics. Handoff stays disabled.

## Result transport

Keeping the voice WebSocket open for a slow extraction would couple shutdown back to finalization. Instead, the backend starts a single finalization job and gives the client a random result ticket in `completion-pending`. After playback and voice closure, the frontend polls GET `/api/intake-finalization` with that ticket in the Authorization header. The endpoint returns 202 while pending, then the immutable `intake-complete` result or finalization error and last valid snapshot. A result can resolve only once; fetching it again does not issue another token or rerun finalization.

Results are memory-only, limited to 64 records, and expire after five minutes. Responses use `Cache-Control: no-store`; missing/invalid tickets return 404. Tickets, completion tokens, credentials, and patient speech are absent from the new diagnostics. A new explicitly started conversation or navigation invalidates an older pending UI result. Retrieval failure shows review status without reopening voice. This adds no persistence or later-milestone integration.

The existing emergency event and spoken closing remain separate for an active emergency intake. If final extraction first validates an existing confirmed-red-flag rule after routine voice closure, the result retains emergency status and disables normal handoff, without restarting voice. No numeric thresholds or new clinical rules were added.

## Observability

```text
[voice-session] { event: 'gemini_intake_complete', voiceState: 'ENDING' }
[voice-session] { event: 'closed', reason: 'gemini_intake_complete' }
[intake-finalization] { status: 'COMPLETED' }
```

Finalization may finish before or after voice closes. Failure logs independently as `{ status: 'FAILED', code: '...' }`. A late existing red-flag result logs EMERGENCY_ESCALATED. Existing patient-intent diagnostics remain available but are not terminal authority.

## Verification

- Backend: 261 passing tests, covering partial/finalized output, unrecognized patient grammar, single commitment, ignored post-completion audio/transcripts, delayed failure, unresolved clarification, ticket access, and immutable results.
- Playwright: 88 passing desktop/mobile tests. Tests hold extraction unresolved until after final audio, microphone, Gemini, and voice WebSocket close, then release success, invalid schema, unresolved clarification, or an existing red flag. They verify preserved facts, visible diagnostics, normal/emergency handoff gates, and no goodbye loop. Existing exact `No and nothing else` and `No nada de amor` flows pass.
- Production build passes.
- The standard `npm run test:e2e` setup could not bind localhost:8080 (`EACCES`). The complete suite ran using installed Edge and a temporary Vite-only setup. Generic server tests reused the already running backend; termination tests used the current relay and their own ephemeral backend, with only Gemini mocked. The temporary harness was removed.
- No real Gemini replay or model change was made. Extraction and per-fact validation were unchanged by this refactor. M3 Computer Use was unchanged.

Restart the backend and frontend development servers when applying this change: the new result endpoint and Vite proxy must both be loaded.

## Files

Runtime: `backend/src/voice-state.js`, `backend/src/finalization-results.js`, `backend/src/live.js`, `backend/src/server.js`, `src/pages/patient/conversation.js`, `vite.config.js`. `backend/src/completion.js` only gains a comment identifying its remaining workflow-helper role.

Tests: `backend/tests/voice-state.test.js`, `backend/tests/finalization-results.test.js`, `backend/tests/finalization-client.js`, `backend/tests/live.test.js`, `backend/tests/agent.test.js`, `tests/e2e/voice-terminal.spec.js`, `tests/e2e/final-confirmation.spec.js`, `tests/e2e/patient-live.spec.js`.

The agent test changed only its receipt of completed intake results; agent implementation and Computer Use behavior were not changed. Existing unrelated workspace edits were preserved.
