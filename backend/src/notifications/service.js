import { actionTools, validateMessage, check, NotificationError } from './contracts.js';
import { configuredClinicalStore } from '../clinical/storage.js';
import { configuredOperationsStore } from '../operations/storage.js';
import { configuredRegionalStore } from '../regional/storage.js';
import { evidenceFingerprint as hospitalFingerprint } from '../operations/snapshot.js';
import { evidenceFingerprint as regionalFingerprint } from '../regional/snapshot.js';
const values = Object.values;
function current(state, source, revisionId) {
  const plan = state.plans[revisionId];
  if (!plan || !state.meta?.ready || state.meta.currentRevisionId !== revisionId) return false;
  if (source.scope === 'clinical') return plan.inputVersion === state.meta.observationVersion && (plan.resourceEvidenceVersion || 0) === (state.resourceEnvironment?.version || 0) && (plan.fleetEvidenceVersion || null) === (state.fleetEvidenceVersion || null);
  return plan.evidenceFingerprint === (source.scope === 'hospital' ? hospitalFingerprint(state) : regionalFingerprint(state));
}
export function createNotificationCenter({ sources, closeStores = false }) {
  async function read() {
    const results = await Promise.allSettled(sources.map(async source => ({ source, state: await source.store.read(source.subjectId) })));
    return { records: results.filter(item => item.status === 'fulfilled').map(item => item.value), unavailableScopes: results.flatMap((item, index) => item.status === 'rejected' ? [sources[index].scope] : []) };
  }
  return {
    async view(recipientType = null) {
      check(recipientType === null || values(actionTools).some(item => item.recipientType === recipientType), 'INVALID_NOTIFICATION_RECIPIENT');
      const { records, unavailableScopes } = await read(); const notifications = [], receipts = [], followups = [];
      for (const { source, state } of records) {
        for (const notification of values(state.notifications || {})) {
          validateMessage(notification.toolName, notification);
          if (recipientType && notification.recipientType !== recipientType) continue;
          const approval = values(state.approvals).find(item => (item.revisionId || item.planRevisionId) === notification.sourceRevisionId && item.actionId === notification.sourceActionId);
          const valid = current(state, source, notification.sourceRevisionId);
          notifications.push({ ...notification, stale: !valid && notification.status !== 'sent', approvalId: approval?.approvalId || null,
            canApprove: Boolean(source.service && valid && notification.status === 'pending' && approval?.status === 'pending' && Date.parse(approval.expiresAt) > Date.now()) });
          if (notification.receiptId && state.receipts[notification.receiptId]) receipts.push(state.receipts[notification.receiptId]);
        }
        followups.push(...values(state.followups || {}));
      }
      return { simulation: true, notifications: notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), receipts, followups, unavailableScopes,
        recipients: [...new Map(values(actionTools).filter(item => item.recipientId).map(item => [item.recipientId, { recipientType: item.recipientType, recipientId: item.recipientId }])).values()] };
    },
    async decide(notificationId, decision) {
      check(/^NOTIF-[0-9a-f]{32}$/.test(notificationId) && ['approved', 'rejected'].includes(decision));
      const { records } = await read();
      for (const { source, state } of records) {
        const notification = state.notifications?.[notificationId]; if (!notification) continue;
        check(source.service && current(state, source, notification.sourceRevisionId), 'STALE_NOTIFICATION', 409);
        const approval = values(state.approvals).find(item => (item.revisionId || item.planRevisionId) === notification.sourceRevisionId && item.actionId === notification.sourceActionId);
        check(approval, 'NOTIFICATION_APPROVAL_NOT_REQUIRED', 409);
        const result = await source.service.decide(approval.approvalId, decision); void source.service.tick().catch(() => {}); return { approvalId: result.approvalId, status: result.status, simulation: true };
      }
      throw new NotificationError('NOTIFICATION_NOT_FOUND', 404);
    },
    async close() { if (closeStores) await Promise.all(sources.map(source => source.store.close())); },
  };
}
export function configuredNotificationCenter(env, caseStore, services) {
  const subjectId = env.M12_CLINICAL_CASE_ID || env.M8_CASE_ID;
  check(typeof subjectId === 'string', 'NOTIFICATION_CASE_SCOPE_REQUIRED');
  const clinicalStore = configuredClinicalStore(env, { readFleet: () => caseStore.listAmbulances(), captureCase: true, readCase: id => caseStore.getCase(id) });
  const hospitalStore = configuredOperationsStore(env, caseStore), regionalStore = configuredRegionalStore(env, caseStore);
  return createNotificationCenter({ closeStores: true, sources: [
    { scope: 'clinical', subjectId, store: clinicalStore, service: services.clinical },
    { scope: 'hospital', subjectId: 'OPS-HOSP-001', store: hospitalStore, service: services.operations },
    { scope: 'regional', subjectId: 'REGION-DEMO-001', store: regionalStore, service: services.regional },
  ] });
}
