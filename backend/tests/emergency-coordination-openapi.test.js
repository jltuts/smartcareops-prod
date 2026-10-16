import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');

test('M43 Gateway publishes only the bounded response-coordination operations', () => {
  const routes = [
    ['/api/operations/emergency-responses', 'get'], ['/api/dispatcher/cases/{caseId}', 'get'],
    ['/api/dispatcher/cases/{caseId}/acknowledge', 'post'], ['/api/dispatcher/cases/{caseId}/hospitals', 'get'],
    ['/api/dispatcher/cases/{caseId}/hospitals/{hospitalId}/select', 'post'], ['/api/ambulances', 'get'],
    ['/api/cases/{caseId}/ambulance/{unitId}/assign', 'post'], ['/api/cases/{caseId}/ambulance/{action}', 'post'],
  ];
  for (const [path, method] of routes) {
    const marker = `  ${path}:`, begin = contract.indexOf(marker);
    assert.ok(begin >= 0, `${path} declared`); assert.equal(contract.indexOf(marker, begin + 1), -1, `${path} declared once`);
    const end = contract.indexOf('\n  /', begin + marker.length), section = contract.slice(begin, end < 0 ? undefined : end);
    assert.match(section, new RegExp(`\\n    ${method}:`)); assert.match(section, /\n    options:/);
  }
  const action = contract.slice(contract.indexOf('  /api/cases/{caseId}/ambulance/{action}:'), contract.indexOf('\n  /api/doctor/cases:'));
  assert.match(action, /enum: \[dispatch, arrive-pickup, start-transport, arrive-hospital, complete\]/);
});
