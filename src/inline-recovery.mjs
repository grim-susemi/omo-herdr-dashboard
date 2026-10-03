// Owned read-only recovery, not a copy of the native Todo renderer or engine.
export function inlineRecoveryLines(snapshot, availability = 'current') {
  const lines = [`[owned Todo recovery: ${availability}; not native renderer]`];
  if (!snapshot) return [...lines, 'Current branch Todo unavailable'];
  const count = snapshot.counts;
  lines.push(`Todo: ${count.closed}/${count.total} closed; completed=${count.completed}; dropped=${count.dropped}`);
  if (snapshot.ask) lines.push(`Ask: ${snapshot.ask.text}`);
  for (const [index, phase] of snapshot.phases.entries()) {
    const counts = snapshot.phaseSummaries[index].counts;
    lines.push(`${phase.name}: ${counts.closed}/${counts.total} closed; completed=${counts.completed}; dropped=${counts.dropped}`);
    for (const task of phase.tasks) lines.push(`${task.status}: ${task.content}`);
  }
  return lines;
}

/** Prepare immutable information before masking; each invocation is fresh. */
export function inlineRecoveryFactory(snapshot, availability = 'current') {
  const lines = inlineRecoveryLines(snapshot && structuredClone(snapshot), availability);
  return () => {
    let disposed = false;
    return {
      render(width) {
        if (disposed) return [];
        const limit = Math.max(1, Math.floor(width));
        const result = [];
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        for (const line of lines) {
          // Strip terminal controls; retain every text line, including Korean.
          for (const text of line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').split('\n')) {
            let row = '';
            let cells = 0;
            for (const { segment } of segmenter.segment(text)) {
              const point = segment.codePointAt(0);
              const size = /\p{Extended_Pictographic}/u.test(segment) ||
                (point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf ||
                  point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff ||
                  point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 ||
                  point >= 0xffe0 && point <= 0xffe6 || point >= 0x20000)) ? 2 : 1;
              if (cells + size > limit && row) {
                result.push(row);
                row = '';
                cells = 0;
              }
              // A double-cell grapheme cannot fit a one-cell host.
              row += size > limit ? '?' : segment;
              cells += Math.min(size, limit);
            }
            result.push(row);
          }
        }
        return result;
      },
      invalidate() {},
      dispose() { disposed = true; },
    };
  };
}
