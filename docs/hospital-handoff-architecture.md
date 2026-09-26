# Hospital handoff responsibility boundary

This correction supersedes the interrupted automatic-handoff implementation and the historical patient-triggered M3 walkthrough. It does not start M13.

Hospital handoff is a business capability. Connector selection is an implementation detail.

- Patient Portal = intake + status only.
- Doctor Portal = review + approval + external clinical actions.
- REST API = primary integration path.
- Gemini Computer Use = legacy-system fallback, explicitly selected in backend configuration.

## Patient completion

Live finalization preserves the validated reported facts, persists the case and evaluates deterministic safety. A normal case reaches `submitted_for_clinical_review`; emergency cases retain their separate dispatcher workflow. The patient sees Information saved, Case created, Submitted for clinical review and Waiting for clinical review.

Completion creates no execution request, handoff job, Computer Use job, REST submission job, or external-action approval request. It emits no clinical execution event. The existing case store does not share an atomic event transaction with the clinical workspace, so this change uses durable case state and the doctor queue rather than adding an intake-side event publisher. Refresh/polling only reads saved status. The fictional-data checkbox is a data-scope prerequisite, never permission to orchestrate a hospital action.

The production API no longer attaches `/api/agent/handoff` or an automatic handoff/confirmation endpoint. Patient routing, handoff, approval and internal orchestration controls are removed. The shared internal notification/action panel is not mounted in the Patient Portal. Historical handoff status and verified receipt references remain readable.

## Clinical proposal and approval

With the existing DEV clinical feature enabled (`M8_ENABLED=true`), open a saved normal case in the Doctor Portal and request an assessment. No additional observation is required for a newly submitted intake. The Clinical Agent investigates the persisted case, reasons within its existing structured assessment contract, creates an immutable plan and may propose `submit_hospital_case({hospitalId})`.

Backend policy classifies this tool as HIGH_IMPACT regardless of the model's proposed risk. The backend binds case ID, immutable reported payload digest, hospital, connector and configuration version. Doctor approval is tied to the plan revision, arguments/binding digest, evidence/resource/fleet versions and expiry. Execution rechecks those gates. Rejected, unapproved, expired or stale proposals cannot submit.

The execution service durably claims the action before calling the Hospital Handoff Service:

```text
Clinical investigation → structured plan → proposed hospital action
Doctor review → approve/reject
Approved execution → submitCase({caseId, hospitalId, payload, idempotencyKey})
                 → REST connector (default)
                 → Computer Use (explicit legacy configuration only)
```

The queue includes submitted-for-review and valid historically routed cases, excluding emergencies. A selected case scopes `/api/clinical?caseId=...`; historical fixed M8/M12 workspaces remain supported. The local process holds at most 16 selected clinical services. Existing run/model budgets remain unchanged.

## Connectors and recovery

`backend/src/hospital` owns the typed contract, receipt verification, service and adapters. The REST adapter makes authenticated HTTP requests to the allowlisted local `/internal/hospital-demo/cases` endpoint. This is a real HTTP transport to a fictional provider simulator, not a production hospital integration. No hospital credentials or production endpoints were introduced. The simulator stores an idempotent receipt durably in the case store; lookup is GET-only.

`HOSPITAL_HANDOFF_CONNECTOR=rest` is the default for configured `HOSP-001`. Explicit `computer_use` selects the preserved M3 engine. There is no fallback triggered by REST failure. The backend never accepts a model/client-supplied URL or connector choice.

The legacy adapter preserves M3's isolated browser, exact destination allowlist, network restrictions, visual validation, GenerateContent continuation, deterministic safe field helper and verified receipt. Any additional Gemini safety confirmation appears only in the doctor workspace and is checked against the current approval. It is not automatically accepted. A restart loses an outstanding browser confirmation and cannot resume it by blindly replaying browser actions.

Case-level transactional claims and stable idempotency keys prevent duplicate submissions across workers/replans. Connector I/O runs outside Firestore retry transactions. Running clinical actions have a three-minute recovery window, allowing the existing bounded browser run to finish without a concurrent refresh/worker cancelling its confirmation. Failed/lost responses become `unknown_outcome` / `UNKNOWN_OUTCOME`, retaining original facts and journal entries. Recovery only looks up receipts, including after approval expiry/supersession. A clinical claim without a connector claim cannot initiate a submission during recovery. Legacy unknown outcomes without a durable verified receipt remain unresolved for manual investigation; the browser is never reopened as a retry.

## Validation and limits

Backend tests cover completion with neither connector invoked, review queue state, proposal, approval/rejection, stale evidence/expiry/configuration, concurrency/restart/replan deduplication, emergency blocking, REST receipt lookup after a lost response, explicit legacy execution and doctor-only safety confirmation. Browser regressions cover real Live/finalization transport using fictional injected model responses, saved/refresh status with zero execution, doctor proposal/approval, both connector selections and receipt display. Existing M3 engine regressions remain in the full suites.

This remains an unauthenticated local DEV demo. Origin checks and the `demo_doctor` label are not production authentication or RBAC. Real deployment requires identity/role enforcement, a real hospital contract/adapter and a durable worker discovery strategy. Per-case clinical workspaces are persisted with Firestore, but after server restart a non-default workspace is resumed when selected again; no intake-triggered execution worker was added. Memory mode is intentionally non-durable. No new real Gemini/remote Firestore acceptance or real hospital submission was performed for this correction.

Final verification: focused backend 57 passed; full backend 541 passed; focused browser 20 passed; full Playwright 180 passed on desktop/mobile with installed Edge; production build passed. Root and backend npm audits each reported zero vulnerabilities. The existing secret scan reported zero findings across 61 tracked files, 96 reachable historical blobs and new source files. `git diff --check` passed. No live provider/remote Firestore acceptance or production hospital submission is included in these results. See `HANDOFF.md` for the file inventory and preserved historical evidence.
