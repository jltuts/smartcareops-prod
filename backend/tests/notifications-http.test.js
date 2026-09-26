import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { regionalFixture, regionalAssessment } from './regional-fixtures.js';
import { createNotificationCenter } from '../src/notifications/service.js';
import { notificationEndpoint } from '../src/notifications/http.js';
test('notification HTTP permits only bounded decisions, safe inspection and allowed origins', async t => {
  const f = await regionalFixture({ notificationsEnabled: true, model: context => ({ ...regionalAssessment(context), recommendedActions: ['notify_participating_hospital'] }) }); await f.service.tick();
  const center = createNotificationCenter({ sources: [{ scope: 'regional', subjectId: 'REGION-DEMO-001', store: f.store, service: f.service }] }), origin = 'http://localhost:4173';
  const server = createServer(notificationEndpoint(center, [origin])); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await f.service.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/notifications`, initial = await (await fetch(base)).json(), notice = initial.notifications[0];
  const post = (body, source = origin) => fetch(`${base}/${notice.notificationId}/decision`, { method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ decision: 'approved' }, 'https://invalid.test')).status, 403);
  assert.equal((await post({ decision: 'approved', recipientId: 'UNLISTED' })).status, 400);
  assert.equal((await post({ decision: 'send_now' })).status, 400);
  assert.equal((await fetch(base + '?recipientType=unlisted')).status, 400);
  assert.equal((await fetch(base + '?recipientId=arbitrary')).status, 400);
  assert.equal((await post({ decision: 'approved' })).status, 200); await f.service.tick();
  assert.equal((await post({ decision: 'approved' })).status, 409);
  assert.equal((await center.view()).receipts.length, 1);
});
test('disabled notification endpoint returns safe unavailable response', async t => {
  const server = createServer(notificationEndpoint(null, [])); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications`); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'NOTIFICATIONS_DISABLED');
});
