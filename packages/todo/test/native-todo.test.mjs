import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectNativeTodo, createNativeTodoProjection } from '../src/native-todo.mjs';

const task = (content, status = 'pending') => ({ content, status });
const phase = (name, ...tasks) => ({ name, tasks });
const custom = (data, id = 'fixture-entry') => ({ id, type: 'custom', customType: 'senpi.todo-state', data });
const result = (details, toolName = 'todo', isError = false) => ({
  type: 'message', message: { role: 'toolResult', toolName, details, isError },
});
const ask = { entryId: 'fixture-ask', text: 'Synthetic request', capturedAt: 123 };
const base = [phase('F', task('a', 'in_progress'), task('b')), phase('V', task('c'))];
const counts = (completed, dropped, inProgress, pending) => ({
  total: completed + dropped + inProgress + pending,
  closed: completed + dropped, open: inProgress + pending,
  completed, dropped, inProgress, pending,
});

test('custom and successful tool results replace in root-to-leaf order', () => {
  const later = [phase('V', task('c', 'completed'))];
  const observed = projectNativeTodo([custom({ phases: base, ask }), result({ phases: later }, 'todowrite')]);
  assert.deepEqual(observed.phases, later);
  assert.equal(observed.ask, undefined);
  assert.deepEqual(observed.counts, counts(1, 0, 0, 0));
  assert.equal(observed.target, null);
  assert.deepEqual(projectNativeTodo([result({ phases: later }), custom({ phases: base })]).phases, base);
});

test('empty replacement clears ask, survives snapshots and is not 100 percent', () => {
  const observed = projectNativeTodo([
    custom({ phases: base, ask }),
    { type: 'custom', customType: 'compaction.todo-snapshot', data: { phases: base, ask } },
    custom({ schema: 'v2', phases: [] }),
    { type: 'compaction', todoSnapshot: { phases: base } },
  ]);
  assert.deepEqual(observed.phases, []);
  assert.equal(observed.ask, undefined);
  assert.equal(observed.availability, 'empty');
  assert.deepEqual(observed.counts, counts(0, 0, 0, 0));
  assert.equal(observed.target, null);
  assert.deepEqual(projectNativeTodo([custom({ phases: base }), result({ phases: [] })]).phases, []);
});

test('invalid payloads and ineligible messages never replace native state', () => {
  const invalid = [
    {}, null, [], { schema: 'v2', todos: [] },
    { phases: [phase('F', task('bad', 'blocked'))] },
    { phases: [{ name: 1, tasks: [] }] }, { phases: [phase('F', { status: 'pending' })] },
    { phases: 'bad' }, { tasks: [task('proposal')] },
  ];
  for (const data of invalid) {
    assert.deepEqual(projectNativeTodo([custom({ phases: base, ask }), custom(data)]).phases, base);
  }
  const noise = [
    result({ phases: [] }, 'todo', true), result({ phases: [] }, 'other'),
    { type: 'message', message: { role: 'assistant', content: 'All done', details: { phases: [] } } },
    { type: 'custom', customType: 'compaction.todo-restore-request', data: { phases: [] } },
    { type: 'custom', customType: 'todowrite', data: { todos: [] } },
    null, {},
  ];
  assert.deepEqual(projectNativeTodo([custom({ phases: base, ask }), ...noise]).ask, ask);
  assert.deepEqual(projectNativeTodo([custom({ phases: base }), ...noise]).phases, base);
  assert.equal(projectNativeTodo(noise).availability, 'waiting');
});

test('legacy statuses follow native migration without promoting pending work', () => {
  const observed = projectNativeTodo([custom({ todos: [
    task('drop', 'cancelled'), task('unknown', 'blocked'), { content: 'missing' }, task('done', 'completed'),
  ] })]);
  assert.deepEqual(observed.phases, [phase('Tasks',
    task('drop', 'abandoned'), task('unknown'), task('missing'), task('done', 'completed'))]);
  assert.deepEqual(observed.counts, counts(1, 1, 0, 2));
  assert.equal(observed.target.content, 'unknown');
  assert.deepEqual(projectNativeTodo([custom({ todos: [] })]).phases, [phase('Tasks')]);
});

