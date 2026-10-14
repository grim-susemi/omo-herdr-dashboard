import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { enablePointer, disablePointer } from '../packages/dag/src/terminal-input.mjs';

const count = (source, pattern) => [...source.matchAll(pattern)].length;

// Returns the terminalInput(...) call's second-argument object with nested content blanked,
// so only its own top-level property names remain. Skips strings, templates and comments.
function bindingTopLevel(source) {
  const start = source.search(/\bterminalInput\(/);
  assert.ok(start >= 0, 'terminalInput call present');
  let depth = 0, objectDepth = -1, out = '';
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    const c = source[i], pair = source.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      for (i++; source[i] !== c; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (pair === '//') { i = source.indexOf('\n', i); continue; }
    if (pair === '/*') { i = source.indexOf('*/', i) + 1; continue; }
    if ('({['.includes(c)) { depth++; if (c === '{' && objectDepth < 0 && depth === 2) objectDepth = depth; }
    else if (')}]'.includes(c)) {
      if (c === '}' && depth === objectDepth) objectDepth = -2;
      depth--;
      if (depth === 0) { assert.equal(objectDepth, -2, 'call closes after binding object'); return out; }
    }
    if (objectDepth > 0 && depth === objectDepth && c !== '{') out += c;
  }
  assert.fail('unterminated terminalInput call');
}

test('terminal input constants enable mouse tracking 1002/1006 and focus 1004 and reverse them', () => {
  assert.deepEqual(enablePointer.match(/\?(\d+)h/g), ['?1002h', '?1006h', '?1004h']);
  assert.deepEqual(disablePointer.match(/\?(\d+)l/g), ['?1004l', '?1006l', '?1002l']);
});

for (const role of ['dag', 'todo']) {
  test(`${role} viewer wires pointer/focus decoding and cleans it up`, async () => {
    const source = (await readFile(new URL(`../packages/${role}/src/viewer.mjs`, import.meta.url), 'utf8'))
      .replaceAll('\r\n', '\n');
    const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/terminal-input\.mjs'/)?.[1] ?? '';
    for (const name of ['terminalInput', 'enablePointer', 'disablePointer', 'watchHerdrFocus']) {
      assert.match(imported, new RegExp(`\\b${name}\\b`), `${role} imports ${name}`);
    }
    assert.ok(count(source, /\bterminalInput\(/g) >= 1, 'decoder bound to input');
    const bound = bindingTopLevel(source);
    for (const field of ['key', 'pointer', 'focus']) {
      assert.match(bound, new RegExp(`(^|,)\\s*${field}\\s*(:|(?=,|$))`), `binding passes ${field}`);
    }
    assert.ok(count(source, /\bwatchHerdrFocus\(/g) >= 1, 'native focus subscription');
    assert.ok(count(source, /\benablePointer\b/g) >= 2, 'tracking enabled (import + use)');
    assert.ok(count(source, /\bdisablePointer\b/g) >= 2, 'tracking disabled (import + use)');
    assert.ok(count(source, /\bdisposeInput\b/g) >= 2, 'input decoder disposed');
    assert.ok(count(source, /\bdisposeFocus\b/g) >= 2, 'focus subscription disposed');
    // Disabling must be written after enabling is available, and the disposers must be invoked.
    assert.match(source, /disposeInput\??\.?\(\)/);
    assert.match(source, /disposeFocus\??\.?\(\)/);
  });
}
