import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viewer = join(packageDir, 'src/viewer.mjs');
const tap = join(packageDir, 'scripts/qa-active-tracking-tap.mjs');
const pngRenderer = join(packageDir, 'scripts/qa-active-tracking-png.ps1');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--fixtures', '--out'].includes(flag) || options[flag] || !process.argv[i + 1])
    throw Error('Usage: node scripts/qa-active-tracking.mjs --fixtures <dir> --out <dir>');
  options[flag] = resolve(process.argv[i + 1]);
}
if (!options['--fixtures'] || !options['--out'])
  throw Error('Usage: node scripts/qa-active-tracking.mjs --fixtures <dir> --out <dir>');
if (process.platform !== 'win32' || !process.env.HERDR_WORKSPACE_ID)
  throw Error('A Windows Herdr session with HERDR_WORKSPACE_ID is required');
const herdr = execFileSync('where.exe', ['herdr'], { encoding: 'utf8' }).split(/\r?\n/)[0];
const cli = (...args) => execFileSync(herdr, args, { encoding: 'utf8', timeout: 15000 });
const api = (...args) => JSON.parse(cli(...args)).result;
const quote = value => `'${value.replaceAll("'", "''")}'`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { render: hash(await readFile(join(packageDir, 'src/render.mjs'))),
  viewer: hash(await readFile(viewer)) };
