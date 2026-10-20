import { test } from 'node:test';

test('tiny Korean Todo footer keeps follow and live state without keyboard guides',()=>{
  const frame=renderFrame({...mixed(),availability:'current'},{
    columns:22,rows:8,color:false,language:'ko',follow:false});
  const foot=stripVTControlCharacters(frame.text).split('\n').at(-1);
  assert.match(foot, /OFF/);
  assert.doesNotMatch(foot, /j\/k|a\/z|c q|^f /);
  assert.ok(fixtureCells(foot)<22);
});

import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { projectNativeTodo } from '../src/native-todo.mjs';
import { clean, fit, width, wrap, renderFrame, runningTarget } from '../src/render.mjs';

const project = phases => projectNativeTodo([{ type: 'custom', customType: 'senpi.todo-state',
  data: { schema: 'v2', phases, ask: { entryId: 'fixture-ask', capturedAt: 1,
    text: '한국어요청을별도로스크롤하면서현재작업을확인합니다'.repeat(18) } } }]);
const mixed = () => project([
  { name: 'Foundation', tasks: [{ content: 'Confirmed authority', status: 'completed' },
    { content: 'Retired alternative', status: 'abandoned' }] },
  { name: 'Implementation', tasks: [{ content: '현재진행중인작업을읽기쉽게보여줍니다'.repeat(3), status: 'in_progress' },
    { content: 'Concurrent current work', status: 'in_progress' }, { content: 'Verify source', status: 'pending' }] },
  { name: 'Empty shell', tasks: [] },
]);
// Independent cell oracle for the ASCII/Hangul fixtures, not renderer.width.
const fixtureCells = line => Array.from(stripVTControlCharacters(line))
  .reduce((total, point) => total + (/[\u1100-\u115f\uac00-\ud7a3]/u.test(point) ? 2 : 1), 0);

test('grapheme width, truncation and wrapping retain independently expected cells', () => {
  assert.equal(width('한글A'), 5);
  assert.equal(width('e\u0301'), 1);
  assert.equal(width('\u0301'), 0);
  assert.equal(width('\ud83c\uddf0\ud83c\uddf7'), 2);
  assert.equal(width('\ud83d\udc69\u200d\ud83d\udcbb'), 2);
  assert.equal(fit('한글A', 4), '한~');
  assert.equal(fit('한글A', 4, true), '한~ ');
  assert.deepEqual(wrap('가나다라마바사', 6), ['가나다', '라마바', '사']);
  assert.deepEqual(wrap('e\u0301e\u0301e\u0301', 2), ['e\u0301e\u0301', 'e\u0301']);
  assert.deepEqual(wrap('한글', 1), ['?', '?']);
});

// The chrome is a title row, a rule, a rule and a footer row (no ask rows, no hint rows), so a
// full frame leaves rows - 4 body rows; frames under the fallback height keep none.
for (const [columns, rows, bodyRows] of [[80, 24, 20], [40, 16, 12], [24, 8, 4],
  [52, 23, 19], [34, 18, 14], [51, 46, 42], [12, 4, 0], [1, 1, 0]]) {
  test(`${columns}x${rows}: visible bounded frame without ask starving current work`, () => {
    const snapshot = mixed();
    const frame = renderFrame(snapshot, { columns, rows, revealTarget: true, color: false });
    assert.equal(frame.lines.length, rows);
    assert.equal(frame.bodyRows, bodyRows);
    assert.ok(frame.lines.some(line => line.length > 0));
    for (const line of frame.lines) assert.ok(fixtureCells(line) <= columns, JSON.stringify(line));
    // Too narrow for the done/drop detail, the header keeps the closed/total count alone.
    if (columns === 24) assert.match(frame.text, /^ Todo \[2\/5\]$/m);
    if (bodyRows > 0) {
      const target = frame.bodyLines[frame.taskRanges[snapshot.target.key].start];
      assert.ok(target.startsWith('[•] ') && frame.lines.includes(target), 'actual target remains visible');
      assert.ok(frame.askRows <= 2);
      // The first body row is the scrolled row, or the followed phase's title pinned over it.
      const phaseTitle = frame.bodyLines[frame.taskRanges[snapshot.target.key].phaseStart];
      assert.ok([frame.bodyLines[frame.scroll], phaseTitle].includes(frame.lines[frame.bodyStart]));
      // Title row + rule above the body, rule + footer row below it.
      assert.equal(frame.bodyStart + frame.bodyRows + 2, rows);
      assert.doesNotMatch(frame.text, /j\/k|a\/z|^f /m);
    }
  });
}

