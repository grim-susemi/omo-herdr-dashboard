import todo from './todo/extension.mjs';
import dag from './dag/extension.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function dashboard(pi) {
  const state = resolve(dirname(fileURLToPath(import.meta.url)), '../../state');
  process.env.OMO_HERDR_TODO_STATE_DIR ??= resolve(state, 'todo');
  process.env.OMO_HERDR_DAG_STATE_DIR ??= resolve(state, 'dag');
  todo(pi);
  dag(pi);
}
