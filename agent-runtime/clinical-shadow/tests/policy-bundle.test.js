import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async url => JSON.parse(await readFile(url, 'utf8'));

test('runtime policy bundle exactly matches the accepted Phase D fixture and completion receipt', async () => {
  const [bundledFixture, sourceFixture, bundledReceipt, sourceReceipt] = await Promise.all([
    json(new URL('../policy/ingestion-fixture.json', import.meta.url)),
    json(new URL('../../../docs/policy-corpus/m60-fictional-v1/ingestion-fixture.json', import.meta.url)),
    json(new URL('../policy/managed-ingestion-receipt.json', import.meta.url)),
    json(new URL('../../../docs/m60-phase-d-managed-ingestion-complete-receipt.json', import.meta.url)),
  ]);
  assert.deepEqual(bundledFixture, sourceFixture);
  assert.deepEqual(bundledReceipt, sourceReceipt);
  assert.equal(bundledReceipt.status, 'uploaded');
  assert.equal(bundledReceipt.uploaded.length, 12);
  assert.equal(bundledReceipt.manifestDigest, bundledFixture.manifestDigest);
});
