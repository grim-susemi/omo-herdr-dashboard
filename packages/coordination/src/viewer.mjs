// OmO collaboration pane viewer. Read-only: it polls the controller's status file,
// the coordination activity log and the oracle advisor log once a second and
// repaints only when something changed. Missing or corrupt files render empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalInput, enablePointer, disablePointer } from '../../dag/src/terminal-input.mjs';
import { createHerdr } from '../../dag/src/herdr.mjs';
import { readActivity, readAdvisor, readStatus } from './activity.mjs';
import { renderFrame } from './render.mjs';
import { languageOf, t } from './i18n.mjs';

export function parseArgs(argv) {
  const value = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  return { status: value('--status'), activity: value('--activity'), advisor: value('--advisor'),
    record: value('--record'), closePane: value('--close-pane'), language: languageOf(value('--lang')),
    once: argv.includes('--once'), columns: Number(value('--columns')) || undefined, rows: Number(value('--rows')) || undefined };
}

export function snapshot(options) {
  return { status: options.status ? readStatus(options.status) : null,
    events: options.activity ? readActivity(options.activity) : [],
    advisor: options.advisor ? readAdvisor(options.advisor) : undefined };
}

async function run(options) {
  const output = process.stdout, input = process.stdin;
  const size = () => ({ columns: options.columns ?? output.columns ?? 28, rows: options.rows ?? output.rows ?? 30 });
  let follow = true, offset = 0, last = '', closing = false, frame;
  const draw = force => {
    frame = renderFrame(snapshot(options), { ...size(), language: options.language, follow, offset, color: !options.once });
    if (!force && frame.text === last) return;
    last = frame.text;
    if (options.once) { output.write(`${frame.plain.join('\n')}\n`); return; }
    output.write(`\x1b[H${frame.lines.map(line => `${line}\x1b[K`).join('\r\n')}\x1b[J`);
  };
  if (options.once || !input.isTTY) { draw(true); return; }
  const scroll = rowsBy => {
    const max = frame?.maxOffset ?? 0;
    offset = Math.min(max, Math.max(0, offset + rowsBy));
    // Scrolling up pauses follow; reaching the newest row again resumes it.
    follow = offset === 0;
    draw(true);
  };
  const close = async closePane => {
    if (closing) return;
    closing = true;
    clearInterval(timer); output.off('resize', resize); disposeInput();
    input.setRawMode?.(false);
    output.write(`${disablePointer}\x1b[?25h\x1b[?1049l`);
    if (closePane && options.closePane) {
      // An owner close is remembered so this session does not reopen the pane.
      if (options.record) try {
        const record = JSON.parse(readFileSync(options.record, 'utf8'));
        writeFileSync(options.record, JSON.stringify({ ...record, manualClose: true }));
      } catch { /* the record is advisory */ }
      try { await createHerdr()('close', options.closePane); } catch { /* the pane may already be gone */ }
    }
    process.exit(0);
  };
  const key = (text, pressed = {}) => {
    const name = pressed.name ?? text;
    const page = Math.max(1, (frame?.height ?? 10) - 2);
    if (pressed.ctrl && name === 'c' || name === 'q') return void close(true);
    if (name === 'up' || name === 'k') scroll(1);
    else if (name === 'down' || name === 'j') scroll(-1);
    else if (name === 'pageup') scroll(page);
    else if (name === 'pagedown') scroll(-page);
    else if (name === 'end' || name === 'f' || name === 'G') { follow = true; offset = 0; draw(true); }
  };
  const pointer = ({ button }) => { if (button === 64) scroll(2); else if (button === 65) scroll(-2); };
  output.write(`\x1b[?1049h\x1b[?25l${enablePointer}\x1b]0;${t(options.language, 'title')}\x07`);
  input.setRawMode?.(true); input.resume();
  const disposeInput = terminalInput(input, { key, pointer, focus: () => {} });
  const resize = () => draw(true);
  output.on('resize', resize);
  const timer = setInterval(() => draw(false), 1000);
  draw(true);
  process.on('SIGTERM', () => void close(false));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run(parseArgs(process.argv.slice(2)));
