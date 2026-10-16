// width/fit are narrowly adapted from omo-herdr-dag-follow/src/render.mjs.
// MIT License, Copyright (c) 2026 omo-herdr-dag contributors.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import { stripVTControlCharacters } from 'node:util';
import { t } from './i18n.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Terminal primitives: one-cell inset, semantic ANSI colors and bounded ask.
const style = { accent: '36', phase: '35', muted: '90', completed: '90', abandoned: '90',
  in_progress: '36', warning: '33', error: '31', activePhase: '33' };
const layout = { taskInset: 5, askMaxRows: 2, sectionGap: 1, minimumWorkRows: 2, fallbackColumns: 16, fallbackRows: 4 };
const marks = { pending: '[ ]', in_progress: '[•]', completed: '[✓]', abandoned: '[×]', cancelled: '[×]' };
export const STRIKE_INTERVAL_MS = 65;
export const STRIKE_TOTAL_FRAMES = 14;
const paint = (text, token, enabled, heading = false) => enabled && style[token] ?
  `\x1b[${heading ? '1;' : token === 'completed' ? '9;' : ''}${style[token]}m${text}\x1b[0m` : text;
// Two hold frames followed by twelve reveal frames, as in Pi's Todo widget.
export function strikeRevealCount(text, frame) {
  return frame === undefined ? undefined : Math.ceil([...text].length * Math.min(12, Math.max(0, frame - 2)) / 12);
}
function completedLine(text, count, color) {
  if (!color) return text;
  if (count === undefined) return paint(text, 'completed', true);
  const chars = [...text], split = Math.min(chars.length, Math.max(0, count));
  return `\x1b[90m${split ? `\x1b[9m${chars.slice(0, split).join('')}\x1b[29m` : ''}${chars.slice(split).join('')}\x1b[0m`;
}
export const clean = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/\r\n?/g, '\n').replaceAll('\t', ' ')
  .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

export function width(text) {
  let result = 0;
  for (const { segment } of segmenter.segment(clean(text))) {
    if (/^[\p{Mark}\p{Cf}\n]+$/u.test(segment)) continue;
    const cp = segment.codePointAt(0);
    result += /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment) ||
      cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 ||
        cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f ||
        cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000) ? 2 : 1;
  }
  return result;
}

export function fit(text, columns, pad = false) {
  text = clean(text).replaceAll('\n', ' ');
  if (columns < 1) return '';
  let out = '', used = 0;
  const truncated = width(text) > columns;
  for (const { segment } of segmenter.segment(text)) {
    const size = width(segment);
    if (used + size > columns - (truncated ? 1 : 0)) break;
    out += segment; used += size;
  }
  if (truncated) { out += '~'; used++; }
  return out + (pad ? ' '.repeat(Math.max(0, columns - used)) : '');
}

export function wrap(text, columns) {
  columns = Math.max(1, columns);
  const result = [];
  for (const paragraph of clean(text).split('\n')) {
    let line = '';
    for (const { segment } of segmenter.segment(paragraph)) {
      const part = width(segment) > columns ? '?' : segment;
      if (width(line + part) > columns) {
        const space = line.lastIndexOf(' ');
        if (space > 0 && part !== ' ') {
          result.push(line.slice(0, space));
          line = line.slice(space + 1);
        } else { result.push(line.trimEnd()); line = ''; }
        if (width(line + part) > columns) { result.push(line); line = ''; }
      }
      line += part;
    }
    result.push(line.trimEnd());
  }
  return result;
}

function counts(tasks) {
  const completed = tasks.filter(task => task.status === 'completed').length;
  const dropped = tasks.filter(task => task.status === 'abandoned').length;
  return { total: tasks.length, closed: completed + dropped, completed, dropped };
}
export const isClosedPhase = phase => phase.tasks.length > 0 &&
  phase.tasks.every(task => ['completed', 'abandoned'].includes(task.status));
const clamp = (value, max) => Math.min(Math.max(0, Math.floor(value || 0)), Math.max(0, max));

// Retain native display identity, never the projection's pending fallback.
export function runningTarget(snapshot, previous) {
  const targets = (snapshot?.phases ?? []).flatMap((phase, phaseIndex) =>
    phase.tasks.flatMap((task, taskIndex) => task.status === 'in_progress' ? [{
      phaseIndex, taskIndex, phaseName: phase.name,
      key: snapshot.phaseSummaries[phaseIndex].taskKeys[taskIndex], ...task,
    }] : []));
  return targets.find(target => target.key === previous?.key) ?? targets[0] ?? null;
}

