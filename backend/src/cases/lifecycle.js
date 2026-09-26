import { randomUUID } from 'node:crypto';
import { Handoff } from './store.js';
import { diagnosticsFor } from '../agent/diagnostics.js';

// Persistence orchestration surrounds M3; it never selects or executes actions.
export function withCasePersistence(run, store) {
  return async options => {
    const id = options.patientCaseId, attemptId = options.claimedAttemptId || randomUUID();
    const notify = patientCase => options.emit({ status: 'case_status', patientCase });
    if (!options.claimedAttemptId) notify(await store.updateCaseStatus(id, Handoff.PENDING, attemptId));
    let verified, completionEvent;
    try {
      notify(await store.updateCaseStatus(id, Handoff.ACTIVE, attemptId));
      const result = await run({ ...options, emit: event => {
        if (event.status === 'completed') completionEvent = event;
        else options.emit(event);
      } });
      if (!result?.caseId || completionEvent?.caseId !== result.caseId) throw new Error('Verified handoff result missing.');
      verified = result;
      notify(await store.updateHandoffResult(id, { attemptId, receipt: result }));
      options.emit(completionEvent);
      return result;
    } catch (error) {
      // If a verified portal submission could not be saved, leave the attempt
      // in progress. Do not invite a duplicate submission or record a false failure.
      if (!verified) {
        try { notify(await store.updateHandoffResult(id, { attemptId, diagnostics: diagnosticsFor(error) || { code: options.signal?.aborted ? 'CANCELLED' : 'UNKNOWN_AGENT_ERROR' } })); }
        catch { /* Storage failure must not expose SDK details or mask M3 error. */ }
      }
      throw error;
    }
  };
}
