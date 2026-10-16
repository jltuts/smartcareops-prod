import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCaseService, createMemoryCaseStore, newCaseId } from '../src/cases/store.js';

const intake = name => ({
  patient: { name, preferredName: null },
  symptoms: [{ name: 'shoulder pain', status: 'confirmed', patientReportedText: 'I have shoulder pain.' }],
  redFlags: [], onset: { value: 'today', patientReportedText: 'Today' },
  vitals: { temperature: {}, bloodPressure: {}, heartRate: {}, spo2: {}, bloodGlucose: {} }, additionalNotes: [],
  evidence: { name: { patientReportedText: name }, 'symptoms.shoulder pain': { utteranceId: 1, patientReportedText: 'I have shoulder pain.' }, onset: { patientReportedText: 'Today' } },
});

test('Patient case history is newest-first, paginated, minimal, and isolated by verified UID', async () => {
  const store = createMemoryCaseStore(), own = [];
  for (let index = 0; index < 3; index++) {
    own.push((await store.createCase({ caseId: newCaseId(), intake: intake(`Patient ${index}`), patientUid: 'patient-a', submittedForReview: true })).caseId);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await store.createCase({ caseId: newCaseId(), intake: intake('Other Patient'), patientUid: 'patient-b', submittedForReview: true });
  const first = await store.listPatientCases({ patientUid: 'patient-a', limit: 2 });
  assert.equal(first.cases.length, 2); assert.ok(first.nextCursor); assert.equal(first.cases[0].caseId, own[2]);
  assert.deepEqual(Object.keys(first.cases[0]).sort(), ['caseId', 'clinicalReview', 'intakeDate', 'nextStep', 'workflowStatus', 'appointmentProposal', 'emergency', 'ambulance', 'emergencyDestination'].sort());
  const second = await store.listPatientCases({ patientUid: 'patient-a', after: first.nextCursor, limit: 2 });
  assert.deepEqual(second.cases.map(record => record.caseId), [own[0]]); assert.equal(second.nextCursor, null);
  assert.equal((await store.listPatientCases({ patientUid: 'patient-b', limit: 10 })).cases.length, 1);
  await assert.rejects(store.getPatientCase(own[0], 'patient-b'), error => error.code === 'CASE_NOT_FOUND');
});

test('terminal review exposes only a verified Doctor profile snapshot and no operational side effect', async () => {
  const store = createMemoryCaseStore(), id = newCaseId();
  await store.createCase({ caseId: id, intake: intake('Review Patient'), patientUid: 'patient-a', submittedForReview: true });
  await store.routeCase(id, { availableSpecialties: new Set(['orthopedics']) });
  assert.equal((await store.getPatientCase(id, 'patient-a')).doctorAttribution, undefined);
  await store.decideClinicalReview(id, { requestId: randomUUID(), decision: 'approved', reviewerId: 'doctor-a',
    reviewerProfile: { displayName: 'Dr. Fictional Rivera', specialty: 'general_medicine' } });
  const reviewed = await store.getPatientCase(id, 'patient-a');
  assert.deepEqual(reviewed.doctorAttribution, { status: 'available', displayName: 'Dr. Fictional Rivera', specialty: 'general_medicine' });
  const summary = await store.listPatientCases({ patientUid: 'patient-a', limit: 10 });
  assert.equal(summary.cases.find(record => record.caseId === id).nextStep, 'Review complete. No appointment is currently proposed.');
  assert.equal(reviewed.handoffStatus, 'not_started'); assert.equal(reviewed.routing.status, 'routed'); assert.equal(reviewed.routing.specialty, 'orthopedics'); assert.equal(reviewed.ambulance, null);
  const missingProfileId = newCaseId();
  await store.createCase({ caseId: missingProfileId, intake: intake('No Profile'), patientUid: 'patient-a', submittedForReview: true });
  await store.decideClinicalReview(missingProfileId, { requestId: randomUUID(), decision: 'deferred', reviewerId: 'doctor-b' });
  assert.deepEqual((await store.getPatientCase(missingProfileId, 'patient-a')).doctorAttribution, { status: 'unavailable' });
});

test('confirmed packaging image is case-scoped Doctor evidence while public case data contains no bytes or URL', async () => {
  const store = createMemoryCaseStore(), id = newCaseId(), bytes = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const record = await store.createCase({ caseId: id, intake: intake('Evidence Patient'), patientUid: 'patient-a', submittedForReview: true,
    medication: { name: 'Fictionalmed', strength: '10 mg', howTaken: 'One each morning', source: 'packaging_shown', verification: 'patient_reported', confirmedAt: new Date().toISOString() },
    medicationImage: { mimeType: 'image/jpeg', byteLength: bytes.length, bytes } });
  assert.deepEqual(record.medications[0].imageEvidence, { status: 'available' });
  assert.equal(JSON.stringify(record).includes(bytes.toString('base64')), false); assert.equal(JSON.stringify(record).includes('http'), false);
  const image = await store.getDoctorMedicineImage(id);
  assert.equal(image.mimeType, 'image/jpeg'); assert.deepEqual(image.bytes, bytes);
  await assert.rejects(store.getDoctorMedicineImage(newCaseId()), error => error.code === 'CASE_NOT_FOUND');
});

test('image storage failure is honest and never loses the confirmed medicine text', async () => {
  const docs = new Map();
  const store = createCaseService({
    async get(id) { return structuredClone(docs.get(id) || null); },
    async transact(id, change) { const next = change(structuredClone(docs.get(id) || null)); docs.set(id, structuredClone(next)); return structuredClone(next); },
    async putMedicineImage() { throw new Error('provider details must stay private'); },
  }, 'test');
  const id = newCaseId(), bytes = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const record = await store.createCase({ caseId: id, intake: intake('Evidence Patient'), patientUid: 'patient-a', submittedForReview: true,
    medication: { name: 'Fictionalmed', strength: '10 mg', howTaken: 'One each morning', source: 'packaging_shown', verification: 'patient_reported', confirmedAt: new Date().toISOString() },
    medicationImage: { mimeType: 'image/jpeg', byteLength: bytes.length, bytes } });
  assert.equal(record.medications[0].name, 'Fictionalmed'); assert.deepEqual(record.medications[0].imageEvidence, { status: 'unavailable' });
  await assert.rejects(store.getDoctorMedicineImage(id), error => error.code === 'CASE_EVIDENCE_UNAVAILABLE');
});