const out = options['--out'];
await mkdir(out, { recursive: true });
let previous;
try { previous = JSON.parse(await readFile(join(out, 'live-index.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const index = { schema: 'w1-live-active-tracking/1', started: new Date().toISOString(),
  expectedSource: expected, cases: [], cleanup: [], complete: false,
  previousRuns: previous ? [...(previous.previousRuns ?? []),
    { ...previous, previousRuns: undefined, artifactsMayBeOverwritten: true }] : [] };
async function save() {
  const path = join(out, 'live-index.json');
  await writeFile(`${path}.tmp`, JSON.stringify(index, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}
await save();
const temp = await mkdtemp(join(tmpdir(), 'w1-live-'));
const frames = new EventEmitter();
const pipe = `\\\\.\\pipe\\w1-active-${randomUUID()}`;
const server = createServer(socket => {
  let pid;
  createInterface({ input: socket }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'process') pid = message.pid;
      frames.emit('message', message);
    }
    catch (error) { frames.emit('stream-error', error); }
  });
  socket.on('close', () => { if (pid) frames.emit('process-exit', pid); });
});
await new Promise((resolveListen, reject) => server.once('error', reject).listen(pipe, resolveListen));
function waitMessage(predicate) {
  let cleanup;
  const promise = new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a candidate frame')), 10000);
    const message = value => { if (predicate(value)) finish(null, value); };
    const error = value => finish(value);
    function finish(err, value) {
      clearTimeout(timer);
      frames.off('message', message);
      frames.off('stream-error', error);
      if (err) reject(err); else resolveMessage(value);
    }
    cleanup = () => finish(new Error('Cancelled frame subscription'));
    frames.on('message', message);
    frames.on('stream-error', error);
  });
  return { promise, cleanup };
}
const isFrame = pid => value => value.type === 'frame' && value.pid === pid;
async function action(pid, predicate, invoke) {
  // Subscribe before input/resize; unlike wait-output this cannot match an old snapshot.
  const pending = waitMessage(value => isFrame(pid)(value) && predicate(value));
  try { invoke(); } catch (error) { pending.cleanup(); await pending.promise.catch(() => {}); throw error; }
  return pending.promise;
}
const plain = frame => stripVTControlCharacters(frame);
const follow = value => /Follow ON/.test(plain(value.frame));
const paused = value => /Follow OFF/.test(plain(value.frame));
const send = (pane, key) => cli('pane', 'send-keys', pane, key);
let tab, pane, sibling, activePid, siblingPid;
let errors = 0;
try {
  for (const fixture of ['f1', 'f2', 'f3', 'f4']) {
    const stateFile = join(temp, `${fixture}.json`);
    await writeFile(stateFile, await readFile(join(options['--fixtures'], `${fixture}.json`)));
    const created = api('tab', 'create', '--workspace', process.env.HERDR_WORKSPACE_ID,
      '--cwd', packageDir, '--label', `W1 QA ${fixture}`, '--no-focus');
    tab = created.tab.tab_id;
    pane = created.root_pane.pane_id;
    const item = { fixture, tab, pane, stateFile, cases: [], transitions: [], status: 'running' };
    index.cases.push(item);
    await save();
    try {
      let candidateProcess;
      const initialPromise = waitMessage(value => {
        if (value.type === 'process' && value.argv.includes(stateFile)) {
          candidateProcess = value;
          activePid = value.pid;
        }
        return value.type === 'frame' && candidateProcess && value.pid === candidateProcess.pid;
      });
      const command = `$env:HERDR_TEST_FRAME_PIPE=${quote(pipe)}; & ${quote(process.execPath)} --import ${quote(pathToFileURL(tap).href)} ${quote(viewer)} --state ${quote(stateFile)}`;
      try { cli('pane', 'run', pane, command); }
      catch (error) { initialPromise.cleanup(); await initialPromise.promise.catch(() => {}); throw error; }
      const first = await initialPromise.promise;
      const processInfo = candidateProcess;
      activePid = processInfo.pid;
      if (first.pid !== activePid || JSON.stringify(processInfo.source) !== JSON.stringify(expected))
        throw Error('Candidate PID or source hash mismatch');
      const native = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${activePid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8', timeout: 15000 }));
      const shell = api('pane', 'process-info', '--pane', pane).process_info;
      if (native.ProcessId !== activePid || native.ParentProcessId !== shell.shell_pid ||
        !native.CommandLine.includes(viewer) || !native.CommandLine.includes(stateFile))
        throw Error('Native candidate process does not match the owned pane shell and argv');
      processInfo.native = native;
      processInfo.shellPid = shell.shell_pid;
      item.process = processInfo;
      item.processCommand = command;
      const capture = async (name, frame) => {
        if (!Number.isInteger(frame.columns) || !Number.isInteger(frame.rows))
          throw Error('Candidate did not report terminal dimensions');
        const stem = `${fixture}-${name}`;
        const ansi = cli('pane', 'read', pane, '--source', 'visible', '--format', 'ansi', '--raw');
        if (!ansi || !ansi.includes('\x1b')) throw Error('Visible pane read did not return ANSI');
        const text = plain(ansi);
        if (!/^ DAG \[/m.test(text)) throw Error('Visible pane is not showing the DAG candidate');
        await writeFile(join(out, `${stem}.ansi`), ansi);
        await writeFile(join(out, `${stem}.txt`), text);
        const rendered = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', pngRenderer, '-AnsiPath', join(out, `${stem}.ansi`), '-PngPath', join(out, `${stem}.png`),
          '-Columns', String(frame.columns), '-Rows', String(frame.rows)], { encoding: 'utf8', timeout: 60000 }));
        const pngBytes = await readFile(join(out, `${stem}.png`));
        if (!pngBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          pngBytes.readUInt32BE(16) !== rendered.width || pngBytes.readUInt32BE(20) !== rendered.height)
          throw Error('ANSI renderer did not produce a valid PNG with the declared dimensions');
        const info = api('pane', 'get', pane).pane;
        const title = { f1: 'RUNNING_PRIMARY', f2: 'FINAL_RUNNING', f3: 'OLD_TARGET' }[fixture];
        const titleRow = title ? text.split(/\r?\n/).findIndex(line => line.includes(title)) + 1 : null;
        item.cases.push({ name, columns: frame.columns, rows: frame.rows, pid: activePid,
          source: processInfo.source, ansi: `${stem}.ansi`, text: `${stem}.txt`, paneRevision: info.revision,
          png: { path: `${stem}.png`, renderedFromAnsi: true, source: `${stem}.ansi`,
            sourceSha256: hash(await readFile(join(out, `${stem}.ansi`))), bytes: pngBytes.length, ...rendered },
          title, titleRow, topEight: title ? titleRow > 0 && titleRow <= 8 : null });
        await save();
      };
      await capture('large', first);
      const testAction = async (size, name, predicate, input) => {
        const frame = await action(activePid, predicate, input);
        item.transitions.push({ size, name, pass: true, columns: frame.columns, rows: frame.rows,
          frame: plain(frame.frame), pid: activePid });
        await save();
        return frame;
      };
      const exercise = async size => {
        await testAction(size, 'mode-tasks', x => /^ Tasks \[/m.test(plain(x.frame)), () => send(pane, 't'));
        await testAction(size, 'mode-dag', x => /^ DAG \[/m.test(plain(x.frame)), () => send(pane, 't'));
        await testAction(size, 'follow-on', follow, () => send(pane, 'f'));
        await testAction(size, 'scroll-follow-off', paused, () => send(pane, 'j'));
        await testAction(size, 'follow-resume', follow, () => send(pane, 'f'));
        const expandedLabel = { f2: 'NODE_0', f4: 'DONE_A' }[fixture];
        await testAction(size, 'c-follow-off',
          x => paused(x) && (!expandedLabel || plain(x.frame).includes(expandedLabel)), () => send(pane, 'c'));
        if (fixture === 'f2' || fixture === 'f4') {
          await testAction(size, 'c-reverse', x => /Completed [38] · Step/.test(plain(x.frame)),
            () => send(pane, 'c'));
        } else {
          // These fixtures have no completed-only stage, so folding is not visibly distinguishable.
          await testAction(size, 'follow-before-c-reverse', follow, () => send(pane, 'f'));
          await testAction(size, 'c-reverse-follow-off', paused, () => send(pane, 'c'));
          item.transitions.push({ size, name: 'c-fold-content', pass: null,
            reason: 'No completed-only stage in selected fixture run' });
          await save();
        }
        // Explicit DEC focus-out input; this does not claim a Herdr lifecycle blur event.
        await testAction(size, 'terminal-focus-out-resume', follow, () => cli('pane', 'send-text', pane, '\x1b[O'));
        item.transitions.at(-1).mechanism = 'synthetic-focus-out';
        await save();
      };
      await exercise('large');
      let splitResult;
      const resized = await action(activePid, x => x.columns !== first.columns || x.rows !== first.rows, () => {
        splitResult = api('pane', 'split', '--pane', pane, '--direction', 'right', '--ratio', '0.5',
          '--cwd', packageDir, '--no-focus');
        sibling = splitResult.pane.pane_id;
      });
      item.transitions.push({ name: 'resize', pass: true, before: [first.columns, first.rows],
        after: [resized.columns, resized.rows], pid: activePid });
      await capture('small', resized);
      await exercise('small');
      const siblingStateFile = join(temp, `${fixture}-sibling.json`);
      await writeFile(siblingStateFile, await readFile(join(options['--fixtures'], `${fixture}.json`)));
      let siblingProcess;
      const siblingInitial = waitMessage(value => {
        if (value.type === 'process' && value.argv.includes(siblingStateFile)) {
          siblingProcess = value;
          siblingPid = value.pid;
        }
        return value.type === 'frame' && siblingProcess && value.pid === siblingProcess.pid;
      });
      const siblingCommand = `$env:HERDR_TEST_FRAME_PIPE=${quote(pipe)}; & ${quote(process.execPath)} --import ${quote(pathToFileURL(tap).href)} ${quote(viewer)} --state ${quote(siblingStateFile)}`;
      try { cli('pane', 'run', sibling, siblingCommand); }
      catch (error) { siblingInitial.cleanup(); await siblingInitial.promise.catch(() => {}); throw error; }
      await siblingInitial.promise;
      const siblingNative = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${siblingPid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8', timeout: 15000 }));
      const siblingShell = api('pane', 'process-info', '--pane', sibling).process_info;
      if (JSON.stringify(siblingProcess.source) !== JSON.stringify(expected) ||
        siblingNative.ParentProcessId !== siblingShell.shell_pid ||
        !siblingNative.CommandLine.includes(siblingStateFile))
        throw Error('Sibling candidate provenance does not match the owned pane');
      siblingProcess.native = siblingNative;
      siblingProcess.shellPid = siblingShell.shell_pid;
      item.nativeBlur = {};
      const blurFor = size => item.nativeBlur[size] = {
        mechanism: 'native-focus-switch', paneA: pane, paneB: sibling, processA: processInfo,
        processB: siblingProcess, stateA: stateFile, stateB: siblingStateFile,
        sequence: [], status: 'running' };
      await save();
      const focusPane = () => api('pane', 'layout', '--pane', pane).layout.focused_pane_id;
      if (focusPane() !== pane) {
        cli('pane', 'focus', '--pane', sibling, '--direction', 'left');
        if (focusPane() !== pane) throw Error('Could not focus owned pane A');
      }
      async function nativeBlur(blur, size, fromPane, fromPid, toPane, direction, label) {
        const before = await action(fromPid, paused, () => send(fromPane, 'j'));
        const dimensions = size === 'large' ? [171, 46] : [84, 44];
        if (before.columns !== dimensions[0] || before.rows !== dimensions[1])
          throw Error(`Unexpected ${size} blur dimensions: ${before.columns}x${before.rows}`);
        const beforeFile = `${fixture}-${size}-${label}-before.ansi`;
        await writeFile(join(out, beforeFile), cli('pane', 'read', fromPane, '--source', 'visible', '--format', 'ansi', '--raw'));
        const receipt = { fromPane, toPane, pid: fromPid, direction, before: plain(before.frame),
          beforeFollow: 'OFF', beforeDimensions: [before.columns, before.rows],
          beforeAnsi: beforeFile, beforeFocus: focusPane(), status: 'pending' };
        blur.sequence.push(receipt);
        await save();
        if (receipt.beforeFocus !== fromPane) throw Error(`Owned source pane is not focused: ${fromPane}`);
        let focusOutput;
        let after;
        try {
          after = await action(fromPid, follow, () => {
            focusOutput = cli('pane', 'focus', '--pane', fromPane, '--direction', direction);
          });
        } catch (error) {
          receipt.status = 'failed';
          receipt.command = `herdr pane focus --pane ${fromPane} --direction ${direction}`;
          receipt.error = error.message;
          receipt.stdout = error.stdout?.toString();
          receipt.stderr = error.stderr?.toString();
          await save();
          throw error;
        }
        const afterFocus = focusPane();
        if (afterFocus !== toPane) throw Error(`Focus did not move to owned pane ${toPane}`);
        const afterFile = `${fixture}-${size}-${label}-after.ansi`;
        await writeFile(join(out, afterFile), cli('pane', 'read', fromPane, '--source', 'visible', '--format', 'ansi', '--raw'));
        Object.assign(receipt, { status: 'passed', after: plain(after.frame), afterFollow: 'ON', afterAnsi: afterFile,
          focusOutput, afterFocus, columns: after.columns, rows: after.rows });
        await save();
      }
      const smallBlur = blurFor('small');
      await nativeBlur(smallBlur, 'small', pane, activePid, sibling, 'right', 'a-to-b');
      await nativeBlur(smallBlur, 'small', sibling, siblingPid, pane, 'left', 'b-to-a');
      smallBlur.status = 'passed';
      cli('pane', 'zoom', '--pane', pane, '--on');
      const zoomed = await action(activePid, x => /^ Tasks \[/m.test(plain(x.frame)),
        () => send(pane, 't'));
      item.transitions.push({ name: 'zoom-large', pass: zoomed.columns === 171 && zoomed.rows === 46,
        columns: zoomed.columns, rows: zoomed.rows, pid: activePid });
      await action(activePid, x => /^ DAG \[/m.test(plain(x.frame)), () => send(pane, 't'));
      const largeBlur = blurFor('large');
      await nativeBlur(largeBlur, 'large', pane, activePid, sibling, 'right', 'a-to-b');
      largeBlur.status = 'passed';
      await save();
      item.status = 'captured';
    } catch (error) {
      errors++;
      item.status = 'failed';
      item.error = error.stack || error.message;
      for (const blur of Object.values(item.nativeBlur ?? {})) {
        if (blur.status === 'running') {
          blur.status = 'failed';
          blur.error = error.message;
        }
      }
      await save();
    } finally {
      const receipt = { fixture, tab, pane, sibling, pid: activePid, siblingPid };
      const waitClosed = watchedPid => watchedPid ? new Promise(resolveClose => {
        const listener = pid => {
          if (pid !== watchedPid) return;
          clearTimeout(timer);
          frames.off('process-exit', listener);
          resolveClose(true);
        };
        const timer = setTimeout(() => { frames.off('process-exit', listener); resolveClose(false); }, 5000);
        frames.on('process-exit', listener);
      }) : Promise.resolve(null);
      const closed = waitClosed(activePid);
      const siblingClosed = waitClosed(siblingPid);
      try {
        if (activePid) send(pane, 'q');
        if (siblingPid) send(sibling, 'q');
        receipt.quitSent = Boolean(activePid);
      } catch (error) { receipt.quitError = error.message; }
      try { cli('tab', 'close', tab); receipt.tabClosed = true; }
      catch (error) { receipt.tabClosed = false; receipt.error = error.message; errors++; }
      receipt.processStreamClosed = await closed;
      receipt.siblingStreamClosed = await siblingClosed;
      if (activePid) {
        try { process.kill(activePid, 0); receipt.processExited = false; }
        catch (error) {
          if (error.code !== 'ESRCH') throw error;
          receipt.processExited = true;
        }
        if (!receipt.processStreamClosed || !receipt.processExited) errors++;
      }
      if (siblingPid) {
        try { process.kill(siblingPid, 0); receipt.siblingExited = false; }
        catch (error) {
          if (error.code !== 'ESRCH') throw error;
          receipt.siblingExited = true;
        }
        if (!receipt.siblingStreamClosed || !receipt.siblingExited) errors++;
      }
      index.cleanup.push(receipt);
      await save();
      tab = pane = sibling = activePid = siblingPid = undefined;
    }
  }
} finally {
  if (tab) {
    try { cli('tab', 'close', tab); index.cleanup.push({ tab, tabClosed: true, emergency: true }); }
    catch (error) { index.cleanup.push({ tab, tabClosed: false, error: error.message }); errors++; }
  }
  server.close();
  await rm(temp, { recursive: true, force: true });
  index.complete = errors === 0 && index.cases.length === 4 &&
    index.cases.every(item => item.status === 'captured' && ['small', 'large'].every(size => item.nativeBlur?.[size]?.status === 'passed') && item.cases.length === 2 &&
      item.cases.every(view => view.topEight !== false));
  index.finished = new Date().toISOString();
  await save();
}
if (!index.complete) process.exitCode = 1;