test('every phase shell and every actual status remain accessible by basic body scroll', () => {
  const snapshot = mixed();
  const full = renderFrame(snapshot, { columns: 40, rows: 16, color: false, completedExpanded: true });
  assert.equal(Object.keys(full.phaseRanges).length, 3);
  assert.equal(Object.keys(full.taskRanges).length, 5);
  assert.equal(Object.values(full.taskRanges).filter(range => range.status === 'in_progress').length, 2);
  assert.equal(full.bodyLines.filter(line => line.startsWith('[•] ')).length, 2);
  for (const [index, phase] of snapshot.phases.entries()) {
    const range = full.phaseRanges[snapshot.phaseSummaries[index].key];
    const frame = renderFrame(snapshot, { columns: 40, rows: 16, scroll: range.start, color: false, completedExpanded: true });
    assert.ok(frame.lines.some(line => line.includes(phase.name)));
  }
  const shell = renderFrame(project([{ name: 'Empty', tasks: [] }]), { columns: 40, rows: 16, color: false });
  assert.match(shell.text, /─ Empty 0\/0 ─/);
  assert.doesNotMatch(shell.text, /100%/);
});

test('closed includes dropped; dropped never becomes completed', () => {
  const snapshot = project([{ name: 'Dropped', tasks: [
    { content: 'A', status: 'abandoned' }, { content: 'B', status: 'abandoned' },
  ] }]);
  const frame = renderFrame(snapshot, { color: false, completedExpanded: true });
  assert.match(frame.text, /Todo \[2\/2\]  done:0 · drop:2/);
  assert.match(frame.text, /─ Dropped 2\/2 drop:2 /);
  assert.equal(snapshot.target, null);
  assert.deepEqual(Object.values(frame.taskRanges).map(range => range.status), ['abandoned', 'abandoned']);
});

test('the Todo pane renders no ask rows; long unspaced labels lose no content in the body', () => {
  const snapshot = mixed();
  const first = renderFrame(snapshot, { color: false, revealTarget: true });
  const second = renderFrame(snapshot, { color: false, revealTarget: true, askScroll: 2 });
  // The captured ask lives in the collaboration pane: an ask scroll changes nothing here.
  assert.equal(first.askRows, 0);
  assert.equal(second.askScroll, 0);
  assert.deepEqual(second.lines, first.lines);
  const range = first.taskRanges[snapshot.target.key];
  const body = first.bodyLines.slice(range.start, range.end).map(line => line.slice(4)).join('');
  assert.equal(body, snapshot.target.content);
  const tiny = renderFrame(snapshot, { columns: 1, rows: 1, scroll: 4, askScroll: 2 });
  assert.equal(tiny.scroll, 4);
  assert.equal(tiny.askScroll, 2);
});

test('waiting, authoritative empty, failure and disconnected last-known have distinct labels', () => {
  const empty = project([]);
  assert.match(renderFrame(null, { color: false }).text, /WAITING/);
  assert.match(renderFrame(empty, { color: false }).text, /EMPTY \(native\)/);
  assert.match(renderFrame(null, { availability: 'error', color: false }).text, /ERROR/);
  assert.match(renderFrame(mixed(), { availability: 'last-known', color: false }).text, /CACHED NOT LIVE/);
  assert.match(renderFrame(mixed(), { availability: 'disconnected', color: false }).text, /OFFLINE NOT LIVE/);
  assert.equal(renderFrame(null, { columns: 1, rows: 1, availability: 'error' }).text, '!');
  assert.equal(renderFrame(empty, { columns: 1, rows: 1 }).text, '0');
});

test('native terminal controls cannot clear, title, recolor or reorder the viewer', () => {
  const hostile = 'safe\x1b[2J\x1b]0;foreign\x07\x1b[31m text\x1b[0m\x00\x08\u202e';
  assert.equal(clean(hostile), 'safe text');
  const snapshot = project([{ name: hostile, tasks: [{ content: hostile, status: 'in_progress' }] }]);
  snapshot.ask.text = hostile;
  const frame = renderFrame(snapshot, { color: false });
  assert.doesNotMatch(frame.text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/u);
  assert.doesNotMatch(frame.text, /foreign/);
  assert.match(frame.text, /safe text/);
});