test('valid ask copies all native fields and missing or invalid ask clears it', () => {
  const extended = { ...ask, extra: 'native field' };
  assert.deepEqual(projectNativeTodo([custom({ phases: base, ask: extended })]).ask, extended);
  for (const value of [undefined, {}, { ...ask, capturedAt: '123' }]) {
    assert.equal(projectNativeTodo([custom({ phases: base, ask }), result({ phases: base, ask: value })]).ask, undefined);
  }
});

test('done(c) and done(a) yield closed 2/3 and target b', () => {
  const phases = [phase('F', task('a', 'completed'), task('b')), phase('V', task('c', 'completed'))];
  const observed = projectNativeTodo([custom({ phases: base }), custom({ phases })]);
  assert.deepEqual(observed.counts, counts(2, 0, 0, 1));
  assert.equal(observed.target.content, 'b');
  assert.equal(observed.target.status, 'pending');
  assert.deepEqual(observed.phaseSummaries.map(p => p.counts), [counts(1, 0, 0, 1), counts(1, 0, 0, 0)]);
});

test('later-current retention and all actual active tasks survive replay', () => {
  const phases = [phase('F', task('a', 'completed'), task('b')), phase('V', task('c', 'in_progress'))];
  assert.equal(projectNativeTodo([custom({ phases })]).target.content, 'c');
  const parallel = [phase('F', task('a', 'in_progress'), task('b', 'in_progress')), phase('V', task('c', 'in_progress'))];
  const observed = projectNativeTodo([custom({ phases: parallel })]);
  assert.deepEqual(observed.phases, parallel);
  assert.deepEqual(observed.counts, counts(0, 0, 3, 0));
  assert.equal(observed.target.content, 'a');
});

test('remove, reopen and append are replacements rather than historical merging', () => {
  const stages = [
    [phase('V', task('c', 'completed'))],
    [phase('V', task('c'))],
    [phase('V', task('c'), task('d', 'abandoned'))],
  ];
  const branch = [custom({ phases: base })];
  for (const phases of stages) {
    branch.push(custom({ phases }));
    assert.deepEqual(projectNativeTodo(branch).phases, phases);
  }
  assert.deepEqual(projectNativeTodo(branch).counts, counts(0, 1, 0, 1));
});

test('empty phase shells and dropped work retain honest counts', () => {
  const observed = projectNativeTodo([custom({ phases: [
    phase('Empty'), phase('Dropped', task('x', 'abandoned'), task('y', 'cancelled')),
  ] })]);
  assert.deepEqual(observed.counts, counts(0, 2, 0, 0));
  assert.deepEqual(observed.phaseSummaries[0].counts, counts(0, 0, 0, 0));
});

test('display keys distinguish repeated phase/content occurrences without native IDs', () => {
  const phases = [phase('Same', task('x'), task('x')), phase('Same', task('x'))];
  const observed = projectNativeTodo([custom({ phases })]);
  const keys = observed.phaseSummaries.flatMap(p => p.taskKeys);
  assert.equal(new Set(keys).size, 3);
  assert.equal(new Set(observed.phaseSummaries.map(p => p.key)).size, 2);
  assert.deepEqual(observed.phases, phases);
  assert.ok(observed.phases.every(p => p.tasks.every(t => !Object.hasOwn(t, 'id'))));
  assert.deepEqual(projectNativeTodo([custom({ phases })]).phaseSummaries, observed.phaseSummaries);
});

test('projection never mutates input and caller mutations do not alter native values', () => {
  const branch = [custom({ phases: structuredClone(base), ask: { ...ask } })];
  const before = structuredClone(branch);
  const observed = projectNativeTodo(branch);
  observed.phases[0].tasks[0].status = 'completed';
  observed.ask.text = 'Changed locally';
  assert.deepEqual(branch, before);
});

