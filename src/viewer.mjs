import { watch } from 'node:fs';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { EventEmitter } from 'node:events';
import { createRoleClient } from './presence.mjs';
import { sameSnapshotScope, validSnapshot } from './storage.mjs';
import { readRoleState, registerRoleViewer, requestRoleClose } from './controller.mjs';
import { renderFrame } from './render.mjs';
import { t } from './i18n.mjs';

const pathKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && pathKey(a) === pathKey(b);
export function parseViewerArgs(args) {
  const result = { once: false };
  const fields = { '--state': 'statePath', '--close-pane': 'paneId', '--launch-token': 'launchToken' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--once') { result.once = true; continue; }
    const field = fields[args[index]];
    if (!field || result[field] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new TypeError('Usage: node viewer.mjs --state ABSOLUTE_ROLE_JSON --close-pane PANE_ID --launch-token TOKEN [--once]');
    }
    result[field] = args[++index];
  }
  if (!isAbsolute(result.statePath ?? '') || !result.paneId || !result.launchToken) {
    throw new TypeError('Absolute role state, pane ID and launch token are required');
  }
  return result;
}

export function validateRoleBinding(state, options) {
  if (!state || state.schema !== 'omo-herdr-dashboard/role/1' || state.role !== 'todo' ||
    state.paneId !== options.paneId || state.launchToken !== options.launchToken ||
    !samePath(state.prefsPath, `${options.statePath}.view.json`) ||
    !isAbsolute(state.cachePath ?? '')) throw new TypeError(t(state?.language, 'invalidBinding'));
  for (const offer of [state.presenceOffer, state.controlOffer]) {
    if (!offer) continue;
    if (offer.v !== 1 || !offer.pipePath?.startsWith('\\\\.\\pipe\\') ||
      typeof offer.token !== 'string' || !offer.token || offer.role !== 'todo' ||
      !sameSnapshotScope(offer, state)) throw new TypeError(t(state.language, 'invalidBinding'));
  }
  if (state.presenceOffer && state.presenceOffer.sequence !== 0) throw new TypeError(t(state.language, 'invalidBinding'));
  if (state.controlOffer && (state.controlOffer.paneId !== options.paneId ||
    state.controlOffer.launchToken !== options.launchToken ||
    !samePath(state.controlOffer.statePath, options.statePath))) throw new TypeError(t(state.language, 'invalidBinding'));
  return state;
}

export async function readViewerCache(state) {
  try {
    const cache = JSON.parse(await readFile(state.cachePath, 'utf8'));
    if (cache?.schema !== 'omo-herdr-todo/cache/1' || !validSnapshot(cache.snapshot)) {
      throw new TypeError(t(state.language, 'cacheError'));
    }
    return sameSnapshotScope(cache.snapshot, state)
      ? { availability: 'last-known', snapshot: cache.snapshot, error: '' }
      : { availability: 'waiting', snapshot: null, error: '' };
  } catch (error) {
    return { availability: error.code === 'ENOENT' ? 'waiting' : 'error', snapshot: null,
      error: error.code === 'ENOENT' ? '' : error.message };
  }
}

