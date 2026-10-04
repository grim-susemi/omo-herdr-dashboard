// Minimal, public-safe native host harness around the real Senpi SDK.
//
// The harness builds a real DefaultResourceLoader final extension set (stock
// builtin Todo first), a real in-memory SessionManager, a real ExtensionRunner
// and a bounded InteractiveMode component surface. Native tool and command
// callbacks are invoked exactly as registered; nothing is patched, reordered,
// mocked or copied. No PTY, IPC, provider call or evidence writer lives here.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { assertSenpiVersion, loadNativeModules, resolveSenpiRoot } from './senpi-root.mjs';

export const WIDGET_KEY = 'todo-sidebar';
export const BUILTIN_TODO_PATH_PREFIX = '<builtin:';

const ENVIRONMENT_KEYS = [
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR',
];

/**
 * Point a fixture host at fixture roots and hide the owner's pane environment.
 * Returns the restore function; the caller owns the lifetime.
 */
export function applyHostEnvironment({ home, tmp, agentDir }) {
  const saved = {};
  for (const key of ENVIRONMENT_KEYS) saved[key] = process.env[key];
  const stripped = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HERDR_')) {
      stripped[key] = process.env[key];
      delete process.env[key];
    }
  }
  if (home) {
    Object.assign(process.env, {
      HOME: home, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: join(home, '.appdata'), LOCALAPPDATA: join(home, '.localappdata'),
      XDG_CONFIG_HOME: join(home, '.xdg/config'), XDG_DATA_HOME: join(home, '.xdg/data'),
      XDG_CACHE_HOME: join(home, '.xdg/cache'),
    });
  }
  if (tmp) Object.assign(process.env, { TEMP: tmp, TMP: tmp });
  if (agentDir) {
    Object.assign(process.env, {
      OMO_CODING_AGENT_DIR: agentDir, SENPI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir,
    });
  }
  return {
    saved,
    stripped,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const [key, value] of Object.entries(stripped)) process.env[key] = value;
    },
  };
}

/** A fixture agent dir must have no extensions directory of its own. */
export function assertFixtureRoots({ cwd, agentDir }) {
  if (typeof cwd !== 'string' || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`fixture cwd must be an existing directory: ${String(cwd)}`);
  }
  if (typeof agentDir !== 'string' || !existsSync(agentDir) || !statSync(agentDir).isDirectory()) {
    throw new Error(`fixture agent dir must be an existing directory: ${String(agentDir)}`);
  }
  const discovered = join(agentDir, 'extensions');
  if (existsSync(discovered)) {
    throw new Error(`fixture agent dir must not discover user extensions: ${discovered}`);
  }
}

/**
 * Bounded InteractiveMode component surface: real createExtensionUIContext,
 * real setWidget storage, real clearExtensionWidgets. Widget calls are recorded
 * before delegation, and the original setter is kept for restoration checks.
 */
export function createComponentSurface({ InteractiveMode }) {
  const surface = Object.create(InteractiveMode.prototype);
  surface.extensionWidgetsAbove = new Map();
  surface.extensionWidgetsBelow = new Map();
  const nativeCalls = [];
  const notes = [];
  let renderRequests = 0;
  let editorResult;
  surface.ui = { requestRender() { renderRequests++; } };
  surface.showExtensionNotify = (...args) => notes.push(args);
  surface.withBlockedHostDialog = (_id, _title, action) => action();
  surface.showExtensionEditor = async () => editorResult;
  const ui = surface.createExtensionUIContext();
  const originalSetter = ui.setWidget;
  ui.setWidget = function setWidget(key, content, options) {
    nativeCalls.push({ key, content, options, shape: Array.isArray(content) ? 'array' : typeof content });
    return originalSetter.call(this, key, content, options);
  };
  return {
    surface,
    ui,
    nativeCalls,
    notes,
    originalSetter,
    setEditorResult(value) { editorResult = value; },
    renderRequests() { return renderRequests; },
    nativeWidget(key = WIDGET_KEY) { return surface.extensionWidgetsAbove.get(key); },
    widgetKeys() { return [...surface.extensionWidgetsAbove.keys(), ...surface.extensionWidgetsBelow.keys()]; },
    widgetCount() { return surface.extensionWidgetsAbove.size + surface.extensionWidgetsBelow.size; },
    clearWidgets() {
      if (typeof surface.clearExtensionWidgets === 'function') surface.clearExtensionWidgets();
      else { surface.extensionWidgetsAbove.clear(); surface.extensionWidgetsBelow.clear(); }
    },
  };
}

