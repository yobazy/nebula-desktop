import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectedAgents, withSessionStatus } from '../src/nebula/sessionStatus.ts';

const task = (overrides = {}) => ({
  id: 'codex-task', kind: 'codex', alive: true, status: 'running',
  status_changed_at: 123, unseen: false, ...overrides,
});

test('a persisted running status cannot keep a dead session yellow', () => {
  const stale = task({ alive: false });
  assert.equal(withSessionStatus(stale).status, 'disconnected');
  assert.equal(stale.status, 'running');
  assert.equal(withSessionStatus(stale).status_changed_at, 123);
});

test('losing the daemon clears active indicators across projects without claiming sessions died', () => {
  const agents = { a: task(), b: task({ id: 'b', kind: 'claude', status: 'needs_feedback' }) };
  const disconnected = disconnectedAgents(agents);
  assert.deepEqual(Object.values(disconnected).map((a) => a.status), ['disconnected', 'disconnected']);
  assert.equal(disconnected.a.alive, true);
  assert.equal(agents.a.status, 'running');
});

test('finished, failed, unstarted and already disconnected tasks retain their state', () => {
  for (const status of ['finished', 'terminated', 'fresh', 'disconnected']) {
    const agent = task({ status, alive: false, unseen: true });
    assert.equal(withSessionStatus(agent, false), agent);
  }
});

test('fresh live snapshots restore running and waiting states after reconnect', () => {
  for (const status of ['running', 'needs_feedback']) {
    const snapshot = task({ status });
    assert.equal(withSessionStatus(snapshot, false).status, 'disconnected');
    assert.equal(withSessionStatus(snapshot), snapshot);
  }
});