test('native follow retains occurrence identity across parallel arrival and hands off only when inactive', () => {
  const phases = [{ name: 'Later', tasks: [
    { content: 'Same content', status: 'completed' },
    { content: 'Same content', status: 'in_progress' },
    { content: 'Parallel', status: 'in_progress' },
  ] }];
  let snapshot = project(phases), target = runningTarget(snapshot);
  assert.equal(target.key, '["Later",0,"Same content",1]');
  phases.unshift({ name: 'Earlier', tasks: [{ content: 'Arrival', status: 'in_progress' }] });
  snapshot = project(phases);
  assert.deepEqual(runningTarget(snapshot, target), { ...target, phaseIndex: 1 });
  assert.equal(snapshot.counts.inProgress, 3);
  phases[1].tasks[1].status = 'completed';
  target = runningTarget(project(phases), target);
  assert.equal(target.content, 'Arrival');
  phases.shift();
  target = runningTarget(project(phases), target);
  assert.equal(target.content, 'Parallel');
  phases[0].tasks[2].status = 'abandoned';
  phases[0].tasks.push({ content: 'Pending is not active', status: 'pending' });
  snapshot = project(phases);
  assert.equal(runningTarget(snapshot, target), null);
  // Only the tiny fallback frame names the current target; a full frame marks it by the [•] row.
  assert.match(renderFrame(snapshot, { target: null, columns: 40, rows: 4, color: false }).text, /No current target/);
  assert.doesNotMatch(renderFrame(snapshot, { target: null, color: false }).text, /\[•\]/);
});



test('fully closed nonempty phases have no row until expanded, and the header keeps truthful counts', () => {
  const snapshot=project([{name:'Closed',tasks:[{content:'DONE_HIDE',status:'completed'},{content:'DROP_HIDE',status:'abandoned'}]},
    {name:'Empty',tasks:[]},{name:'Open',tasks:[{content:'LIVE_KEEP',status:'in_progress'}]}]);
  const original=structuredClone(snapshot);
  const folded=renderFrame(snapshot,{columns:80,rows:40,color:false});
  const expanded=renderFrame(snapshot,{columns:80,rows:40,color:false,completedExpanded:true});
  assert.doesNotMatch(folded.text,/DONE_HIDE|DROP_HIDE/);
  assert.match(folded.text,/Todo \[2\/3\]  done:1 · drop:1/);
  assert.doesNotMatch(folded.text,/─ Closed /);
  assert.match(folded.text,/─ Empty 0\/0 /);
  assert.equal(Object.keys(folded.phaseRanges).length,2);
  assert.match(expanded.text,/─ Closed 2\/2 drop:1 /);
  assert.equal(Object.keys(expanded.phaseRanges).length,3);
  assert.match(expanded.text,/DONE_HIDE/);assert.match(expanded.text,/DROP_HIDE/);
  assert.ok(expanded.bodyLines.length>folded.bodyLines.length);
  assert.deepEqual(snapshot,original);
});

test('retained native target drives marker and reveal without replacing the snapshot target', () => {
  const snapshot = project([{ name: 'Long', tasks: Array.from({ length: 30 }, (_, index) => ({
    content: `NATIVE_${index}`, status: index === 0 || index === 28 ? 'in_progress' : 'completed',
  })) }]);
  const original = structuredClone(snapshot);
  const target = { key: snapshot.phaseSummaries[0].taskKeys[28] };
  const retained = runningTarget(snapshot, target);
  const followed = renderFrame(snapshot, { rows: 16, columns: 40, color: false, target: retained, revealTarget: true });
  assert.ok(followed.scroll > 0);
  assert.match(followed.text, /^\[•\] NATIVE_28/m);
  const colored = renderFrame(snapshot, { rows: 16, columns: 40, color: true, target: retained, revealTarget: true });
  assert.ok(colored.lines.some(line => line.startsWith('\x1b[1;36m[•] NATIVE_28')), 'the retained target row is bold');
  assert.ok(colored.bodyLines.some(line => line.startsWith('\x1b[36m[•] NATIVE_0')), 'the snapshot target row is not');
  const paused = renderFrame(snapshot, { rows: 16, columns: 40, color: false,
    target: retained, follow: false, revealTarget: false });
  assert.equal(paused.scroll, 0);
  assert.deepEqual(snapshot, original);
});

