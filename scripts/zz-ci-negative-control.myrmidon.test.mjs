import { test } from 'node:test';
import assert from 'node:assert/strict';

test('CI negative control must fail', () => {
  assert.fail('intentional CI negative control');
});
