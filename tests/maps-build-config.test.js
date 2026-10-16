import test from 'node:test';
import assert from 'node:assert/strict';
import { mapsBrowserKeyConfigured } from '../scripts/check-maps-browser-key.js';

test('hosting build accepts a non-empty clean public Maps browser key without printing it', () => {
  assert.equal(mapsBrowserKeyConfigured('restricted-public-test-key'), true);
});

test('hosting build rejects missing, whitespace-padded, quoted, and multiline Maps keys', () => {
  for (const value of [undefined, '', '   ', ' key ', '"key"', "'key'", 'key\n']) assert.equal(mapsBrowserKeyConfigured(value), false);
});
