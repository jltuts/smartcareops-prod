import test from 'node:test';
import assert from 'node:assert/strict';
import { caseNoticesEndpoint } from '../src/notifications/case-notices-http.js';

test('case notice feed enforces role and per-case access', async () => {
  const seen = [];
  const store = { async list(input) {
    seen.push(input);
    return (await input.canAccessCase('SC-78447678-936e-4f90-8fe3-5d4ac541cb07', { specialty: 'family_medicine' }))
      ? [{ notificationId: 'CASE-test', subject: 'Doctor review', recipientType: input.recipientType }] : [];
  } };
  const caseStore = { async isDoctorCaseAllowed(id, specialties) { return specialties.includes('family_medicine'); },
    async getPatientCase(id, uid) { return uid === 'owner' ? { caseId: id } : null; },
    async getDispatcherCase() { throw new Error('not emergency'); } };
  const handler = caseNoticesEndpoint({ store, caseStore });
  const call = async (recipientType, user) => {
    const request = { method: 'GET', url: `/api/notifications/cases?recipientType=${recipientType}`, user };
    const response = { status: 200, body: '', setHeader() {}, writeHead(status) { this.status = status; },
      end(body) { this.body = body; } };
    await handler(request, response);
    return { status: response.status, body: JSON.parse(response.body) };
  };
  const doctor = { uid: 'doctor-1', roles: ['doctor'], specialties: ['family_medicine'] };
  const patient = { uid: 'owner', roles: ['patient'] };
  assert.equal((await call('doctor', patient)).status, 403);
  assert.equal((await call('doctor', doctor)).body.notifications.length, 1);
  assert.equal((await call('dispatcher', doctor)).body.code, 'CASE_NOTICE_ACCESS_DENIED');
  assert.equal((await call('patient', patient)).body.notifications.length, 1);
  assert.equal(seen.length, 2);
});