test('scope epoch advances only on explicit rebase; leaf revisions stay independent', () => {
  const reader = createNativeTodoProjection();
  assert.equal(reader.snapshot.scopeEpoch, 0);
  assert.equal(reader.snapshot.availability, 'waiting');
  const epoch = reader.rebase({ sessionId: 'fixture-session', branchId: 'fixture-root' });
  assert.equal(epoch, 1);
  assert.equal(reader.observe({ scopeEpoch: epoch, leafRevision: 'leaf-a', branch: [custom({ phases: base })] }), true);
  const snapshot = reader.snapshot;
  assert.equal(reader.observe({ scopeEpoch: epoch, leafRevision: 'leaf-a', branch: [custom({ phases: base })] }), false);
  assert.deepEqual(reader.snapshot, snapshot);
  assert.equal(reader.observe({ scopeEpoch: epoch, leafRevision: 'leaf-b', branch: [custom({ phases: base }), { type: 'compaction' }] }), true);
  assert.equal(reader.snapshot.scopeEpoch, 1);
  assert.equal(reader.snapshot.leafRevision, 'leaf-b');
  assert.deepEqual(reader.snapshot.phases, base);
  const changed = [custom({ phases: [] })];
  assert.equal(reader.observe({ scopeEpoch: epoch, leafRevision: 'leaf-b', branch: changed }), true);
  assert.equal(reader.snapshot.availability, 'empty');
});

test('start, tree, fork and rebind clear caches and reject late old-scope observations', () => {
  const reader = createNativeTodoProjection();
  let epoch = reader.rebase({ sessionId: 'fixture-session', branchId: 'root' });
  reader.observe({ scopeEpoch: epoch, leafRevision: 'old', branch: [custom({ phases: base })] });
  for (const branchId of ['tree', 'fork', 'reload', 'resume']) {
    const old = epoch;
    epoch = reader.rebase({ sessionId: 'fixture-session', branchId });
    assert.equal(epoch, old + 1);
    assert.equal(reader.snapshot.availability, 'waiting');
    assert.deepEqual(reader.snapshot.phases, []);
    assert.equal(reader.snapshot.leafRevision, null);
    assert.equal(reader.observe({ scopeEpoch: old, leafRevision: 'late', branch: [custom({ phases: base })] }), false);
    reader.observe({ scopeEpoch: epoch, leafRevision: 'new', branch: [
      { type: 'custom', customType: 'compaction.todo-snapshot', data: { phases: base } },
      { type: 'custom', customType: 'compaction.todo-restore-request', data: { phases: base } },
    ] });
    assert.deepEqual(reader.snapshot.phases, []);
    assert.equal(reader.snapshot.availability, 'waiting');
  }
});

test('branch-only getter never requests whole-file siblings or mutates session', () => {
  const reader = createNativeTodoProjection();
  const epoch = reader.rebase({ sessionId: 'fixture-session' });
  let reads = 0;
  const session = {
    getBranch() { reads++; return [custom({ phases: [] })]; },
    getLeafId() { return 'selected-leaf'; },
    getEntries() { throw new Error('must not scan siblings'); },
    appendCustomEntry() { throw new Error('must not write'); },
  };
  reader.read(session, epoch);
  assert.equal(reads, 1);
  assert.equal(reader.snapshot.availability, 'empty');
  reader.rebase({ sessionId: 'new-session' });
  assert.equal(reader.read(session, epoch), false);
  assert.equal(reads, 1, 'stale reads must be rejected before invoking a getter');
});

test('snapshot and scope copies cannot poison the read-only cache', () => {
  const scope = { sessionId: 'fixture-session', branchId: 'fixture-root' };
  const reader = createNativeTodoProjection();
  const epoch = reader.rebase(scope);
  reader.observe({ scopeEpoch: epoch, branch: [custom({ phases: base })], leafRevision: 1 });
  scope.sessionId = 'changed';
  const snapshot = reader.snapshot;
  snapshot.phases.length = 0;
  snapshot.scope.sessionId = 'changed';
  assert.deepEqual(reader.snapshot.phases, base);
  assert.equal(reader.snapshot.scope.sessionId, 'fixture-session');
});