export async function createNativeHost(options) {
  const {
    senpiRoot, cwd, agentDir, home, tmp,
    extensionPaths = [], builtinExtensions = ['todowrite'],
    isolateEnvironment = true, theme = 'dark', expectedVersion = null,
  } = options ?? {};
  if (!cwd || !agentDir) {
    throw new Error('createNativeHost requires explicit fixture cwd and agentDir; no implicit host path is used.');
  }
  const info = resolveSenpiRoot(senpiRoot);
  const native = await loadNativeModules(info.root);
  if (expectedVersion) assertSenpiVersion(native.info, expectedVersion);
  assertFixtureRoots({ cwd, agentDir });
  const environment = isolateEnvironment ? applyHostEnvironment({ home: home ?? cwd, tmp: tmp ?? cwd, agentDir }) : null;
  native.initTheme(theme, false);
  const session = native.SessionManager.inMemory(cwd);
  const loader = new native.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: native.SettingsManager.inMemory({ enabledBuiltinExtensions: builtinExtensions }),
  });
  const messages = [];
  const errors = [];
  const calls = [];
  const runners = [];
  let extensions = [];
  let runtime = null;
  let runner = null;
  let surface = null;
  let nativeExtension = null;
  let tool = null;

  async function loadFinalExtensionSet(paths = extensionPaths) {
    const result = await loader.loadFinalExtensionSet(paths);
    if (!Array.isArray(result.errors) || result.errors.length > 0) {
      throw new Error(`native loadFinalExtensionSet reported errors: ${JSON.stringify(result.errors)}`);
    }
    extensions = result.extensions;
    runtime = result.runtime;
    runtime.appendEntry = (type, data) => {
      const id = session.appendCustomEntry(type, data);
      calls.push({ function: 'SessionManager.appendCustomEntry', type, entry: id });
      return id;
    };
    runtime.sendMessage = (message, messageOptions) => messages.push({ message, options: messageOptions });
    nativeExtension = extensions.find(extension =>
      typeof extension.path === 'string' && extension.path.startsWith(BUILTIN_TODO_PATH_PREFIX) &&
      extension.tools?.has?.('todo')) ?? extensions.find(extension => extension.tools?.has?.('todo')) ?? null;
    tool = nativeExtension?.tools?.get?.('todo')?.definition ?? null;
    return result;
  }

  function bindRunner() {
    surface = createComponentSurface({ InteractiveMode: native.InteractiveMode });
    runner = new native.ExtensionRunner(extensions, runtime, cwd, session, {});
    runner.setUIContext(surface.ui, 'tui');
    runner.onError(error => errors.push(error));
    runners.push(runner);
    return runner;
  }

  const host = {
    info,
    native,
    session,
    loader,
    messages,
    errors,
    calls,
    runners,
    get extensions() { return extensions; },
    get runner() { return runner; },
    get surface() { return surface; },
    get ui() { return surface?.ui ?? null; },
    get nativeExtension() { return nativeExtension; },
    get tool() { return tool; },
    loadFinalExtensionSet,
    bindRunner,
    readState() { return native.getLatestTodoStateFromBranchEntries(session.getBranch()); },
    snapshotState() { return structuredClone(this.readState()); },
    async emitSessionStart() { await runner.emit({ type: 'session_start' }); },
    async toolAction(params) {
      if (!tool) throw new Error('native registered todo tool is unavailable');
      const before = session.getLeafId();
      try {
        const result = await tool.execute(`host-tool-${calls.length}`, params, undefined, undefined, runner.createContext());
        calls.push({ function: 'stock registered todo.definition.execute', params, before, entry: session.getLeafId(), result });
        return result;
      } catch (error) {
        calls.push({ function: 'stock registered todo.definition.execute', params, before, entry: session.getLeafId(), rejected: true, error: error.message });
        throw error;
      }
    },
    async commandAction(command) {
      const before = session.getLeafId();
      await runner.getCommand('todo').handler(command, runner.createCommandContext());
      calls.push({
        function: 'ExtensionRunner.getCommand(todo).handler',
        command,
        before,
        entry: session.getLeafId(),
        committed: before !== session.getLeafId(),
      });
    },
    disposeRunner() {
      surface?.clearWidgets?.();
      runner?.invalidate?.();
    },
    close() {
      try { this.disposeRunner(); } finally { environment?.restore(); }
    },
    environment,
  };
  await loadFinalExtensionSet();
  bindRunner();
  return host;
}
