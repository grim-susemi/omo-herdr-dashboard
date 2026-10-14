import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeHost } from '../../src/native-host.mjs';
import { displayOwnerKey, installDisplayBridge } from '../../src/display-bridge.mjs';
import { DISPLAY_HOST_KEY } from './display-bridge-fixture.mjs';

test('product display bridge with actual builtin-first native tool/manual/lifecycle', async t => {
  const senpiRoot = process.env.OMO_HERDR_SENPI_ROOT;
  const parentRoot = process.env.OMO_HERDR_FIXTURE_ROOT;
  assert.ok(senpiRoot && parentRoot, 'run through the explicit test:host command');
  const fixtureRoot = join(parentRoot, 'display-task4');
  const cwd = join(fixtureRoot, 'cwd');
  const agentDir = join(fixtureRoot, 'agent');
  const tmp = join(fixtureRoot, 'tmp');
  for (const path of [cwd, agentDir, tmp]) mkdirSync(path, { recursive: true });
  const lifecycle = [];
  const ready = new Set();
  const published = [];
  let sequence = 0;
  let publicationFailure = false;
  let readFailure = false;
  let host;
  const fixture = {
    environment: { HERDR_SOCKET_PATH: 'native-host-fixture-socket', HERDR_PANE_ID: 'native-host-fixture-parent' },
    advance(ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      this.owner = { socketPath: this.environment.HERDR_SOCKET_PATH, parentPaneId: this.environment.HERDR_PANE_ID,
        sessionId, scopeEpoch: (this.owner?.scopeEpoch ?? 0) + 1 };
      this.owner.ownerKey = displayOwnerKey(this.owner.socketPath, this.owner.parentPaneId, sessionId);
    },
    adapter: {
      getOwner: () => fixture.owner,
      publish(snapshot) {
        if (publicationFailure) throw new Error('fixture publication rejected');
        published.push(snapshot);
        return { ...fixture.owner, sequence: ++sequence };
      },
      // Unit-scoped coverage supplied explicitly. No real IPC paint is claimed.
      isReady: binding => ready.has(binding.role),
      hasDagOwnedTasks: () => false,
    },
  };
  globalThis[DISPLAY_HOST_KEY] = fixture;
  function watchDispose(instance, name) {
    const original = instance.dispose;
    const record = { name, class: instance.constructor.name, disposalCount: 0 };
    lifecycle.push(record);
    // Exact test-instance instrumentation delegates the real native method.
    // No prototype/private renderer or product disposal path is replaced.
    instance.dispose = function () {
      record.disposalCount++;
      return original.call(this);
    };
    return record;
  }
  try {
    host = await createNativeHost({ senpiRoot, cwd, agentDir, home: fixtureRoot, tmp,
      extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), 'display-bridge-fixture.mjs')] });
    fixture.host = host;
    await host.toolAction({ op: 'init', list: [{ phase: 'F', items: ['Native first', 'Native later'] }] });
    const seededLeaf = host.session.getLeafId();
    await host.emitSessionStart();
    const ui = host.runner.getUIContext();

    await t.test('startup rendered before regular addon; initially no native capture', () => {
      assert.ok(host.extensions[0].path.startsWith('<builtin:'));
      assert.ok(host.extensions[1].path.endsWith('display-bridge-fixture.mjs'));
      assert.equal(fixture.startupWidget.constructor.name, 'TodoWidgetComponent');
      assert.equal(host.surface.nativeWidget(), fixture.startupWidget);
      assert.ok(fixture.startupCalls >= 2);
      assert.ok(fixture.bridge);
      assert.equal(fixture.bridge.captured('todo-sidebar'), undefined);
      assert.equal(fixture.bridge.snapshot.counts.total, 2);
      assert.equal(fixture.bridge.snapshot.sourceEntryId, seededLeaf);
    });

    await t.test('startup mask disposes native; closure restores current labelled recovery at same key', () => {
      const native = host.surface.nativeWidget();
      const record = watchDispose(native, 'startup-native');
      ready.add('todo');
      fixture.bridge.readinessChanged();
      assert.equal(host.surface.nativeWidget(), undefined);
      assert.equal(record.disposalCount, 1);
      ready.clear();
      fixture.bridge.readinessChanged();
      const recovery = host.surface.nativeWidget();
      const rendered = recovery.render(160).join('\n');
      assert.ok(rendered.includes('owned Todo recovery'));
      assert.ok(rendered.includes('not native renderer'));
      assert.ok(rendered.includes('in_progress: Native first'));
      assert.ok(rendered.includes('pending: Native later'));
      assert.ok(rendered.includes('0/2 closed'));
      assert.equal(fixture.bridge.captured('todo-sidebar'), undefined);
      assert.deepEqual(host.surface.widgetKeys(), ['todo-sidebar']);
    });

    let toolLeaf;
    await t.test('actual tool commit while masked captures native factory and updates projection', async () => {
      const recovery = host.surface.nativeWidget();
      ready.add('todo');
      fixture.bridge.readinessChanged();
      assert.deepEqual(recovery.render(160), [], 'mask used actual host disposal path');
      const before = host.session.getLeafId();
      const output = await host.toolAction({ op: 'done', task: 'Native first' });
      toolLeaf = host.session.getLeafId();
      assert.notEqual(toolLeaf, before);
      assert.equal(host.calls.at(-1).function, 'stock registered todo.definition.execute');
      assert.equal(host.surface.nativeWidget(), undefined);
      assert.equal(fixture.bridge.snapshot.counts.closed, 1);
      assert.equal(fixture.bridge.snapshot.target.content, 'Native later');
      assert.equal(fixture.bridge.snapshot.sourceEntryId, toolLeaf);
      assert.equal(published.at(-1).sourceEntryId, toolLeaf);
      assert.equal(typeof fixture.bridge.captured('todo-sidebar').content, 'function');
      assert.ok(output.content[0].text.includes('Native first'));
      const capture = fixture.bridge.captured('todo-sidebar');
      assert.equal(host.surface.nativeCalls.at(-2).content, capture.content);
      assert.equal(host.surface.nativeCalls.at(-1).content, undefined);
    });

    await t.test('closure uses captured native factory, never disposed instance; animation is closed', () => {
      const factory = fixture.bridge.captured('todo-sidebar').content;
      ready.clear();
      fixture.bridge.readinessChanged();
      const native = host.surface.nativeWidget();
      const record = watchDispose(native, 'captured-native');
      const model = structuredClone(native.model);
      assert.equal(native.constructor.name, 'TodoWidgetComponent');
      assert.equal(host.surface.nativeCalls.at(-1).content, factory);
      ready.add('todo');
      fixture.bridge.readinessChanged();
      assert.equal(record.disposalCount, 1);
      assert.equal(native.intervalId, undefined);
      ready.clear();
      fixture.bridge.readinessChanged();
      const fresh = host.surface.nativeWidget();
      assert.notEqual(fresh, native);
      assert.deepEqual(fresh.model, model);
      assert.equal(host.surface.nativeCalls.at(-1).content, factory);
      assert.ok(!fresh.render(160).join('\n').includes('owned Todo recovery'));
    });

    await t.test('actual manual callback commits user entry while masked without changing reminders/notices', async () => {
      ready.add('todo');
      fixture.bridge.readinessChanged();
      const before = host.session.getLeafId();
      const messages = host.messages.length;
      const notes = host.surface.notes.length;
      await host.commandAction('append F manual task4 item');
      assert.notEqual(host.session.getLeafId(), before);
      assert.equal(host.calls.at(-1).function, 'ExtensionRunner.getCommand(todo).handler');
      assert.equal(host.session.getBranch().at(-1).data.source, 'user');
      assert.equal(fixture.bridge.snapshot.counts.total, 3);
      assert.equal(fixture.bridge.snapshot.phases[0].tasks.at(-1).content, 'Manual task4 item');
      assert.equal(host.surface.nativeWidget(), undefined);
      assert.equal(typeof fixture.bridge.captured('todo-sidebar').content, 'function');
      assert.equal(host.messages.length, messages + 1);
      assert.equal(host.messages.at(-1).message.customType, 'todotools.user-edit');
      assert.equal(host.messages.at(-1).options.triggerTurn, false);
      assert.equal(host.surface.notes.length, notes + 1);
    });

    await t.test('unrelated widget and editor dialog delegate; cancelled manual edit does not mutate', async () => {
      const array = ['unrelated actual host widget'];
      const options = { placement: 'belowEditor' };
      ui.setWidget('task4-unrelated', array, options);
      const call = host.surface.nativeCalls.at(-1);
      assert.equal(call.content, array);
      assert.equal(call.options, options);
      assert.equal(host.surface.surface.extensionWidgetsBelow.has('task4-unrelated'), true);
      const before = host.session.getLeafId();
      host.surface.setEditorResult(undefined);
      await host.commandAction('edit');
      assert.equal(host.session.getLeafId(), before);
      host.surface.setEditorResult('# F\n- [x] Native first\n- [ ] Edited native manual');
      await host.commandAction('edit');
      assert.notEqual(host.session.getLeafId(), before);
      assert.equal(fixture.bridge.snapshot.phases[0].tasks[1].content, 'Edited native manual');
      assert.equal(host.surface.nativeWidget(), undefined);
    });

    await t.test('failed publication and native read error restore visibility and do not poison tool', async () => {
      publicationFailure = true;
      await host.commandAction('append F publication failure item');
      assert.equal(host.surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
      assert.deepEqual(fixture.bridge.status.masked, []);
      publicationFailure = false;
      fixture.bridge.readinessChanged();
      assert.equal(host.surface.nativeWidget(), undefined);

      const context = host.runner.createContext();
      const originalRead = context.sessionManager.getBranch;
      // The public reader facade itself is test-instrumented; actual native
      // producer/session manager are unchanged.
      const manager = context.sessionManager;
      const failingContext = { hasUI: context.hasUI, mode: context.mode, ui: context.ui, sessionManager: {
        getSessionFile: () => manager.getSessionFile(),
        getSessionId: () => manager.getSessionId(),
        getLeafId: () => manager.getLeafId(),
        getBranch: () => { if (readFailure) throw new Error('fixture read failed'); return originalRead.call(manager); },
      } };
      readFailure = true;
      fixture.bridge.observe({ type: 'agent_end' }, failingContext);
      assert.ok(host.surface.nativeWidget());
      assert.deepEqual(fixture.bridge.status.masked, []);
      readFailure = false;
      fixture.bridge.observe({ type: 'agent_end' }, context);
      const leaf = host.session.getLeafId();
      const state = host.snapshotState();
      await assert.rejects(host.toolAction({ op: 'start', task: 'missing task4 item' }));
      assert.equal(host.session.getLeafId(), leaf);
      assert.deepEqual(host.readState(), state);
      const output = await host.toolAction({ op: 'view' });
      assert.ok(output.content[0].text.length > 0);
      assert.equal(host.session.getLeafId(), leaf);
    });

    await t.test('real original setter rejects a factory without poisoned capture or tool execution', async () => {
      ready.add('todo');
      fixture.bridge.readinessChanged();
      const capture = fixture.bridge.captured('todo-sidebar');
      const rejected = () => { throw new Error('task4 rejected original factory'); };
      assert.doesNotThrow(() => ui.setWidget('todo-sidebar', rejected));
      assert.equal(fixture.bridge.captured('todo-sidebar'), capture);
      assert.equal(host.surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
      assert.deepEqual(fixture.bridge.status.masked, []);
      await host.commandAction('append F after setter rejection');
      assert.equal(host.calls.at(-1).committed, true);
      assert.equal(host.surface.nativeWidget(), undefined);
      assert.ok(fixture.bridge.failures.some(failure => failure.boundary === 'native-setter'));
    });

    await t.test('populated child rejects before UI and owner; foreign readiness leaves native visible', () => {
      const setter = ui.setWidget;
      const noAccess = () => { throw new Error('forbidden access'); };
      assert.equal(installDisplayBridge({
        sessionManager: { getSessionFile: () => 'fixture/senpi-task/children/child/session.jsonl' },
        get hasUI() { return noAccess(); }, get ui() { return noAccess(); },
      }, { getOwner: noAccess }), undefined);
      assert.equal(ui.setWidget, setter);
      ready.clear();
      fixture.bridge.readinessChanged();
      assert.equal(host.surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
      const isReady = fixture.adapter.isReady;
      fixture.adapter.isReady = () => false; // task5 rejects foreign coverage
      ready.add('todo');
      fixture.bridge.readinessChanged();
      assert.equal(host.surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
      fixture.adapter.isReady = isReady;
    });

    await t.test('actual before-tree/tree lifecycle rereads selected historical branch and rebases', async () => {
      await host.runner.emit({ type: 'session_before_tree', preparation: {
        targetId: seededLeaf, oldLeafId: host.session.getLeafId(), entriesToSummarize: [], userWantsSummary: false,
      }, signal: new AbortController().signal });
      const epoch = fixture.bridge.status.owner.scopeEpoch;
      host.session.branch(seededLeaf);
      await host.runner.emit({ type: 'session_tree', newLeafId: seededLeaf, oldLeafId: toolLeaf, fromExtension: true });
      assert.equal(fixture.bridge.status.owner.scopeEpoch, epoch + 1);
      assert.equal(fixture.bridge.snapshot.counts.total, 2);
      assert.equal(fixture.bridge.snapshot.counts.closed, 0);
      assert.equal(fixture.bridge.snapshot.sourceEntryId, seededLeaf);
      assert.equal(fixture.bridge.captured('todo-sidebar'), undefined, 'builtin-first tree factory is not falsely captured in old scope');
      ready.clear();
      fixture.bridge.readinessChanged();
      assert.ok(host.surface.nativeWidget().render(160).join('\n').includes('owned Todo recovery'));
    });

    await t.test('unload preserves same-key honest recovery, later native command replaces it; clear disposes', async () => {
      ready.add('todo');
      fixture.bridge.readinessChanged();
      fixture.bridge.remove();
      const originalSetter = ui.setWidget;
      const recovery = host.surface.nativeWidget();
      assert.ok(recovery.render(160).join('\n').includes('owned Todo recovery'));
      await host.commandAction('append F after unload');
      assert.equal(ui.setWidget, originalSetter);
      assert.equal(host.surface.nativeWidget().constructor.name, 'TodoWidgetComponent');
      assert.deepEqual(recovery.render(160), []);
      assert.equal(host.surface.widgetKeys().filter(key => key === 'todo-sidebar').length, 1);
      const native = host.surface.nativeWidget();
      const record = watchDispose(native, 'after-unload-native');
      await host.commandAction('rm');
      assert.equal(host.surface.nativeWidget(), undefined);
      assert.equal(record.disposalCount, 1);
      assert.deepEqual(host.readState().phases, []);
      assert.equal(host.surface.surface.extensionWidgetsBelow.has('task4-unrelated'), true);
    });
    assert.deepEqual(host.errors, []);
  } finally {
    fixture.bridge?.remove();
    fixture.unbind?.();
    host?.close();
    delete globalThis[DISPLAY_HOST_KEY];
    rmSync(fixtureRoot, { recursive: true, force: true });
    console.log('DISPLAY_BRIDGE_RESULT_BEGIN');
    console.log(JSON.stringify({ schema: 'omo-herdr-todo/display-host/1', testPid: process.pid, lifecycle,
      source: 'Actual builtin-first ResourceLoader, registered Todo tool/manual callback, real InteractiveMode setter/disposal',
      nativeCalls: host?.calls.map(call => ({ function: call.function, entry: call.entry, committed: call.before !== call.entry })),
      publishedSnapshots: published.length, failures: fixture.bridge?.failures,
      widgetsAfterClose: host?.surface.widgetCount(), disposed: fixture.bridge?.status.disposed,
      environment: 'Explicit fixture Herdr identity; no actual Herdr pane/IPC readiness claimed',
      providerCalls: 0, listenerCleanup: true, fixtureRoot }, null, 2));
    console.log('DISPLAY_BRIDGE_RESULT_END');
  }
});

test('host replay: worker and DAG lines are masked without a native Todo, restored when readiness is lost', async () => {
  const senpiRoot = process.env.OMO_HERDR_SENPI_ROOT;
  const parentRoot = process.env.OMO_HERDR_FIXTURE_ROOT;
  assert.ok(senpiRoot && parentRoot, 'run through the explicit test:host command');
  const fixtureRoot = join(parentRoot, 'display-task3');
  const cwd = join(fixtureRoot, 'cwd');
  const agentDir = join(fixtureRoot, 'agent');
  const tmp = join(fixtureRoot, 'tmp');
  for (const path of [cwd, agentDir, tmp]) mkdirSync(path, { recursive: true });
  const ready = new Set();
  let sequence = 0;
  let host;
  const fixture = {
    environment: { HERDR_SOCKET_PATH: 'native-host-fixture-socket', HERDR_PANE_ID: 'native-host-fixture-parent' },
    advance(ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      this.owner = { socketPath: this.environment.HERDR_SOCKET_PATH, parentPaneId: this.environment.HERDR_PANE_ID,
        sessionId, scopeEpoch: (this.owner?.scopeEpoch ?? 0) + 1 };
      this.owner.ownerKey = displayOwnerKey(this.owner.socketPath, this.owner.parentPaneId, sessionId);
    },
    adapter: {
      getOwner: () => fixture.owner,
      publish: () => ({ ...fixture.owner, sequence: ++sequence }),
      isReady: binding => ready.has(binding.role),
      hasDagOwnedTasks: () => false,
    },
  };
  globalThis[DISPLAY_HOST_KEY] = fixture;
  try {
    host = await createNativeHost({ senpiRoot, cwd, agentDir, home: fixtureRoot, tmp,
      extensionPaths: [join(dirname(fileURLToPath(import.meta.url)), 'display-bridge-fixture.mjs')] });
    fixture.host = host;
    // No todo tool call: the branch has no native Todo.
    await host.emitSessionStart();
    const ui = host.runner.getUIContext();
    const below = () => host.surface.surface.extensionWidgetsBelow;
    assert.equal(fixture.bridge.snapshot.availability, 'waiting');
    assert.equal(host.surface.nativeWidget(), undefined);

    // The exact call shape the OmO plugin uses for its worker line.
    const lines = ['running worker line'];
    ui.setWidget('omo-task', lines, { placement: 'belowEditor' });
    assert.equal(below().has('omo-task'), true, 'visible until readiness is proven');
    assert.deepEqual(fixture.bridge.status.masked, []);

    ready.add('workers');
    fixture.bridge.readinessChanged();
    assert.deepEqual(fixture.bridge.status.masked, ['omo-task']);
    assert.equal(below().has('omo-task'), false);

    ready.clear();
    fixture.bridge.readinessChanged();
    assert.deepEqual(fixture.bridge.status.masked, []);
    assert.equal(host.surface.nativeCalls.at(-1).content, lines);
    assert.equal(host.surface.nativeCalls.at(-1).options.placement, 'belowEditor');
    assert.deepEqual(below().get('omo-task').render(80).map(row => row.trim()).filter(Boolean), lines);

    ready.add('workers');
    fixture.bridge.readinessChanged();
    assert.deepEqual(fixture.bridge.status.masked, ['omo-task']);
    assert.equal(below().has('omo-task'), false);
    assert.deepEqual(host.errors, []);
  } finally {
    fixture.bridge?.remove();
    fixture.unbind?.();
    host?.close();
    delete globalThis[DISPLAY_HOST_KEY];
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