export async function startViewer(options, { input = process.stdin, output = process.stdout,
  interactive = Boolean(input.isTTY && output.isTTY) && !options.once,
  clock = { setInterval, clearInterval }, watchState = watch, readState = readRoleState,
  pid = process.pid } = {}) {
  // Direct API callers use the same CLI validation.
  if (!isAbsolute(options.statePath ?? '') || !options.paneId || !options.launchToken) {
    throw new TypeError('Absolute role state, pane ID and launch token are required');
  }
  interactive = interactive && !options.once;
  const events = new EventEmitter();
  let state = null, snapshot = null, availability = 'waiting', error = '';
  let client = null, message = null, generation = 0, observation = 0, validatedObservation = -1;
  let invalidState = false;
  let prefs = { scroll: 0, askScroll: 0 }, manualScroll = false;
  let refreshing = null, dirty = false, closing = false, closeJob;
  let painting = Promise.resolve(), saving = Promise.resolve(), lastFrame;
  let resolveClosed;
  const closed = new Promise(done => { resolveClosed = done; });
  const temporaryPrefs = `${options.statePath}.view.json.${pid}.pending`;
  let watcher, timer;
  const current = (epoch, source) => !closing && epoch === generation && source === client;
  const write = text => new Promise((done, fail) => output.write(text, cause => cause ? fail(cause) : done()));
  function draw() {
    if (closing) return painting;
    const frame = renderFrame(snapshot, { columns: output.columns ?? 80, rows: output.rows ?? 24,
      language: state?.language, availability, error, color: interactive,
      ...prefs, revealTarget: !manualScroll });
    prefs = { scroll: frame.scroll, askScroll: frame.askScroll };
    lastFrame = frame;
    const captured = { frame, client, message, generation, observation,
      scope: state && { ownerKey: state.ownerKey, sessionId: state.sessionId, scopeEpoch: state.scopeEpoch },
      availability };
    painting = painting.then(async () => {
      if (closing || captured.generation !== generation) return;
      const raw = interactive ? frame.lines.map((line, index) =>
        `\x1b[${index + 1};1H\x1b[2K${line}`).join('') : `${frame.text}\n`;
      try {
        await write(raw);
        const matches = current(captured.generation, captured.client) && captured.message !== null &&
          captured.message === message && captured.observation === observation && validatedObservation === observation &&
          sameSnapshotScope(captured.scope, state) && ['current', 'empty'].includes(captured.availability) &&
          ['current', 'empty'].includes(availability);
        events.emit('frame', { ...frame, raw, scope: captured.scope,
          sequence: captured.message?.sequence, stale: !matches });
        if (matches) captured.client.painted(captured.message);
      } catch (cause) {
        events.emit('output-error', cause);
      }
    });
    return painting;
  }
  function retire() {
    generation++;
    const old = client;
    client = null; message = null; snapshot = null; availability = 'waiting'; error = '';
    old?.close();
  }
  function connect(next, epoch) {
    if (closing || generation !== epoch || !next.presenceOffer) return;
    const source = createRoleClient({
      offer: next.presenceOffer,
      onSnapshot(value, exactMessage) {
        if (!current(epoch, source) || !validSnapshot(value) || !sameSnapshotScope(value, state)) return;
        snapshot = value; message = exactMessage; availability = value.availability; error = '';
        events.emit('snapshot', { snapshot: value, message: exactMessage, client: source });
        void draw();
      },
      onStatus(status) {
        if (!current(epoch, source)) return;
        message = null;
        snapshot = validSnapshot(status.snapshot) && sameSnapshotScope(status.snapshot, state) ? status.snapshot : null;
        availability = snapshot ? 'last-known' : status.availability === 'waiting' ? 'waiting' : 'error';
        error = status.error?.message ?? '';
        void draw();
      },
    });
    client = source;
    source.events.on('failure', cause => {
      if (!current(epoch, source)) return;
      message = null; availability = snapshot ? 'last-known' : 'error'; error = cause.message;
      void draw();
    });
    source.events.on('disconnected', () => {
      if (!current(epoch, source)) return;
      message = null;
      availability = snapshot ? 'disconnected' : error ? 'error' : 'waiting';
      void draw();
      events.emit('disconnected');
    });
  }
  async function preferences(next, epoch) {
    prefs = { scroll: 0, askScroll: 0 }; manualScroll = false;
    try {
      const value = JSON.parse(await readFile(next.prefsPath, 'utf8'));
      if (epoch === generation && value.schema === 'omo-herdr-todo/view/1' && sameSnapshotScope(value, next) &&
        [value.scroll, value.askScroll].every(number => Number.isSafeInteger(number) && number >= 0)) {
        prefs = { scroll: value.scroll, askScroll: value.askScroll };
        manualScroll = value.scroll > 0;
      }
    } catch (cause) {
      if (cause.code !== 'ENOENT' && epoch === generation) error = t(next.language, 'prefsError', { error: cause.message });
    }
  }
  async function apply(next) {
    const scopeChanged = !sameSnapshotScope(next, state);
    const offersChanged = JSON.stringify([next.presenceOffer, next.controlOffer]) !==
      JSON.stringify([state?.presenceOffer, state?.controlOffer]);
    const first = state === null;
    const reconnect = scopeChanged || offersChanged || first || invalidState;
    if (reconnect) retire();
    invalidState = false;
    state = next;
    const epoch = generation;
    if (scopeChanged || first) {
      await saving;
      await preferences(next, epoch);
    }
    if (reconnect || !interactive) {
      const cached = await readViewerCache(next);
      if (epoch !== generation || closing) return;
      snapshot = cached.snapshot; availability = cached.availability; error = cached.error || error;
    }
    if (interactive && reconnect) {
      if (next.controlOffer) {
        void registerRoleViewer({ state: next, paneId: options.paneId, launchToken: options.launchToken, pid })
          .then(accepted => {
            if (closing || epoch !== generation) return;
            events.emit('registered', { accepted, scope: next, pid });
            if (accepted) connect(next, epoch);
            else { availability = snapshot ? 'last-known' : 'error'; error = t(next.language, 'registrationError'); void draw(); }
          }, cause => {
            if (closing || epoch !== generation) return;
            availability = snapshot ? 'last-known' : 'error'; error = cause.message;
            events.emit('control-error', cause); void draw();
          });
      } else connect(next, epoch);
    }
  }
  function refresh() {
    if (closing) return Promise.resolve();
    dirty = true;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      while (dirty && !closing) {
        dirty = false;
        try {
          const selectedObservation = observation;
          const next = await readState(options.statePath);
          if (selectedObservation !== observation) { dirty = true; continue; }
          if (next) {
            try { validateRoleBinding(next, options); }
            catch (cause) { retire(); throw cause; }
            await apply(next);
            if (selectedObservation === observation) validatedObservation = observation;
          }
          else {
            const lastKnown = snapshot;
            retire(); snapshot = lastKnown;
            invalidState = true; availability = snapshot ? 'last-known' : 'waiting';
            error = state ? 'Role state is missing.' : '';
          }
        } catch (cause) {
          if (!state) throw cause;
          const lastKnown = snapshot;
          retire(); snapshot = lastKnown;
          invalidState = true; availability = snapshot ? 'last-known' : 'error'; error = cause.message;
          events.emit('state-error', cause);
        }
        if (!closing) void draw();
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function savePreferences() {
    const value = { schema: 'omo-herdr-todo/view/1', ownerKey: state.ownerKey,
      sessionId: state.sessionId, scopeEpoch: state.scopeEpoch, ...prefs };
    const epoch = generation, path = state.prefsPath;
    saving = saving.then(async () => {
      if (closing || epoch !== generation) return;
      try {
        await writeFile(temporaryPrefs, JSON.stringify(value), { mode: 0o600 });
        if (epoch === generation) await rename(temporaryPrefs, path);
        else await rm(temporaryPrefs, { force: true });
        events.emit('preferences', value);
      } catch (cause) {
        await rm(temporaryPrefs, { force: true });
        if (epoch === generation) {
          events.emit('prefs-error', cause); error = t(state.language, 'prefsError', { error: cause.message });
          void draw();
        }
      }
    });
  }
  async function close(manual = false) {
    if (closeJob) return closeJob;
    closing = true;
    closeJob = (async () => {
      let accepted = false;
      if (manual && interactive && state?.controlOffer) {
        try { accepted = await requestRoleClose({ state, paneId: options.paneId, launchToken: options.launchToken, pid }); }
        catch (cause) { events.emit('control-error', cause); }
      }
      retire();
      watcher?.close(); clock.clearInterval(timer);
      output.off?.('resize', resize); input.off?.('keypress', keypress);
      if (interactive) { input.setRawMode?.(false); input.pause?.(); }
      await saving;
      await painting;
      if (interactive) await write('\x1b[?25h\x1b[?1049l').catch(cause => events.emit('output-error', cause));
      events.emit('closed', { manual, accepted });
      resolveClosed({ manual, accepted });
      return { manual, accepted };
    })();
    return closeJob;
  }
  function key(sequence) {
    if (closing) return;
    if (['q', '\x03', '\x04'].includes(sequence)) return close(true);
    const old = { ...prefs };
    const page = Math.max(1, lastFrame?.bodyRows ?? 1);
    if (sequence === 'j' || sequence === '\x1b[B') { prefs.scroll++; manualScroll = true; }
    if (sequence === 'k' || sequence === '\x1b[A') { prefs.scroll = Math.max(0, prefs.scroll - 1); manualScroll = true; }
    if (sequence === '\x1b[6~') { prefs.scroll += page; manualScroll = true; }
    if (sequence === '\x1b[5~') { prefs.scroll = Math.max(0, prefs.scroll - page); manualScroll = true; }
    if (sequence === 'a') prefs.askScroll++;
    if (sequence === 'z') prefs.askScroll = Math.max(0, prefs.askScroll - 1);
    void draw();
    if (state && (old.scroll !== prefs.scroll || old.askScroll !== prefs.askScroll)) savePreferences();
  }
  const keypress = (text, pressed) => { void key(pressed.sequence || text || pressed.name); };
  const resize = () => { void draw(); };
  try {
    if (interactive) {
      // Subscribe first: atomic replacements during the initial read are queued.
      watcher = watchState(dirname(options.statePath), (_event, name) => {
        if (name && String(name) !== basename(options.statePath)) return;
        observation++;
        void refresh().catch(cause => events.emit('state-error', cause));
      });
      watcher.on('error', cause => {
        const lastKnown = snapshot;
        retire(); snapshot = lastKnown; invalidState = true;
        availability = snapshot ? 'last-known' : 'error'; error = cause.message; void draw();
      });
      output.write('\x1b[?1049h\x1b[?25l');
      input.setRawMode?.(true); input.resume?.();
      emitKeypressEvents(input);
      input.on('keypress', keypress); output.on?.('resize', resize);
      // Repaint even idle/empty baselines. No frame completion means no renewal.
      timer = clock.setInterval(() => { void draw(); }, 1000);
      timer?.unref?.();
    }
    await refresh();
    if (!interactive) await painting;
  } catch (cause) {
    await close(false);
    throw cause;
  }
  return { events, closed, draw, refresh, key, close,
    get state() { return { role: state, snapshot, availability, error, ...prefs }; },
    get frame() { return lastFrame; } };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const viewer = await startViewer(parseViewerArgs(process.argv.slice(2)));
  if (process.stdin.isTTY && process.stdout.isTTY && !process.argv.includes('--once')) {
    const terminate = () => { void viewer.close(false); };
    const interrupt = () => { void viewer.close(true); };
    process.once('SIGTERM', terminate); process.once('SIGHUP', terminate); process.once('SIGINT', interrupt);
    await viewer.closed;
    process.off('SIGTERM', terminate); process.off('SIGHUP', terminate); process.off('SIGINT', interrupt);
  }
}