test('reference hierarchy emphasizes active work and exposes body-relative click ranges', () => {
  const snapshot = project([{ name: 'Closed', tasks: [{ content: 'DONE', status: 'completed' }] },
    { name: 'Open', tasks: [{ content: 'ACTIVE', status: 'in_progress' },
      { content: 'PENDING', status: 'pending' }] }]);
  const frame = renderFrame(snapshot, { columns: 52, rows: 23, color: true, completedExpanded: true });
  assert.equal(frame.closedRange, null);
  assert.ok(frame.lines[0].startsWith(' \x1b[1;36m'), 'the header sits one cell in, in bold accent');
  const phase = frame.phaseRanges[snapshot.phaseSummaries[1].key];
  // The phase holding the current work keeps a bold accent on its label; other phase rows stay muted.
  assert.ok(frame.bodyLines[phase.start].includes('\x1b[1;33m'));
  const active = frame.taskRanges[snapshot.target.key];
  assert.ok(frame.bodyLines[active.start].startsWith('\x1b[1;36m'));
  const done = frame.taskRanges[snapshot.phaseSummaries[0].taskKeys[0]];
  assert.ok(frame.bodyLines[done.start].startsWith('\x1b[9;2;32m'));
  assert.equal(frame.lines[frame.bodyStart + active.start - frame.scroll], frame.bodyLines[active.start]);
  // Phases are separated by their own divider title row, not by a blank row.
  assert.match(stripVTControlCharacters(frame.bodyLines[phase.start]), /^─ Open 0\/2 ─/);
  assert.equal(renderFrame(project([]), { color: false }).closedRange, null);
});

test('read errors remain pinned while closed summaries retain stable click coordinates', () => {
  const snapshot = mixed();
  const frame = renderFrame(snapshot, { columns: 34, rows: 18, color: false,
    error: 'READ_FAILURE', availability: 'last-known', scroll: 100 });
  assert.equal(frame.closedRange, null);
  // The pinned error sits directly above the closing rule and footer row.
  assert.match(frame.lines.at(-3), /READ_FAILURE/);
  assert.equal(frame.bodyStart + frame.bodyRows + 3, frame.lines.length);
  assert.ok(frame.lines.every(line => width(line) < 34));
});

test('following pins the phase holding current work to the first body row', () => {
  const snapshot = project([
    { name: 'Done', tasks: [{ content: 'D1', status: 'completed' }, { content: 'D2', status: 'abandoned' }] },
    { name: 'Now', tasks: [{ content: 'N1', status: 'completed' }, { content: 'N2', status: 'in_progress' }] },
    { name: 'Next', tasks: [{ content: 'X1', status: 'pending' }] }]);
  const followed = renderFrame(snapshot, { columns: 40, rows: 12, color: false, completedExpanded: true, revealTarget: true });
  assert.match(followed.lines[followed.bodyStart], /─ Now /);
  assert.ok(followed.lines.includes(followed.bodyLines[followed.taskRanges[snapshot.target.key].start]));
  assert.ok(followed.lines.some(line => line.startsWith('[•] N2')));
  assert.ok(followed.lines.some(line => line.includes('X1')));
  const paused = renderFrame(snapshot, { columns: 40, rows: 12, color: false, completedExpanded: true });
  assert.match(paused.lines[paused.bodyStart], /─ Done /);
});

test('a phase longer than the pane keeps its title on top while the current work scrolls under it', () => {
  const snapshot = project([{ name: 'Long', tasks: Array.from({ length: 20 }, (_, index) => ({
    content: `ROW_${index}`, status: index === 15 ? 'in_progress' : 'pending' })) }]);
  const frame = renderFrame(snapshot, { columns: 40, rows: 10, color: false, revealTarget: true });
  assert.match(frame.lines[frame.bodyStart], /─ Long /);
  assert.equal(frame.lines[frame.bodyStart + 1], frame.bodyLines[frame.taskRanges[snapshot.target.key].start]);
  assert.match(frame.lines[frame.bodyStart + 1], /^\[•\] ROW_15/);
  assert.ok(!frame.lines.some(line => /ROW_0\b/.test(line)));
});

test('done and dropped rows carry different colours', () => {
  const snapshot = project([{ name: 'Mixed', tasks: [{ content: 'DONE', status: 'completed' },
    { content: 'DROP', status: 'abandoned' }, { content: 'LIVE', status: 'in_progress' }] }]);
  const frame = renderFrame(snapshot, { columns: 40, rows: 12, color: true, completedExpanded: true });
  const row = text => frame.bodyLines.find(line => line.includes(text));
  assert.ok(row('DONE').startsWith('\x1b[9;2;32m'), JSON.stringify(row('DONE')));
  assert.ok(row('DROP').startsWith('\x1b[2;31m'), JSON.stringify(row('DROP')));
});

