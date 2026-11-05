// Adapted from test/pty-capture.mjs: observe frames before ConPTY's VT diffing.
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const socket = createConnection(process.env.HERDR_TEST_FRAME_PIPE);
await once(socket, 'connect', { signal: AbortSignal.timeout(5000) });
const sha256 = name => createHash('sha256').update(readFileSync(fileURLToPath(
  new URL(`../src/${name}.mjs`, import.meta.url)))).digest('hex');
socket.write(JSON.stringify({ type: 'process', pid: process.pid, argv: process.argv, execArgv: process.execArgv,
  execPath: process.execPath, source: { render: sha256('render'), viewer: sha256('viewer') },
  herdr: { env: process.env.HERDR_ENV, pane: process.env.HERDR_PANE_ID,
    tab: process.env.HERDR_TAB_ID, workspace: process.env.HERDR_WORKSPACE_ID } }) + '\n');
const original = process.stdout.write;
process.stdout.write = function (...args) {
  const result = original.apply(this, args);
  if (typeof args[0] === 'string' && args[0].startsWith('\x1b[H')) {
    socket.write(JSON.stringify({ type: 'frame', pid: process.pid, columns: process.stdout.columns,
      rows: process.stdout.rows, frame: args[0] }) + '\n');
  }
  return result;
};
