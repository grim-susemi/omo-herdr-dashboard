// Dashboard controllers driven against the calibrated split-tree fake Herdr
// (test/helpers/split-tree-herdr.mjs). The real TodoPane and FixedDagPane
// control flow runs and, when managed, a real parent-slot actor records every
// native mutation. As in registeredRecoveryFixture (test/managed-layout.test.mjs)
// only viewer launches and native process rows are synthetic: one shell per
// pane, one viewer per launched role.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixedDagPane } from '../../packages/dag/src/controller.mjs';
import { TodoPane } from '../../packages/todo/src/controller.mjs';
import { claimParentSlot } from '../../packages/todo/src/parent-slot.mjs';
import { writeJson } from '../../packages/dag/src/storage.mjs';
import { createSplitTreeHerdr } from './split-tree-herdr.mjs';

export const NATIVE_MUTATIONS = ['split', 'swap', 'close', 'resize', 'focus', 'run', 'move'];

export async function readRecord(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// events: serve the Herdr layout.updated subscription on the socket path so the
// Todo controller's membership/geometry watcher runs for real.
// sessionId: the conversation; restart({ sessionId }) models a conversation change.
// generation: the install generation of the viewer paths; restart({ generation })
// models an install-generation upgrade that relaunches the live viewers.
// hooks.before(args): runs before every native call; a throw is that call's reply.
// hooks.after(args): runs after every native call took effect, before its reply.
// display: { ui, getBranch, getLeafId } runs the Todo controller's real start()
// instead of the presence and bridge fakes: the real presence pipe, readiness
// adapter and display bridge (over display.ui) and the parent-slot claim start()
// makes. restart() then stops the controller as a reload does.
export async function createBandDashboard({ width = 172, height = 46, managed = true, events = false,
  sessionId = 'session', generation: installed = '000004', display } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-band-'));
  const socketPath = join(directory, 'herdr-socket');
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const calls = [], warnings = [], actors = [], controllers = [], hooks = {};
  const shellRow = pid => ({ ProcessId: pid, ParentProcessId: 1, Birth: `shell-${pid}`, ExecutablePath: 'shell',
    CommandLine: 'shell', CreationDate: '2026-10-13T00:00:00.000Z' });
  const producerRow = { ProcessId: process.pid, ParentProcessId: 100, Birth: 'producer-birth',
    ExecutablePath: 'node', CommandLine: 'node controller', CreationDate: '2026-10-14T00:00:00.000Z' };
  const panes = new Map([['parent', { shell: shellRow(100) }]]);
  let fake = createSplitTreeHerdr({ tree: 'parent', area: { x: 0, y: 0, width, height }, focused: 'parent' });
  let serial = 0, authority = false, todo, dag, actor, server, peer, session = sessionId, generation = installed;
  let arrangements = 0;
  const subscribed = Promise.withResolvers();
  const inspectShell = async pid => {
    if (pid === process.pid) return [producerRow];
    const pane = [...panes.values()].find(value => value.shell.ProcessId === pid);
    return pane ? [pane.shell, ...(pane.viewer ? [pane.viewer] : [])] : [];
  };
  const herdr = async (...args) => {
    calls.push({ args, authority });
    await hooks.before?.(args);
    if (args[0] === 'process-info') {
      const paneId = args[args.indexOf('--pane') + 1];
      await fake.herdr('get', paneId);
      const { shell } = panes.get(paneId);
      return { process_info: { pane_id: paneId, shell_pid: shell.ProcessId,
        foreground_processes: [{ pid: shell.ProcessId, argv: ['shell'] }] } };
    }
    const result = await fake.herdr(...args);
    if (args[0] === 'split') panes.set(result.pane.pane_id, { shell: shellRow(2000 + ++serial) });
    if (args[0] === 'close') panes.delete(args[1]);
    await hooks.after?.(args);
    // A native effect that happened but whose reply was lost.
    if (hooks.lose?.(args)) throw Object.assign(new Error('transport completion lost'), { code: 'transport_error' });
    return result;
  };
  const launch = async (owner, record) => {
    await hooks.launch?.(record.role, 'before');
    const pane = panes.get(record.paneId), pid = 3000 + ++serial;
    const argv = [record.nodePath, record.viewerPath,
      ...(record.role === 'todo' ? [] : ['--view', record.role === 'dag' ? 'dag' : 'tasks']),
      '--state', record.statePath, '--close-pane', record.paneId, '--launch-token', record.launchToken];
    pane.viewer = { ProcessId: pid, ParentProcessId: pane.shell.ProcessId, Birth: `viewer-${pid}`,
      ExecutablePath: record.nodePath, CommandLine: argv.map(value => `"${value}"`).join(' '),
      CreationDate: '2026-10-14T00:00:00.000Z' };
    const ready = { ...record, processId: pid, viewerBirth: pane.viewer.Birth, ready: true };
    await writeJson(record.role === 'todo' ? owner.recordFile : owner.paneFile(record.role), ready);
    await writeJson(record.statePath, owner.roleState(ready));
    if (managed) {
      const target = record.role === 'todo' ? await todo.nativePane(record.paneId, ready) : await dag.nativeTarget(ready);
      await actor.registerRole(actor.capability(record.role === 'todo' ? 'todo' : 'dag', record.role), target);
    }
    if (record.role === 'todo') todo.ownedRoles.set('todo', ready);
    else dag.records.set(record.role, ready);
    await hooks.launch?.(record.role, 'after');
    return ready;
  };
  const createControllers = async () => {
    todo = new TodoPane({ managed, stateDir: join(directory, 'todo'), cwd: directory, herdr, inspectShell,
      environment: { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: 'parent' },
      ctx: { ...(display && { hasUI: true, mode: 'tui', ui: display.ui }), sessionManager: { getSessionId: () => session,
        getSessionFile: () => join(directory, `${session}.jsonl`),
        ...(display && { getBranch: display.getBranch, getLeafId: display.getLeafId }) } },
      node: 'node', viewer: join(directory, `generation-${generation}`, 'todo', 'viewer.mjs'),
      // A verified viewer retirement: the viewer exits and leaves its shell.
      retireViewer: async record => { delete panes.get(record.paneId).viewer; return { manual: false }; },
      notify: message => warnings.push(message) });
    dag = new FixedDagPane({ managedAvailable: managed, stateDir: join(directory, 'dag'), cwd: directory,
      socket: socketPath, parentPane: 'parent', sessionId: session, node: 'node', herdr, inspectShell,
      viewer: join(directory, `generation-${generation}`, 'dag', 'viewer.mjs'), notify: message => warnings.push(message) });
    controllers.push(todo, dag);
    todo.scopeEpoch = dag.scopeEpoch = 1;
    if (!display) {
      // Per conversation, like the real scope cache under the owner directory.
      todo.storage = { path: join(todo.directory, 'todo-cache.json') };
      todo.presence = { events: new EventEmitter(), offer: role => ({ v: 1, ...todo.binding, role, scopeEpoch: 1 }),
        rotateRole: role => ({ v: 1, ...todo.binding, role, scopeEpoch: 1 }), idle: async () => {}, close: async () => {} };
      todo.bridge = { invalidate() {}, readinessChanged() {}, remove() {} };
    }
    if (!events) todo.watchRecoveryMembership = async () => {};
    todo.publishCustodyBinding = async () => {};
    todo.holdRoleViewer = async () => {};
    dag.sourceSaved();
    // With a display the role state files carry the real presence offers to the viewers.
    if (!display) dag.save = async () => {};
    todo.provider = dag.provider();
    dag.coordinator = todo.coordinator();
    // Like the production dispatcher: the authorization is the last await before the native call.
    if (managed) todo.mutate = (role, type, target, args, effect, beforeSubmit, check) => todo.perform(role, type, target, async ({ authorize }) => {
      const decide = await authorize();
      decide();
      authority = true;
      try { return { result: await herdr(...args), effects: Promise.resolve() }; } finally { authority = false; }
    }, check);
    todo.launchTodo = async record => (await launch(todo, record)).paneId;
    dag.launchRole = record => launch(dag, record);
    // The real start() saves each source before scheduling; discovery needs the directories.
    await mkdir(todo.directory, { recursive: true });
    await mkdir(dag.directory, { recursive: true });
    if (display) {
      await todo.start();
      if (!managed) return;
      actor = todo.actor;
      actors.push(actor);
      dag.managedActor = actor;
      await actor.join('dag', dag.lifetimeId);
      return;
    }
    if (!managed) return;
    const observed = await todo.observeManaged({});
    actor = await claimParentSlot({ stateDir: join(directory, 'owner'), socketPath, ...observed,
      sessionId: session, observe: request => todo.observeManaged(request) });
    actors.push(actor);
    todo.actor = actor; dag.managedActor = actor;
    await actor.join('todo', todo.lifetimeId); await actor.join('dag', dag.lifetimeId);
    todo.publisherScope = { ownerNonce: actor.snapshot.ownerNonce, generation: actor.snapshot.generation,
      sessionId: session, lifetimeId: todo.lifetimeId, parent: observed.parent, producer: observed.producer };
    todo.claimRetired = actor.snapshot.generation > 1;
  };
  if (events) {
    server = net.createServer(socket => {
      peer = socket;
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
          if (message.method !== 'events.subscribe') continue;
          socket.write(`${JSON.stringify({ id: message.id, result: { type: 'subscription_started' } })}\n`);
          subscribed.resolve();
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  }
  // The parent slot canonicalizes a filesystem socket path, so it must exist.
  if (process.platform === 'win32' || !events) await writeFile(socketPath, '');
  await createControllers();
  return {
    directory, calls, warnings, hooks, subscribed: subscribed.promise,
    get todo() { return todo; }, get dag() { return dag; }, get actor() { return actor; }, get fake() { return fake; },
    layout: () => fake.layout(),
    mutations: () => calls.filter(call => NATIVE_MUTATIONS.includes(call.args[0])),
    async ids() {
      const [todoRecord, workers, dagRecord] = await Promise.all([readRecord(todo.recordFile),
        readRecord(dag.paneFile('workers')), readRecord(dag.paneFile('dag'))]);
      return { parent: 'parent', todo: todoRecord?.paneId, workers: workers?.paneId, dag: dagRecord?.paneId };
    },
    async claimLayout() { return (await readRecord(todo.recordFile))?.layoutClaim?.layout; },
    rects(ids) {
      const { panes: rows } = fake.layout();
      return Object.fromEntries(Object.entries(ids).map(([role, id]) => {
        const rect = rows.find(pane => pane.pane_id === id)?.rect;
        return [role, rect && [rect.x, rect.y, rect.width, rect.height]];
      }));
    },
    // A pane that exits outside the dashboard (not a dashboard mutation).
    async exitPane(paneId) { await fake.herdr('close', paneId); panes.delete(paneId); },
    // A process the dashboard did not start replaces whatever runs in a pane's shell.
    foreignProcess(paneId) {
      const pane = panes.get(paneId), pid = 9000 + ++serial;
      pane.viewer = { ProcessId: pid, ParentProcessId: pane.shell.ProcessId, Birth: `foreign-${pid}`,
        ExecutablePath: 'foreign', CommandLine: 'foreign', CreationDate: '2026-10-15T00:00:00.000Z' };
    },
    // A terminal resize; modelled for the empty tab before the first split only.
    resize(area) {
      if (fake.panes().length !== 1) throw new Error('resize is modelled for an unsplit tab only');
      fake = createSplitTreeHerdr({ tree: 'parent', area: { x: 0, y: 0, ...area }, focused: 'parent' });
    },
    // A terminal resize of any tree: the splits keep their ratios (split-tree fake setArea).
    resizeTerminal(area) { fake.setArea({ x: 0, y: 0, ...area }); },
    // Fixture setup, not a dashboard mutation: the same panes placed in another
    // split tree, as an older generation or the owner may have left them.
    arrange(tree) {
      const next = createSplitTreeHerdr({ tree, area: fake.layout().area, focused: fake.focused(),
        idPrefix: `arranged${++arrangements}` });
      if (JSON.stringify(next.panes().sort()) !== JSON.stringify(fake.panes().sort()))
        throw new Error('arrange must place exactly the current panes');
      fake = next;
    },
    emitLayout() { peer.write(`${JSON.stringify({ event: 'layout_updated', data: { layout: fake.layout() } })}\n`); },
    // A controller restart after an interruption: the old lease is released
    // cooperatively and fresh controllers claim the same parent slot. A new
    // sessionId makes it a conversation change that keeps the live panes.
    async restart({ sessionId: next, generation: upgrade } = {}) {
      if (display) await todo.stop();
      else {
        const releasing = actor.release();
        await actor.drain('todo', todo.lifetimeId); await actor.drain('dag', dag.lifetimeId);
        await releasing;
      }
      if (next) session = next;
      if (upgrade) generation = upgrade;
      await createControllers();
    },
    async dispose() {
      // The real presence and control pipes close with the controller.
      try { if (display) await todo.stop(); } finally {
        for (const controller of controllers) controller.recoveryWatch?.socket?.destroy();
        peer?.destroy();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        for (const value of actors) if (value.db.isOpen) {
          if (value.db.isTransaction) value.db.exec('ROLLBACK');
          value.db.close();
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