test('todo rows start at the mark and only the tracked row is bold', () => {
  const snapshot = mixed();
  const frame = renderFrame(snapshot, { columns: 40, rows: 60, color: true, completedExpanded: true });
  const keys = snapshot.phaseSummaries.flatMap(summary => summary.taskKeys ?? []);
  assert.equal(keys.length, 5);
  for (const key of keys) {
    const range = frame.taskRanges[key];
    const rows = frame.bodyLines.slice(range.start, range.end).map(line => stripVTControlCharacters(line));
    assert.match(rows[0], /^\[[ •✓×]\] \S/, key);
    // Wrapped rows hang under the text, four cells in: the mark and its gap.
    for (const row of rows.slice(1)) assert.match(row, /^ {4}\S/, key);
  }
  const tracked = frame.taskRanges[snapshot.target.key];
  assert.ok(tracked.end - tracked.start > 1, 'the tracked task wraps');
  for (const line of frame.bodyLines.slice(tracked.start, tracked.end)) assert.ok(line.startsWith('\x1b[1;36m'), JSON.stringify(line));
  const parallel = keys.filter(key => key !== snapshot.target.key && frame.taskRanges[key].status === 'in_progress');
  assert.equal(parallel.length, 1);
  const other = frame.taskRanges[parallel[0]];
  for (const line of frame.bodyLines.slice(other.start, other.end)) assert.ok(line.startsWith('\x1b[36m'), JSON.stringify(line));
  const boldRows = frame.bodyLines.filter(line => line.startsWith('\x1b[1;36m'));
  assert.equal(boldRows.length, tracked.end - tracked.start, 'only the tracked task rows are bold');
});

test('width counts text-presentation pictographs as one cell', () => {
  // Measured Herdr grid cells: text-presentation glyphs take one column.
  const cells = [
    ['A', 1], ['▶', 1], ['⚙', 1], ['⚠', 1], ['©', 1], ['▶\uFE0E', 1], ['▶\uFE0F', 2],
    ['⏳', 2], ['💭', 2], ['한', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2], ['🇰🇷', 2], ['1\uFE0F\u20E3', 2],
  ];
  for (const [glyph, expected] of cells) assert.equal(width(glyph), expected, JSON.stringify(glyph));
});

test('width matches measured Herdr cells for informative sequences', () => {
  // E/task-2/probe-herdr.json gridCells. The bare keycap 1\u20E3 is measured 1 but keeps Todo's
  // pre-existing 2 (listed as still-wrong in E/task-6/sequence-table-r2.json), so it is not asserted.
  const cells = [
    ['A', 1], ['▶', 1], ['⚙', 1], ['⚠', 1], ['⏳', 2], ['💭', 2], ['✓', 1], ['⧖', 1], ['↻', 1],
    ['✎', 1], ['©', 1], ['한', 2], ['▶\uFE0F', 2], ['▶\uFE0E', 1], ['⚙\uFE0F', 2], ['⚙\uFE0E', 1],
    ['⚠\uFE0F', 2], ['👁\u200D🗨', 2], ['👁\uFE0F\u200D🗨\uFE0F', 2], ['1\uFE0F\u20E3', 2],
    ['🇰🇷', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2],
  ];
  for (const [glyph, expected] of cells) assert.equal(width(glyph), expected, JSON.stringify(glyph));
});

test('wrapped task continuations keep the four-cell text inset', () => {
  // E/fixtures/fixtures.mjs T4 content: at width 28 a wrap boundary falls right before a separator space.
  const content = 'T4 폭 계산을 실제 Herdr pane 칸 수와 맞추고 오른쪽 테두리와 말줄임이 어긋나지 않는지 확인한다';
  for (const columns of [28, 40, 80]) {
    const snapshot = project([{ name: '구현', tasks: [{ content, status: 'pending' }] }]);
    const frame = renderFrame(snapshot, { columns, rows: 24, color: false });
    const range = frame.taskRanges[snapshot.phaseSummaries[0].taskKeys[0]];
    const rows = frame.bodyLines.slice(range.start, range.end).map(line => stripVTControlCharacters(line));
    assert.ok(rows.length > 1, `the task wraps at ${columns}`);
    assert.match(rows[0], /^\[ \] \S/, `the first row keeps the mark at ${columns}`);
    for (const row of rows.slice(1)) {
      assert.equal(row.search(/\S/), 4, `continuation starts at cell 4 at ${columns}: ${JSON.stringify(row)}`);
    }
    // Wrap points may replace a separator space with the line break; no other character may change.
    const joined = `${rows[0].slice(4)}${rows.slice(1).map(row => row.slice(4)).join('')}`.replace(/\s+/g, '');
    assert.equal(joined, content.replace(/\s+/g, ''), `task text survives wrapping at ${columns}`);
  }
});

