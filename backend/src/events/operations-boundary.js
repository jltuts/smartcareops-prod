import { Firestore, FieldPath } from '@google-cloud/firestore';
import { environmentConfig } from '../environment.js';

const ambulanceLabels = Object.freeze({ assigned: 'Ambulance assigned', en_route: 'Ambulance en route', at_pickup: 'Ambulance at pickup',
  transporting: 'Patient transporting', arrived_hospital: 'Arrived at hospital', completed: 'Response completed' });
const emergencyResponse = value => ambulanceLabels[value.ambulance?.status] || (value.emergencyDestination?.status === 'accepted' ? 'Hospital acceptance recorded' :
  value.emergency?.status === 'acknowledged' ? 'Awaiting hospital and ambulance action' : 'Dispatcher acknowledgement pending');
const dispatcherStatus = value => value.emergency?.status === 'acknowledged' ? 'Dispatcher acknowledged' : 'Dispatcher acknowledgement pending';
const isEmergencyState = value => Boolean(value?.emergency);
const publicBoundary = (projection, records) => projection ? Object.freeze({
  classificationStatus: isEmergencyState(records.caseState) ? 'emergency' : projection.routingDisposition ? 'classified' : 'legacy_unclassified',
  reference: projection.subjectId,
  event: isEmergencyState(records.caseState) ? 'Emergency intake recorded' : 'Routine intake recorded',
  projection: 'Operations projection recorded',
  routing: isEmergencyState(records.caseState) ? dispatcherStatus(records.caseState) : !projection.routingDisposition ? 'Not recorded before classification rollout' : projection.routingDisposition === 'normal_care' ? 'Kept in normal care' : 'Hospital Operations review',
  hospitalOperationsTriggered: isEmergencyState(records.caseState) ? false : projection.routingDisposition ? projection.hospitalOperationsTriggered === true : null,
  classifiedAt: projection.classifiedAt || projection.projectedAt,
  trace: Object.freeze(isEmergencyState(records.caseState) ? [
    { key: 'case', label: 'Emergency intake', status: 'Committed' },
    { key: 'outbox', label: 'Outbox event', status: records.outbox ? 'Recorded' : 'Pending' },
    { key: 'audit', label: 'Audit receipt', status: records.audit ? 'Recorded' : 'Pending' },
    { key: 'projection', label: 'Operations projection', status: 'Recorded' },
    { key: 'routing', label: 'Emergency pathway', status: dispatcherStatus(records.caseState) },
    { key: 'response', label: 'Emergency response', status: emergencyResponse(records.caseState) },
    { key: 'activation', label: 'Hospital Operations activation', status: 'Not requested' },
  ] : [
    { key: 'case', label: 'Intake case', status: 'Committed' },
    { key: 'outbox', label: 'Outbox event', status: records.outbox ? 'Recorded' : 'Pending' },
    { key: 'audit', label: 'Audit receipt', status: records.audit ? 'Recorded' : 'Pending' },
    { key: 'projection', label: 'Operations projection', status: 'Recorded' },
    { key: 'routing', label: 'Routing decision', status: !projection.routingDisposition ? 'Not recorded' : projection.routingDisposition === 'normal_care' ? 'Normal care' : 'Hospital Operations review' },
    { key: 'activation', label: 'Hospital Operations activation', status: !projection.routingDisposition ? 'Not recorded' : projection.hospitalOperationsTriggered === true ? 'Requested' : 'Not requested' },
  ]),
}) : null;

export function createFirestoreOperationsBoundaryReader(db, { collection = 'eventOperations', limit = 50, readCaseState = async caseId => {
  const snapshot = await db.collection('cases').where(FieldPath.documentId(), '==', caseId)
    .select('workflowStatus', 'emergency.status', 'ambulance.status', 'emergencyDestination.status').limit(1).get();
  return snapshot.empty ? null : snapshot.docs[0].data();
} } = {}) {
  return async caseId => {
    const query = caseId ? db.collection(collection).where('subjectId', '==', caseId).limit(5)
      : db.collection(collection).orderBy('classifiedAt', 'desc').limit(limit);
    const snapshot = await query.get();
    const candidates = snapshot.docs.map(doc => doc.data());
    let projection, caseState = null;
    if (caseId) {
      projection = candidates.find(item => item.eventType === 'case.created');
      if (projection) caseState = await readCaseState(caseId);
    } else {
      for (const candidate of candidates.filter(item => item.eventType === 'case.created' && item.routingDisposition === 'normal_care')) {
        const currentState = await readCaseState(candidate.subjectId);
        if (!isEmergencyState(currentState)) { projection = candidate; caseState = currentState; break; }
      }
    }
    if (!projection) return null;
    const [outbox, audit] = await Promise.all([
      db.collection('eventOutbox').doc(projection.outboxId).get(),
      db.collection('eventAudit').doc(projection.outboxId).get(),
    ]);
    return publicBoundary(projection, { outbox: outbox.exists, audit: audit.exists, caseState });
  };
}

export function createConfiguredOperationsBoundaryReader(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE !== 'firestore' || !config.projectId || env.FIRESTORE_EMULATOR_HOST) return async () => null;
  return createFirestoreOperationsBoundaryReader(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}
