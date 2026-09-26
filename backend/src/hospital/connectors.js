import { check, hash, validKey, verifyReceipt } from './contracts.js';

// This bounded adapter targets only our fictional local REST hospital. No
// production hospital URL, credential, or real submission is configured.
export function createRestConnector({ endpoint, credential, request = fetch }) {
  const url = () => { const value = new URL(endpoint()); check(value.protocol === 'http:' && value.hostname === '127.0.0.1' && value.pathname === '/internal/hospital-demo/cases' && !value.search && !value.hash && !value.username && !value.password, 'DESTINATION_NOT_ALLOWED'); return value; };
  async function call(input, readOnly) {
    const target = url();
    if (readOnly) target.search = new URLSearchParams({ caseId: input.caseId, idempotencyKey: input.idempotencyKey }).toString();
    const response = await request(target, { method: readOnly ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      ...(!readOnly ? { body: JSON.stringify(input) } : {}) });
    if (readOnly && response.status === 404) return null;
    check(response.ok, 'HOSPITAL_RESPONSE_UNAVAILABLE');
    const text = await response.text(); check(text.length <= 4096, 'INVALID_HOSPITAL_RECEIPT');
    return verifyReceipt(JSON.parse(text), input);
  }
  return { submitCase: input => call(input, false), lookupReceipt: input => call(input, true) };
}

export function createComputerUseConnector({ run, portalUrl }) {
  return {
    async submitCase(input, { confirm = async () => false } = {}) {
      let observed;
      const result = await run({ intake: input.payload, portalUrl: portalUrl(), confirm, emit: e => { if (e.status === 'completed') observed = e.caseId; } });
      check(result?.caseId === observed && /^DEMO-[A-F0-9]{8}$/.test(observed), 'INVALID_HOSPITAL_RECEIPT');
      return verifyReceipt({ receiptId: observed, caseId: input.caseId, hospitalId: input.hospitalId, idempotencyKey: input.idempotencyKey, payloadDigest: hash(input.payload), verified: true }, input);
    },
    // A lost legacy browser outcome cannot be reproduced safely by reopening it.
    async lookupReceipt() { return null; },
  };
}

export function demoHospitalEndpoint({ store, credential }) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    try {
      check(req.headers.authorization === `Bearer ${credential}`, 'FORBIDDEN');
      const url = new URL(req.url, 'http://localhost'); let receipt;
      if (req.method === 'GET') receipt = await store.getDemoHospitalReceipt(url.searchParams.get('caseId'), url.searchParams.get('idempotencyKey'));
      else {
        check(req.method === 'POST'); let raw = '';
        for await (const chunk of req) { raw += chunk; check(Buffer.byteLength(raw) < 120000); }
        const input = JSON.parse(raw); check(validKey(input.idempotencyKey) && req.headers['idempotency-key'] === input.idempotencyKey);
        receipt = await store.recordDemoHospitalReceipt(input.caseId, { ...input, payloadDigest: hash(input.payload) });
      }
      res.writeHead(receipt ? 200 : 404); res.end(JSON.stringify(receipt || {}));
    } catch { res.writeHead(403); res.end(JSON.stringify({ message: 'Fictional hospital request unavailable.' })); }
  };
}
