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
const style = { accent: '36', completed: '32', abandoned: '90', pending: '90',
  in_progress: '36', warning: '33', error: '31' };
const layout = { taskInset: 3, askMaxRows: 3, minimumWorkRows: 2, fallbackColumns: 16, fallbackRows: 4 };
const marks = { pending: '.', in_progress: '*', completed: 'x', abandoned: '-' };
const paint = (text, token, enabled) => enabled && style[token] ? `\x1b[${style[token]}m${text}\x1b[0m` : text;
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
const clamp = (value, max) => Math.min(Math.max(0, Math.floor(value || 0)), Math.max(0, max));

export function renderFrame(snapshot, { columns = 80, rows = 24, language = 'en',
  availability = snapshot?.availability ?? 'waiting', error = '', color = true,
  scroll = 0, askScroll = 0, revealTarget = false } = {}) {
  // Keep the terminal's final cell free, as in the existing DAG renderer.
  // ConPTY can otherwise wrap a wide glyph before the following cursor move.
  columns = Math.max(1, Math.floor(columns) - 1);
  rows = Math.max(1, Math.floor(rows));
  const phases = snapshot?.phases ?? [];
  const total = counts(phases.flatMap(phase => phase.tasks));
  const tally = count => `${count.closed}/${count.total}${columns >= 24 ? ` ${t(language, 'closed')}` : ''} ${t(language, 'completed')}:${count.completed} ${t(language, 'dropped')}:${count.dropped}`;
  const target = snapshot?.target;
  const head = `${t(language, 'todo')} | ${t(language, availability)}`;
  const current = `${t(language, 'now')}: ${target ? clean(target.content) : t(language, 'idle')}`;
  const taskRanges = Object.create(null), phaseRanges = Object.create(null);
  const bodyLines = [];
  if (error) bodyLines.push(...wrap(t(language, 'readError', { error: clean(error) }), columns));
  const phaseOccurrences = new Map();
  for (const [phaseIndex, phase] of phases.entries()) {
    const occurrence = phaseOccurrences.get(phase.name) ?? 0;
    phaseOccurrences.set(phase.name, occurrence + 1);
    const phaseKey = snapshot?.phaseSummaries?.[phaseIndex]?.key ?? JSON.stringify([phase.name, occurrence]);
    const start = bodyLines.length;
    const count = counts(phase.tasks);
    const summary = `${count.closed}/${count.total} ${t(language, 'completed')}:${count.completed} ${t(language, 'dropped')}:${count.dropped}`;
    const nameRoom = columns - width(summary) - 1;
    if (nameRoom > 0) bodyLines.push(paint(`${fit(phase.name, nameRoom)} ${summary}`, 'accent', color));
    else bodyLines.push(paint(fit(phase.name, columns), 'accent', color), ...wrap(summary, columns));
    const taskOccurrences = new Map();
    for (const [taskIndex, task] of phase.tasks.entries()) {
      const taskOccurrence = taskOccurrences.get(task.content) ?? 0;
      taskOccurrences.set(task.content, taskOccurrence + 1);
      const key = snapshot?.phaseSummaries?.[phaseIndex]?.taskKeys?.[taskIndex] ??
        JSON.stringify([phase.name, occurrence, task.content, taskOccurrence]);
      const taskStart = bodyLines.length;
      const prefix = `${target?.key === key ? '>' : ' '}${marks[task.status]} `;
      for (const [index, line] of wrap(task.content, columns - layout.taskInset).entries()) {
        bodyLines.push(paint(`${index === 0 ? prefix : ' '.repeat(layout.taskInset)}${line}`, task.status, color));
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
      scroll, askScroll, bodyRows: 0, askRows: 0 };
  }
  const top = [paint(fit(head, columns), ['last-known', 'disconnected'].includes(availability) ? 'warning' :
    availability === 'error' ? 'error' : 'accent', color), fit(tally(total), columns), fit(current, columns)];
  const askLines = wrap(snapshot?.ask?.text ?? t(language, 'noAsk'), columns);
  const room = rows - top.length - 1;
  const askBudget = Math.min(layout.askMaxRows + 1, Math.max(0, room - layout.minimumWorkRows));
  const askRows = askBudget > 1 ? askBudget - 1 : askBudget;
  askScroll = clamp(askScroll, askLines.length - askRows);
  const ask = [];
  if (askBudget > 1) {
    ask.push(paint(fit(`${t(language, 'ask')} ${askScroll + 1}-${Math.min(askScroll + askRows, askLines.length)}/${askLines.length} [a/z]`, columns), 'accent', color));
    ask.push(...askLines.slice(askScroll, askScroll + askRows));
    while (ask.length < askBudget) ask.push('');
  } else if (askBudget === 1) {
    const label = `${t(language, 'ask')} ${askScroll + 1}/${askLines.length}: `;
    const narrowAsk = wrap(snapshot?.ask?.text ?? t(language, 'noAsk'), Math.max(1, columns - width(label)));
    askScroll = clamp(askScroll, narrowAsk.length - 1);
    ask.push(fit(`${t(language, 'ask')} ${askScroll + 1}/${narrowAsk.length}: ${narrowAsk[askScroll]}`, columns));
  }
  const bodyRows = Math.max(0, room - ask.length);
  const active = taskRanges[target?.key];
  if (revealTarget && active && bodyRows > 0 &&
    (active.start < scroll || active.start + Math.min(active.end - active.start, bodyRows) > scroll + bodyRows)) {
    scroll = active.start - active.phaseStart < bodyRows ? active.phaseStart : active.start;
  }
  scroll = clamp(scroll, bodyLines.length - bodyRows);
  const visible = bodyLines.slice(scroll, scroll + bodyRows);
  while (visible.length < bodyRows) visible.push('');
  const footer = t(language, 'controls');
  const lines = [...top, ...ask, ...visible, paint(fit(footer, columns), 'pending', color)].slice(0, rows);
  return { text: lines.join('\n'), lines, bodyLines, taskRanges, phaseRanges, scroll, askScroll, bodyRows, askRows };
}

export const render = (snapshot, options) => renderFrame(snapshot, options).text;
