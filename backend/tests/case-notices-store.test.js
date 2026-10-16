import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreCaseNoticeStore } from '../src/notifications/case-notices.js';
import { eventDatabase } from './event-firestore-fixture.js';

test('case notices are idempotent and patient UID remains hidden from the feed', async () => {
  const db = eventDatabase(), store = createFirestoreCaseNoticeStore(db);
  const notice = { notificationId: 'CASE-123', caseId: 'SC-78447678-936e-4f90-8fe3-5d4ac541cb07',
    recipientType: 'patient', recipientUid: 'owner', specialty: null, subject: 'Doctor review updated',
    createdAt: '2026-10-15T12:00:00.000Z' };
  assert.equal(await store.record(notice), true);
  assert.equal(await store.record(notice), false);
  await assert.rejects(store.record({ ...notice, subject: 'Changed' }), /CASE_NOTICE_CONFLICT/);
  const own = await store.list({ recipientType: 'patient', recipientUid: 'owner', canAccessCase: async () => true });
  assert.equal(own.length, 1);
  assert.equal(own[0].recipientUid, undefined);
  assert.equal((await store.list({ recipientType: 'patient', recipientUid: 'other', canAccessCase: async () => true })).length, 0);
  assert.equal((await store.list({ recipientType: 'patient', recipientUid: 'owner', canAccessCase: async () => false })).length, 0);
});