export function renderFrame(snapshot, { columns = 80, rows = 24, language = 'en',
  availability = snapshot?.availability ?? 'waiting', error = '', color = true,
  scroll = 0, askScroll = 0, revealTarget = false, target = snapshot?.target, follow = true, completedExpanded = false,
  completionFrames = new Map() } = {}) {
  // Keep the terminal's final cell free, as in the existing DAG renderer.
  // ConPTY can otherwise wrap a wide glyph before the following cursor move.
  columns = Math.max(1, Math.floor(columns) - 1);
  rows = Math.max(1, Math.floor(rows));
  const phases = snapshot?.phases ?? [];
  const total = counts(phases.flatMap(phase => phase.tasks));
  const tally = count => `${count.closed}/${count.total}${columns >= 24 ? ` ${t(language, 'closed')}` : ''} ${t(language, 'completed')}:${count.completed} ${t(language, 'dropped')}:${count.dropped}`;
  const source = error && availability === 'current' ? 'error' : availability;
  const head = `${t(language, 'todo')} | ${t(language, source)}`;
  const current = `${t(language, 'now')}: ${target ? clean(target.content) : t(language, 'idle')}`;
  const taskRanges = Object.create(null), phaseRanges = Object.create(null);
  const bodyLines = [];
  const phaseOccurrences = new Map();
  // Closed phases have no summary row: the header's [closed/total] already counts them, and 'c' still expands them.
  const closedRange = null;
  // Compact layout: only phases holding active work (else the first open phase) list their tasks;
  // the others keep a one-row header that the closed-summary toggle expands.
  const openPhases = new Set(phases.flatMap((phase, index) =>
    phase.tasks.some(task => task.status === 'in_progress') ? [index] : []));
  if (!openPhases.size && phases.some(phase => !isClosedPhase(phase))) openPhases.add(phases.findIndex(phase => !isClosedPhase(phase)));
  const foldRanges = [];
  for (const [phaseIndex, phase] of phases.entries()) {
    const occurrence = phaseOccurrences.get(phase.name) ?? 0;
    phaseOccurrences.set(phase.name, occurrence + 1);
    const phaseKey = snapshot?.phaseSummaries?.[phaseIndex]?.key ?? JSON.stringify([phase.name, occurrence]);
    if (isClosedPhase(phase) && !completedExpanded) continue;
    const folded = !completedExpanded && phase.tasks.length > 0 && !isClosedPhase(phase) && !openPhases.has(phaseIndex);
    const start = bodyLines.length;
    const count = counts(phase.tasks);
    const summary = `${count.closed}/${count.total}${count.dropped ? ` ${t(language, 'dropped')}:${count.dropped}` : ''}${folded ? ' [+]' : ''}`;
    // Each phase title is a divider row "─ name n/m ───"; only the phase holding the current work keeps a colour.
    const nameRoom = columns - width(summary) - 5;
    const label = fit(nameRoom > 0 ? `${fit(phase.name, nameRoom)} ${summary}` : summary, Math.max(1, columns - 3));
    const tail = '─'.repeat(Math.max(0, columns - width(label) - 3));
    bodyLines.push(openPhases.has(phaseIndex) && !isClosedPhase(phase)
      ? `${paint('─ ', 'muted', color)}${paint(label, 'activePhase', color, true)}${paint(` ${tail}`, 'muted', color)}`
      : paint(`─ ${label} ${tail}`, 'muted', color));
    const taskOccurrences = new Map();
    if (folded) foldRanges.push({ start, end: bodyLines.length });
    for (const [taskIndex, task] of (folded ? [] : phase.tasks).entries()) {
      const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
      taskOccurrences.set(task.content, taskOccurrence + 1);
      const key = snapshot?.phaseSummaries?.[phaseIndex]?.taskKeys?.[taskIndex] ??
        JSON.stringify([phase.name, occurrence, task.content, taskOccurrence]);
      const taskStart = bodyLines.length;
      const prefix = `${target?.key === key ? '>' : ' '}${marks[task.status]} `;
      const wrapped = wrap(task.content, columns - layout.taskInset);
      const strikeText = `${prefix}${wrapped.join('')}`;
      const reveal = strikeRevealCount(strikeText, completionFrames.get(key));
      let consumed = 0;
      for (const [index, line] of wrapped.entries()) {
        const inset = index === 0 ? prefix : ' '.repeat(layout.taskInset);
        const text = `${inset}${line}`;
        bodyLines.push(task.status === 'completed' ? completedLine(text,
          reveal === undefined ? undefined : index === 0 ? reveal :
            reveal <= consumed ? 0 : layout.taskInset + reveal - consumed, color) :
          paint(text, task.status, color, task.status === 'in_progress'));
        consumed += [...(index === 0 ? text : line)].length;
      }
      taskRanges[key] = { start: taskStart, end: bodyLines.length, phaseStart: start, status: task.status };
    }
    if (!phase.tasks.length) bodyLines.push(fit(t(language, 'emptyPhase'), columns));
    phaseRanges[phaseKey] = { start, end: bodyLines.length };
  }
  if (!phases.length) bodyLines.push(...wrap(t(language,
    availability === 'waiting' ? 'waitingBody' : availability === 'empty' ? 'emptyBody' : 'errorBody'), columns));

  if (rows <= layout.fallbackRows || columns < layout.fallbackColumns) {
    const fallback = columns === 1
      ? [availability === 'current' ? '*' : availability === 'empty' ? '0' :
        availability === 'error' ? '!' : availability === 'waiting' ? '?' : '~']
      : [head, tally(total), current, error ? t(language, 'readError', { error }) :
        t(language, 'position', { start: 0, end: 0, total: bodyLines.length })];
    const lines = fallback.slice(0, rows).map(line => fit(line, columns));
    while (lines.length < rows) lines.push('');
    return { text: lines.join('\n'), lines, bodyLines, taskRanges, phaseRanges,
      scroll, askScroll, bodyStart: 0, bodyRows: 0, askRows: 0, closedRange, foldRanges };
  }
  const headStyle = ['last-known', 'disconnected'].includes(source) ? 'warning' : source === 'error' ? 'error' : 'accent';
  // One header row "Todo [closed/total]  done:n · drop:n" under which a divider runs; the live state is
  // only in the footer. The current task is the marked body row, so no Now or Ask row repeats it.
  const name = `${t(language, 'todo')} [${total.closed}/${total.total}]`;
  const detail = `${t(language, 'completed')}:${total.completed} · ${t(language, 'dropped')}:${total.dropped}`;
  const divider = paint('─'.repeat(columns), 'muted', color);
  const top = [width(`${name}  ${detail}`) <= columns
    ? `${paint(t(language, 'todo'), headStyle, color, true)} ${paint(`[${total.closed}/${total.total}]`, 'activePhase', color, true)}  ${paint(detail, 'muted', color)}`
    : paint(fit(name, columns), headStyle, color, true), divider];
  const room = rows - top.length - 2 - Number(Boolean(error));
  const askRows = 0, ask = [];
  askScroll = 0;
  const bodyRows = Math.max(0, room - ask.length);
  const active = taskRanges[target?.key];
  if (revealTarget && active && bodyRows > 0 &&
    (active.start < scroll || active.start + Math.min(active.end - active.start, bodyRows) > scroll + bodyRows)) {
    scroll = active.start - active.phaseStart < bodyRows ? active.phaseStart : active.start;
  }
  scroll = clamp(scroll, bodyLines.length - bodyRows);
  const visible = bodyLines.slice(scroll, scroll + bodyRows);
  while (visible.length < bodyRows) visible.push('');
  const live = !error && ['current', 'empty'].includes(availability);
  // Below 40 columns every pane shortens the follow label the same way.
  const footer = `${t(language, columns < 40 ? follow && live ? 'followShortOn' : 'followShortOff' :
    follow && live ? 'followOn' : 'followOff')} · ${t(language, source)}`;
  const lines = [...top, ...ask, ...visible,
    ...(error ? [paint(fit(t(language, 'readError', { error: clean(error) }), columns), 'error', color)] : []),
    divider, paint(fit(footer, columns), live ? 'accent' : 'warning', color)].slice(0, rows);
  return { text: lines.join('\n'), lines, bodyLines, taskRanges, phaseRanges, scroll, askScroll,
    bodyStart: top.length + ask.length, bodyRows, askRows, closedRange, foldRanges };
}

export const render = (snapshot, options) => renderFrame(snapshot, options).text;
