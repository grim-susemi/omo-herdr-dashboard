import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHILD_SESSION_PATTERN, hostContextEligible, isChildSession } from '../../src/child-guard.mjs';

const owner = { token: 'token', ownerKey: 'owner', session: 'session', scope: 1 };

test('child session files are detected with either separator', () => {
  assert.match('C:/fixture/senpi-task/children/child/session.jsonl', CHILD_SESSION_PATTERN);
  assert.match('C:\\fixture\\senpi-task\\children\\child\\session.jsonl', CHILD_SESSION_PATTERN);
  assert.equal(isChildSession('C:/fixture/senpi-task/children/a/session.jsonl'), true);
  assert.equal(isChildSession('C:\\fixture\\senpi-task\\children\\a\\session.jsonl'), true);
});

test('parent, absent and non-string session files are not children', () => {
  assert.equal(isChildSession('C:/fixture/sessions/parent/session.jsonl'), false);
  assert.equal(isChildSession('C:/fixture/senpi-task/childrenish/session.jsonl'), false);
  assert.equal(isChildSession(undefined), false);
  assert.equal(isChildSession(null), false);
  assert.equal(isChildSession(42), false);
});

test('guard order: ui, mode, child session, owner', () => {
  const childCtx = {
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionFile: () => 'C:/fixture/senpi-task/children/c/session.jsonl' },
  };
  assert.deepEqual(hostContextEligible(undefined, { owner }), { eligible: false, reason: 'missing-ui' });
  assert.equal(hostContextEligible({ hasUI: false, mode: 'tui' }, { owner }).reason, 'missing-ui');
  assert.equal(hostContextEligible({ hasUI: true, mode: 'print' }, { owner }).reason, 'non-tui-mode');
  const child = hostContextEligible(childCtx, { owner });
  assert.equal(child.eligible, false);
  assert.equal(child.reason, 'child-session');
  assert.equal(child.selectedSessionFile, 'C:/fixture/senpi-task/children/c/session.jsonl');
  assert.equal(hostContextEligible({ hasUI: true, mode: 'tui' }, {}).reason, 'missing-owner');
  const parent = hostContextEligible({
    hasUI: true,
    mode: 'tui',
    sessionManager: { getSessionFile: () => 'C:/fixture/sessions/parent/session.jsonl' },
  }, { owner });
  assert.equal(parent.eligible, true);
  assert.equal(parent.reason, 'eligible');
});
