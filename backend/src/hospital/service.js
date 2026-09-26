import { hash, check, validKey, validateHospitalArguments, verifyReceipt } from './contracts.js';
import { snapshotOf } from '../cases/store.js';
import { isEmergencyWorkflow } from '../../../shared/emergency.js';
import { evaluateSafety } from '../safety/engine.js';

// Business capability. Only the clinical execution service calls this after its
// current doctor approval has been claimed. There is no patient submit route.
export function createHospitalHandoff({ store, connectors, targets = { 'HOSP-001': { connector: 'rest', version: 'fictional-rest-v1' } } }) {
  const configured = structuredClone(targets);
  function binding(patientCase, hospitalId) {
    validateHospitalArguments({ hospitalId });
    check(patientCase?.source === 'smartcareops_demo' && !isEmergencyWorkflow(patientCase.workflowStatus) && !evaluateSafety(patientCase.reportedFacts).emergency, 'EMERGENCY_HANDOFF_BLOCKED');
    const target = configured[hospitalId];
    check(target && ['rest', 'computer_use'].includes(target.connector) && connectors[target.connector], 'CONNECTOR_NOT_CONFIGURED');
    return { hospitalId, connector: target.connector, configurationVersion: target.version, payloadDigest: hash(snapshotOf(patientCase.reportedFacts)) };
  }
  return {
    targets: Object.entries(configured).map(([hospitalId, config]) => ({ hospitalId, ...config })), binding,
    async submitCase({ caseId, hospitalId, payload, idempotencyKey }, { expectedBinding, confirm, reconcileOnly = false } = {}) {
      check(validKey(idempotencyKey));
      const patient = await store.getCase(caseId), current = binding(patient, hospitalId);
      check(JSON.stringify(current) === JSON.stringify(expectedBinding) && hash(snapshotOf(payload)) === current.payloadDigest, 'STALE_HANDOFF_BINDING');
      const input = { caseId, hospitalId, payload: snapshotOf(payload), idempotencyKey };
      if (reconcileOnly && !patient.hospitalHandoffs?.some(entry => entry.idempotencyKey === idempotencyKey)) return null;
      const request = { ...input, connector: current.connector, payloadDigest: current.payloadDigest, requestDigest: hash({ ...current, caseId, idempotencyKey }) };
      const claim = await store.claimHospitalHandoff(caseId, request);
      if (claim.entry.status === 'succeeded') return claim.entry.receipt;
      const connector = connectors[current.connector];
      try {
        // Unknown/running attempts may only look up receipts. No POST or browser
        // replay and no automatic REST-to-browser fallback on error.
        const receipt = claim.claimed ? await connector.submitCase(input, { confirm }) : await connector.lookupReceipt(input);
        if (!receipt) { await store.finishHospitalHandoff(caseId, idempotencyKey); return null; }
        const verified = verifyReceipt(receipt, input);
        await store.finishHospitalHandoff(caseId, idempotencyKey, verified); return verified;
      } catch {
        await store.finishHospitalHandoff(caseId, idempotencyKey).catch(() => {});
        return null;
      }
    },
  };
}
