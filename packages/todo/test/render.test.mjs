import { test } from 'node:test';

test('tiny Korean Todo footer keeps follow and c/q controls visible',()=>{
  const frame=renderFrame({...mixed(),availability:'current'},{
    columns:22,rows:8,color:false,language:'ko',follow:false});
  const foot=stripVTControlCharacters(frame.text).split('\n').at(-1);
  for(const key of ['OFF','j/k','c','q'])assert.ok(foot.includes(key),foot);
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

for (const [columns, rows, bodyRows] of [[80, 24, 16], [40, 16, 8], [24, 8, 2], [12, 4, 0], [1, 1, 0]]) {
  test(`${columns}x${rows}: visible bounded frame without ask starving current work`, () => {
    const frame = renderFrame(mixed(), { columns, rows, revealTarget: true, color: false });
    assert.equal(frame.lines.length, rows);
    assert.equal(frame.bodyRows, bodyRows);
    assert.ok(frame.lines.some(line => line.length > 0));
    for (const line of frame.lines) assert.ok(fixtureCells(line) <= columns, JSON.stringify(line));
    if (columns === 24) assert.match(frame.text, /2\/5 done:1 drop:1/);
    if (bodyRows > 0) {
      assert.ok(frame.lines.some(line => line.includes('>* ')), 'actual target remains visible');
      assert.ok(frame.askRows <= 3);
    }
  });
}

test('every phase shell and every actual status remain accessible by basic body scroll', () => {
  const snapshot = mixed();
  const full = renderFrame(snapshot, { columns: 40, rows: 16, color: false, completedExpanded: true });
  assert.equal(Object.keys(full.phaseRanges).length, 3);
  assert.equal(Object.keys(full.taskRanges).length, 5);
  assert.equal(Object.values(full.taskRanges).filter(range => range.status === 'in_progress').length, 2);
  assert.equal(full.bodyLines.filter(line => line.startsWith(' * ') || line.startsWith('>* ')).length, 2);
  for (const [index, phase] of snapshot.phases.entries()) {
    const range = full.phaseRanges[snapshot.phaseSummaries[index].key];
    const frame = renderFrame(snapshot, { columns: 40, rows: 16, scroll: range.start, color: false, completedExpanded: true });
    assert.ok(frame.lines.some(line => line.includes(phase.name)));
  }
  const shell = renderFrame(project([{ name: 'Empty', tasks: [] }]), { columns: 40, rows: 16, color: false });
  assert.match(shell.text, /Empty 0\/0 done:0 drop:0/);
  assert.doesNotMatch(shell.text, /100%/);
});

test('closed includes dropped; dropped never becomes completed', () => {
  const snapshot = project([{ name: 'Dropped', tasks: [
    { content: 'A', status: 'abandoned' }, { content: 'B', status: 'abandoned' },
  ] }]);
  const frame = renderFrame(snapshot, { color: false, completedExpanded: true });
  assert.match(frame.text, /2\/2 closed done:0 drop:2/);
  assert.match(frame.text, /Dropped 2\/2 done:0 drop:2/);
  assert.equal(snapshot.target, null);
  assert.deepEqual(Object.values(frame.taskRanges).map(range => range.status), ['abandoned', 'abandoned']);
});

test('ask has its own bounded scroll; long unspaced labels lose no content in the body', () => {
  const snapshot = mixed();
  const first = renderFrame(snapshot, { color: false, revealTarget: true });
  const second = renderFrame(snapshot, { color: false, revealTarget: true, askScroll: 2 });
  assert.equal(first.scroll, second.scroll);
  assert.equal(second.askScroll, 2);
  assert.notDeepEqual(first.lines.slice(4, 7), second.lines.slice(4, 7));
  const range = first.taskRanges[snapshot.target.key];
  const body = first.bodyLines.slice(range.start, range.end).map(line => line.slice(3)).join('');
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
  assert.match(renderFrame(snapshot, { target: null, color: false }).text, /No current target/);
});



test('fully closed nonempty phases fold task rows but keep truthful shells and counts', () => {
  const snapshot=project([{name:'Closed',tasks:[{content:'DONE_HIDE',status:'completed'},{content:'DROP_HIDE',status:'abandoned'}]},
    {name:'Empty',tasks:[]},{name:'Open',tasks:[{content:'LIVE_KEEP',status:'in_progress'}]}]);
  const original=structuredClone(snapshot);
  const folded=renderFrame(snapshot,{columns:80,rows:40,color:false});
  const expanded=renderFrame(snapshot,{columns:80,rows:40,color:false,completedExpanded:true});
  assert.doesNotMatch(folded.text,/DONE_HIDE|DROP_HIDE/);
  assert.match(folded.text,/Closed 2\/2 done:1 drop:1/);
  assert.match(folded.text,/Empty 0\/0 done:0 drop:0/);
  assert.equal(Object.keys(folded.phaseRanges).length,3);
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
  assert.match(followed.text, />\* NATIVE_28/);
  const paused = renderFrame(snapshot, { rows: 16, columns: 40, color: false,
    target: retained, follow: false, revealTarget: false });
  assert.equal(paused.scroll, 0);
  assert.deepEqual(snapshot, original);
});
