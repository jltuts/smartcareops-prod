import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryCaseStore, newCaseId } from '../src/cases/store.js';
import { createFirestoreCaseStore } from '../src/cases/firestore.js';
import { routingIntake, routingFirestoreMock } from './routing-fixtures.js';
import { appointmentWindow } from '../src/cases/appointments.js';
import { emergencyIntake } from './safety-fixtures.js';
import { appointmentEndpoint } from '../src/cases/appointment-http.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

const doctor = { uid: 'verified-doctor', displayName: 'Dr. Louie', specialties: ['neurology', 'orthopedics'], doctorVerification: { status: 'verified' } };
const slot = (hours = 24) => ({ startAt: new Date(Date.now() + hours * 3600000).toISOString(), endAt: new Date(Date.now() + (hours + 1) * 3600000).toISOString() });
const proposal = (expectedVersion = 0, slots = [slot()]) => ({ requestId: randomUUID(), expectedVersion, timeZone: 'Asia/Manila', appointmentType: 'Fictional consultation', slots });
for (const [mode, make] of [['memory', createMemoryCaseStore], ['firestore', () => createFirestoreCaseStore(routingFirestoreMock())]]) {
  test(`${mode}: approved normal case appointment lifecycle, ownership, versions and idempotency`, async () => {
    const store = make(), caseId = newCaseId(), patientUid = 'patient-owner';
    await store.createCase({ caseId, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid, submittedForReview: true });
    await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
    const first = proposal();
    await assert.rejects(store.proposeAppointment(caseId, first, doctor), error => error.code === 'APPOINTMENT_NOT_ELIGIBLE');
    await store.decideClinicalReview(caseId, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid, reviewerProfile: { displayName: doctor.displayName, specialty: 'orthopedics' } });
    await assert.rejects(store.proposeAppointment(caseId, first, { ...doctor, specialties: ['neurology'] }), error => error.status === 404);
    await assert.rejects(store.proposeAppointment(caseId, first, { ...doctor, doctorVerification: null }), error => error.status === 403);
    const saved = await store.proposeAppointment(caseId, first, doctor);
    assert.equal(saved.appointmentProposal.version, 1); assert.equal(saved.appointmentProposal.state, 'awaiting_patient_confirmation');
    assert.equal(saved.appointmentProposal.slots.length, 1); assert.equal(saved.appointmentProposal.doctor.displayName, doctor.displayName);
    assert.equal(saved.appointmentProposal.doctor.uid, undefined);
    assert.equal((await store.listAppointmentNotifications({ recipientType: 'patient', recipientUid: patientUid })).length, 1);
    assert.equal((await store.listAppointmentNotifications({ recipientType: 'patient', recipientUid: 'other-patient' })).length, 0);
    assert.deepEqual((await store.proposeAppointment(caseId, first, doctor)).appointmentProposal, saved.appointmentProposal);
    assert.equal((await store.getPatientCase(caseId, patientUid)).appointmentProposal.version, 1);
    await assert.rejects(store.getPatientCase(caseId, 'other-patient'), error => error.status === 404);
    const second = proposal(1, [slot(48), slot(72)]);
    const replaced = await store.proposeAppointment(caseId, second, doctor);
    assert.equal(replaced.appointmentProposal.version, 2);
    const stale = { requestId: randomUUID(), version: 1, action: 'confirm', slotId: saved.appointmentProposal.slots[0].slotId };
    await assert.rejects(store.respondToAppointment(caseId, stale, patientUid), error => error.code === 'STALE_APPOINTMENT_PROPOSAL');
    const answer = { requestId: randomUUID(), version: 2, action: 'confirm', slotId: replaced.appointmentProposal.slots[0].slotId };
    await assert.rejects(store.respondToAppointment(caseId, answer, 'other-patient'), error => error.status === 404);
    const confirmed = await store.respondToAppointment(caseId, answer, patientUid);
    assert.equal(confirmed.appointmentProposal.state, 'appointment_confirmed');
    assert.equal(confirmed.appointmentProposal.confirmedSlotId, answer.slotId);
    assert.equal((await store.listAppointmentNotifications({ recipientType: 'doctor', recipientUid: doctor.uid })).length, 1);
    assert.equal((await store.listAppointmentNotifications({ recipientType: 'doctor', recipientUid: 'other-doctor' })).length, 0);
    assert.deepEqual((await store.respondToAppointment(caseId, answer, patientUid)).appointmentProposal, confirmed.appointmentProposal);
    await assert.rejects(store.proposeAppointment(caseId, proposal(2), doctor), error => error.code === 'APPOINTMENT_ALREADY_CONFIRMED');
  });
  test(`${mode}: alternate-time response and bounded slot validation`, async () => {
    const store = make(), caseId = newCaseId();
    await store.createCase({ caseId, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
    await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
    await store.decideClinicalReview(caseId, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid });
    for (const bad of [[], [slot(), slot(), slot(), slot()], [slot(0.1)], [slot(91 * 24)], [slot(72), slot(48)], [{ ...slot(), endAt: slot().startAt }]]) {
      await assert.rejects(store.proposeAppointment(caseId, proposal(0, bad), doctor), error => error.status === 400);
    }
    assert.equal(appointmentWindow.maximumMs, 90 * 24 * 3600000);
    const created = await store.proposeAppointment(caseId, proposal(), doctor);
    const answer = { requestId: randomUUID(), version: 1, action: 'request_another_time', slotId: null };
    assert.equal((await store.respondToAppointment(caseId, answer, 'patient')).appointmentProposal.state, 'alternate_time_requested');
    assert.match((await store.listAppointmentNotifications({ recipientType: 'doctor', recipientUid: doctor.uid }))[0].subject, /another time/);
    await assert.rejects(store.respondToAppointment(caseId, { ...answer, requestId: randomUUID() }, 'patient'), error => error.code === 'APPOINTMENT_RESPONSE_CLOSED');
    assert.equal((await store.proposeAppointment(caseId, proposal(created.appointmentProposal.version), doctor)).appointmentProposal.version, 2);
  });
}
test('emergency, ambulance, and active hospital handoff cannot enter appointment workflow', async () => {
  const db = routingFirestoreMock(), store = createFirestoreCaseStore(db);
  const emergencyId = newCaseId();
  await store.createCase({ caseId: emergencyId, intake: emergencyIntake(), patientUid: 'patient', submittedForReview: true });
  await assert.rejects(store.proposeAppointment(emergencyId, proposal(), doctor), error => [404, 409].includes(error.status));
  for (const change of [{ ambulance: { unitId: 'DEMO-AMB' } }, { handoffStatus: 'in_progress' },
    { hospitalHandoffs: { demo: { status: 'completed' } } }]) {
    const id = newCaseId();
    await store.createCase({ caseId: id, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
    await store.routeCase(id, { availableSpecialties: new Set(['orthopedics']) });
    await store.decideClinicalReview(id, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid });
    db.docs.set(id, { ...db.docs.get(id), ...change });
    await assert.rejects(store.proposeAppointment(id, proposal(), doctor), error => error.code === 'APPOINTMENT_NOT_ELIGIBLE');
  }
});
test('appointment HTTP keeps exact origin, role, and request validation at the route boundary', async () => {
  const store = createMemoryCaseStore(), caseId = newCaseId(), origin = 'https://app.example.invalid';
  await store.createCase({ caseId, intake: routingIntake([['left shoulder pain', 'confirmed']]), patientUid: 'patient', submittedForReview: true });
  await store.routeCase(caseId, { availableSpecialties: new Set(['orthopedics']) });
  await store.decideClinicalReview(caseId, { requestId: randomUUID(), decision: 'approved', reviewerId: doctor.uid });
  const endpoint = appointmentEndpoint(store, [origin]);
  let user = null;
  const server = createServer((request, response) => { request.user = user; void endpoint(request, response); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body, requestOrigin = origin) => fetch(base + path, { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const path = `/api/doctor/cases/${caseId}/appointment`, input = proposal();
    user = null; assert.equal((await send(path, input)).status, 403);
    user = { ...doctor, roles: ['doctor'] };
    assert.equal((await send(path, input, 'https://unlisted.example.invalid')).status, 403);
    assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await send(path, { ...input, doctorUid: doctor.uid })).status, 400);
    assert.equal((await send(path, input)).status, 200);
    const doctorFeed = `/api/notifications/appointments?recipientType=doctor`;
    assert.equal((await fetch(base + doctorFeed)).status, 200);
    user = { uid: 'other', roles: ['patient'] };
    assert.equal((await send(`/api/cases/${caseId}/appointment/response`, { requestId: randomUUID(), version: 1, action: 'request_another_time', slotId: null })).status, 404);
    assert.equal((await fetch(base + doctorFeed)).status, 403);
    const patientFeed = await fetch(base + '/api/notifications/appointments?recipientType=patient');
    assert.equal(patientFeed.status, 200); assert.equal((await patientFeed.json()).notifications.length, 0);
  } finally { server.close(); await once(server, 'close'); }
});
