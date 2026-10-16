import { emptyIntake } from '../src/intake/schema.js';
import { mergeIntake } from '../src/intake/validate.js';

export function routingIntake(symptoms = [['dizziness', 'confirmed']]) {
  const turns = [{ id: 1, role: 'Patient', text: 'My name is Demo Alex.', question: 'What is your name?' }];
  const patch = (kind, quote, evidenceId, extra) => ({ kind, label: null, value: null, secondaryValue: null, unit: null, qualitative: null, status: null, evidenceId, quote, ...extra });
  const updates = [patch('name', turns[0].text, 1, { value: 'Demo Alex' })];
  for (const [label, status] of symptoms) {
    const id = turns.length + 1, quote = status === 'denied' ? `I do not have ${label}.` : status === 'unclear' ? `Maybe I have ${label}.` : `I have ${label}.`;
    turns.push({ id, role: 'Patient', text: quote, question: `Do you have ${label}?` });
    updates.push(patch('symptom', quote, id, { label, status }));
  }
  return mergeIntake(emptyIntake(), { updates }, turns);
}

// SDK contract mock: query filtering, ordering, cursor and transactions use the
// same backing documents so tests exercise a fresh service's reads.
export function routingFirestoreMock() {
  const docs = new Map(), fleet = new Map(); let queue = Promise.resolve(), writes = 0;
  const target = name => name === 'cases' ? docs : name === 'ambulances' ? fleet : null;
  const snapshot = (name, id) => ({ exists: target(name).has(id), data: () => structuredClone(target(name).get(id)) });
  return { docs, fleet, get writes() { return writes; }, collection(name) {
    if (!target(name)) throw new Error('Unexpected collection');
    return { doc: id => ({ id, collection: name, get: async () => snapshot(name, id) }), where(field, operator, value) {
      const activeEmergency = ['emergency_pending_dispatcher', 'emergency_acknowledged', 'ambulance_assigned', 'ambulance_en_route', 'ambulance_at_pickup', 'patient_transporting', 'arrived_at_hospital'];
      const emergencyQuery = field === 'workflowStatus' && operator === 'in' && [JSON.stringify(activeEmergency), JSON.stringify([...activeEmergency, 'emergency_response_completed'])].includes(JSON.stringify(value));
      const reviewQuery = field === 'workflowStatus' && operator === 'in' && JSON.stringify(value) === JSON.stringify(['submitted_for_clinical_review', 'routed_to_doctor']);
      const appointmentQuery = field === 'patientUid' && operator === '==' || field === 'appointmentNoticeDoctorUids' && operator === 'array-contains';
      if (!emergencyQuery && !reviewQuery && !appointmentQuery && (field !== 'routing.status' || operator !== '==' || value !== 'routed')) throw new Error('Unexpected query');
      let count, after, newestFirst = false;
      const query = { orderBy(fieldName, direction) { if (fieldName === 'createdAt' && direction === 'desc') newestFirst = true; return query; }, limit(n) { count = n; return query; }, startAfter(...values) { after = values; return query; },
        async get() { return { docs: [...docs.values()].filter(doc => (emergencyQuery || reviewQuery) ? value.includes(doc.workflowStatus) : appointmentQuery ? (operator === 'array-contains' ? (doc[field] || []).includes(value) : doc[field] === value) : doc.routing?.status === value)
          .filter(doc => !after || newestFirst ? !after || doc.createdAt < after[0] || doc.createdAt === after[0] && doc.caseId < after[1] : doc.caseId > after[0])
          .sort(newestFirst ? (a, b) => b.createdAt.localeCompare(a.createdAt) || b.caseId.localeCompare(a.caseId) : (a, b) => a.caseId.localeCompare(b.caseId))
          .slice(0, count).map(doc => ({ data: () => structuredClone(doc) })) }; } };
      return query;
    } };
  }, runTransaction(work) {
    const next = queue.then(async () => {
      const staged = [];
      const result = await work({ get: async ref => { if (staged.length) throw new Error('All reads must precede writes'); return snapshot(ref.collection, ref.id); },
        create(ref, doc) { if (target(ref.collection).has(ref.id)) throw new Error('Already exists'); staged.push([ref, structuredClone(doc)]); },
        set(ref, doc) { staged.push([ref, structuredClone(doc)]); }, delete(ref) { staged.push([ref, null]); } });
      for (const [ref, doc] of staged) { writes++; if (doc === null) target(ref.collection).delete(ref.id); else target(ref.collection).set(ref.id, doc); }
      return result;
    });
    queue = next.catch(() => {}); return next;
  }, terminate() {} };
}
