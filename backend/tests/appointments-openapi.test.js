import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');
test('M38 Gateway publishes only bounded appointment operations and preflight', () => {
  for (const [path, method] of [
    ['/api/doctor/cases/{caseId}/appointment', 'post'],
    ['/api/cases/{caseId}/appointment/response', 'post'],
    ['/api/notifications/appointments', 'get'],
  ]) {
    const marker = `  ${path}:`, begin = contract.indexOf(marker);
    assert.ok(begin >= 0, `${path} declared`);
    assert.equal(contract.indexOf(marker, begin + 1), -1, `${path} declared once`);
    const end = contract.indexOf('\n  /', begin + marker.length);
    const section = contract.slice(begin, end < 0 ? undefined : end);
    assert.match(section, new RegExp(`\\n    ${method}:`));
    assert.match(section, /\n    options:/);
    assert.doesNotMatch(section, /\n    (put|patch|delete):/);
  }
  assert.match(contract, /x-google-backend:\s*\n  address: \$\{backend_url\}\s*\n  jwt_audience: \$\{backend_url\}/);
  assert.doesNotMatch(contract, /\/api\/doctor\/cases\/\{caseId\}\/appointment\/\{[^}]+\}/);
});

test('case notice route exposes read and preflight only', () => {
  const marker = '  /api/notifications/cases:';
  const begin = contract.indexOf(marker);
  assert.ok(begin >= 0);
  const end = contract.indexOf('\n  /', begin + marker.length);
  const section = contract.slice(begin, end < 0 ? undefined : end);
  assert.match(section, /\n    get:/);
  assert.match(section, /\n    options:/);
  assert.doesNotMatch(section, /\n    (post|put|patch|delete):/);
});
