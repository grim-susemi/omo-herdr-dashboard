import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';
import net from 'node:net';

export const enablePointer = '\x1b[?1002h\x1b[?1006h\x1b[?1004h';
export const disablePointer = '\x1b[?1004l\x1b[?1006l\x1b[?1002l';

// Herdr 0.9.3 does not forward pane blur as DEC 1004 terminal reports.
// Its public lifecycle stream supplies the missing pane/tab/workspace events.
export async function watchHerdrFocus(paneId, blur, failed, env = process.env) {
  if (env.HERDR_ENV !== '1' || paneId !== env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH)
    return () => {};
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\${env.HERDR_SOCKET_PATH}` : env.HERDR_SOCKET_PATH;
  const socket = net.createConnection(path);
  let buffer = '', disposed = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Herdr focus subscription timed out')), 5000);
    const settle = error => { clearTimeout(timeout); if (error) reject(error); else resolve(); };
    socket.once('connect', () => socket.write(`${JSON.stringify({
      id: 'dashboard-focus', method: 'events.subscribe', params: { subscriptions:
        ['pane.focused', 'tab.focused', 'workspace.focused'].map(type => ({ type })) },
    })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.error) { settle(new Error(message.error.message)); failed(new Error(message.error.message)); socket.destroy(); return; }
        if (message.result?.type === 'subscription_started') settle();
        const event = message.data;
        if (event?.type === 'pane_focused' && event.pane_id !== paneId ||
          event?.type === 'tab_focused' && event.tab_id !== env.HERDR_TAB_ID ||
          event?.type === 'workspace_focused' && event.workspace_id !== env.HERDR_WORKSPACE_ID)
          blur();
      }
    });
    socket.on('error', cause => { settle(cause); if (!disposed) failed(cause); });
    socket.once('close', () => { if (!disposed) settle(new Error('Herdr focus subscription closed')); });
  }).catch(cause => { disposed = true; socket.destroy(); throw cause; });
  return () => { disposed = true; socket.destroy(); };
}

// Consume terminal reports before readline: the final M must never become a key.
export function terminalInput(input, { key, pointer, focus }) {
  const keys = new PassThrough();
  keys.setEncoding('utf8');
  emitKeypressEvents(keys);
  keys.on('keypress', (text, pressed) => key(text, pressed));
  let buffer = '';
  function data(chunk) {
    buffer += chunk.toString();
    while (buffer) {
      const escape = buffer.indexOf('\x1b');
      if (escape !== 0) {
        const end = escape < 0 ? buffer.length : escape;
        keys.write(buffer.slice(0, end)); buffer = buffer.slice(end);
        continue;
      }
      if (buffer === '\x1b' || buffer === '\x1b[') return;
      if (buffer.startsWith('\x1b[I') || buffer.startsWith('\x1b[O')) {
        const focused = buffer[2] === 'I';
        buffer = buffer.slice(3); focus(focused);
        continue;
      }
      if (buffer.startsWith('\x1b[<')) {
        const report = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buffer);
        if (!report && /^\x1b\[<[\d;]*$/.test(buffer)) return;
        if (report) {
          buffer = buffer.slice(report[0].length);
          pointer({ button: Number(report[1]), x: Number(report[2]),
            y: Number(report[3]), release: report[4] === 'm' });
          continue;
        }
      }
      // Leave ordinary key sequences (including fragmented arrows) to readline.
      keys.write(buffer[0]); buffer = buffer.slice(1);
    }
  }
  input.on('data', data);
  return () => { input.off('data', data); keys.destroy(); buffer = ''; };
}
