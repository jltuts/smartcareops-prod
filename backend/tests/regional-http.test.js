import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { regionalFixture } from './regional-fixtures.js';
import { regionalEndpoint } from '../src/regional/http.js';
test('regional API rejects foreign origins, forged identities/scopes and arbitrary actions', async t => {
  const f = await regionalFixture(); await f.service.tick(); const origin = 'http://localhost:4173'; const server = createServer(regionalEndpoint(f.service, [origin]));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { await f.service.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/regional`, post = (path, body, from = origin) => fetch(base + path, { method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/run', { requestId: 'bad' }, 'https://evil.test')).status, 403); assert.equal((await post('/run', { requestId: 'bad', workspaceId: 'other' })).status, 400);
  assert.equal((await post('/external_alert', {})).status, 400); const view = await (await fetch(base)).json(), approval = view.approvals[0];
  assert.equal((await post(`/approvals/${approval.approvalId}`, { decision: 'approved', reviewerId: 'admin' })).status, 400);
  assert.equal((await post(`/approvals/${approval.approvalId}`, { decision: 'approved' })).status, 200); await f.service.tick(); assert.equal((await f.service.view()).receipts.length, 3);
});
