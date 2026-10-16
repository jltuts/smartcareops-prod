import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = readFileSync(new URL('../../infra/terraform/openapi.yaml.tftpl', import.meta.url), 'utf8');

test('M41 Gateway publishes only the bounded Patient chat operations', () => {
  for (const [path, methods] of [
    ['/api/intake/voice/complete', ['post', 'options']],
    ['/api/intake/chat/session', ['get', 'post', 'delete', 'options']],
    ['/api/intake/chat/message', ['post', 'options']],
  ]) {
    const marker = `  ${path}:`, begin = contract.indexOf(marker);
    assert.ok(begin >= 0, `${path} declared`);
    assert.equal(contract.indexOf(marker, begin + 1), -1, `${path} declared once`);
    const end = contract.indexOf('\n  /', begin + marker.length);
    const section = contract.slice(begin, end < 0 ? undefined : end);
    for (const method of methods) assert.match(section, new RegExp(`\\n    ${method}:`));
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options']) {
      if (!methods.includes(method)) assert.doesNotMatch(section, new RegExp(`\\n    ${method}:`));
    }
  }
});
