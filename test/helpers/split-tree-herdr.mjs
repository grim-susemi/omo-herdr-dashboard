// Deterministic split-tree model of the Herdr pane verbs used by the dashboard
// layout code. Inject `herdr` wherever the scripted fake in
// test/managed-layout.test.mjs is injected; it takes the same (...args) shape.
//
// Model: one tab whose panes are the leaves of a binary split tree. Each split
// has a direction ('right' = side by side, 'down' = stacked) and the share of
// its first child. Child rectangles are rounded exactly like the resize
// verification at packages/todo/src/controller.mjs:1213-1218. A new split keeps
// the source pane as the first child and gives it `--ratio` (assumption until
// the isolated Herdr measurement says otherwise; see `splitRatioOwner`).
// `resize --amount` is a fraction of the tab area along the moved axis, as
// arrangeDashboard issues it.
//
// Errors carry `code`: 'pane_not_found' for an unknown pane (the shape the
// controllers treat as authoritative absence), 'invalid_argument' for malformed
// input, 'unknown_command' for unmodelled verbs. A rejected call never changes
// the tree. No timers, no randomness.

const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => fail('invalid_argument', message);
const keys = ['x', 'y', 'width', 'height'];

export function childRects(rect, direction, ratio) {
  const axis = direction === 'right' ? 'width' : 'height';
  const coordinate = direction === 'right' ? 'x' : 'y';
  const size = Math.round(Math.fround(rect[axis] * Math.fround(ratio)));
  return [{ ...rect, [axis]: size }, { ...rect, [coordinate]: rect[coordinate] + size, [axis]: rect[axis] - size }];
}

export function createSplitTreeHerdr({ tree, area = { x: 0, y: 0, width: 100, height: 40 }, focused,
  tabId = 'tab', workspaceId = 'workspace', idPrefix = 'created', minSize = 1, shellPid = 100,
  splitRatioOwner = 'source' } = {}) {
  let splitSerial = 0, paneSerial = 0;
  const build = spec => typeof spec === 'string' ? { pane: spec } : { id: `split-${++splitSerial}`,
    direction: spec.direction, ratio: spec.ratio, first: build(spec.first), second: build(spec.second) };
  let root = build(tree);
  area = Object.fromEntries(keys.map(key => [key, area[key]]));
  const calls = [];

  const walk = (node = root, rect = { ...area }, out = { panes: [], splits: [], places: new Map() }, parent = null) => {
    if (node.pane) {
      out.panes.push({ pane_id: node.pane, rect });
      out.places.set(node.pane, { node, rect, parent });
      return out;
    }
    out.splits.push({ id: node.id, direction: node.direction, ratio: node.ratio, rect });
    const [a, b] = childRects(rect, node.direction, node.ratio);
    walk(node.first, a, out, node); walk(node.second, b, out, node);
    return out;
  };
  const paneIds = () => walk().panes.map(pane => pane.pane_id);
  if (new Set(paneIds()).size !== paneIds().length) throw invalid('duplicate pane ids in tree');
  let focus = focused ?? paneIds()[0];

  const option = (args, name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const place = id => {
    const found = walk().places.get(id);
    if (!found) throw fail('pane_not_found', `pane ${id} not found`);
    return found;
  };
  const parentOf = (node, current = root, parent = null) => {
    if (current === node) return parent;
    if (current.pane) return undefined;
    return parentOf(node, current.first, current) ?? parentOf(node, current.second, current);
  };
  const replace = (node, replacement) => {
    const parent = parentOf(node);
    if (!parent) root = replacement;
    else if (parent.first === node) parent.first = replacement;
    else parent.second = replacement;
  };
  // Apply a change, then reject it (restoring the tree) if any pane is too small.
  const commit = (change) => {
    const saved = structuredClone(root), savedFocus = focus, savedSerials = [splitSerial, paneSerial];
    try {
      const result = change();
      if (walk().panes.some(pane => pane.rect.width < minSize || pane.rect.height < minSize))
        throw invalid('operation would shrink a pane below the minimum size');
      return result;
    } catch (error) {
      root = saved; focus = savedFocus; [splitSerial, paneSerial] = savedSerials;
      throw error;
    }
  };
  const fraction = (value, name) => {
    const number = Number(value);
    if (value === undefined || !Number.isFinite(number) || number <= 0 || number >= 1)
      throw invalid(`${name} must be a number between 0 and 1`);
    return number;
  };
  const layout = () => {
    const { panes, splits } = walk();
    return { tab_id: tabId, workspace_id: workspaceId, focused_pane_id: focus, zoomed: false,
      area: { ...area }, panes, splits };
  };
  const neighborOf = (id, direction) => {
    if (!['left', 'right', 'up', 'down'].includes(direction)) throw invalid(`invalid direction ${direction}`);
    const { panes } = walk(), from = place(id).rect;
    const horizontal = direction === 'left' || direction === 'right';
    const [coordinate, axis, cross, crossSize] = horizontal ? ['x', 'width', 'y', 'height'] : ['y', 'height', 'x', 'width'];
    const forward = direction === 'right' || direction === 'down';
    const edge = forward ? from[coordinate] + from[axis] : from[coordinate];
    const overlap = rect => Math.min(rect[cross] + rect[crossSize], from[cross] + from[crossSize]) -
      Math.max(rect[cross], from[cross]);
    return panes.filter(pane => pane.pane_id !== id && overlap(pane.rect) > 0 &&
      (forward ? pane.rect[coordinate] : pane.rect[coordinate] + pane.rect[axis]) === edge)
      .sort((a, b) => overlap(b.rect) - overlap(a.rect) || a.rect[cross] - b.rect[cross])[0]?.pane_id ?? null;
  };

  const verbs = {
    list: () => ({ panes: paneIds().map(pane_id => ({ pane_id, tab_id: tabId, focused: pane_id === focus })) }),
    get: args => { place(args[1]); return { pane: { pane_id: args[1], tab_id: tabId, focused: args[1] === focus } }; },
    layout: args => { const id = option(args, '--pane'); if (id !== undefined) place(id); return { layout: layout() }; },
    'process-info': args => {
      const id = option(args, '--pane'); place(id);
      return { process_info: { pane_id: id, shell_pid: shellPid, foreground_processes: [] } };
    },
    run: args => { place(option(args, '--pane') ?? args[1]); return {}; },
    split: args => {
      const { node } = place(option(args, '--pane'));
      const direction = option(args, '--direction');
      if (!['right', 'down'].includes(direction)) throw invalid(`invalid split direction ${direction}`);
      const ratio = option(args, '--ratio') === undefined ? 0.5 : fraction(option(args, '--ratio'), 'ratio');
      return commit(() => {
        const pane_id = `${idPrefix}-${++paneSerial}`;
        replace(node, { id: `split-${++splitSerial}`, direction,
          ratio: splitRatioOwner === 'source' ? ratio : 1 - ratio, first: { pane: node.pane }, second: { pane: pane_id } });
        if (!args.includes('--no-focus')) focus = pane_id;
        return { pane: { pane_id, tab_id: tabId } };
      });
    },
    swap: args => {
      const source = place(option(args, '--source-pane')).node, target = place(option(args, '--target-pane')).node;
      if (source === target) throw invalid('swap requires two different panes');
      [source.pane, target.pane] = [target.pane, source.pane];
      focus = target.pane;
      return {};
    },
    close: args => {
      const { node, parent } = place(args[1]);
      if (!parent) throw invalid('cannot close the last pane');
      const sibling = parent.first === node ? parent.second : parent.first;
      replace(parent, sibling);
      if (focus === node.pane) {
        let leaf = sibling;
        while (!leaf.pane) leaf = leaf.first;
        focus = leaf.pane;
      }
      return {};
    },
    resize: args => {
      const id = option(args, '--pane'), { rect } = place(id), direction = option(args, '--direction');
      if (!['left', 'right', 'up', 'down'].includes(direction)) throw invalid(`invalid resize direction ${direction}`);
      const amount = fraction(option(args, '--amount'), 'amount');
      const orientation = direction === 'left' || direction === 'right' ? 'right' : 'down';
      const [coordinate, axis] = orientation === 'right' ? ['x', 'width'] : ['y', 'height'];
      const forward = direction === 'right' || direction === 'down';
      const { splits } = walk(), ancestors = [];
      for (let node = place(id).node, parent = parentOf(node); parent; node = parent, parent = parentOf(parent))
        if (parent.direction === orientation) ancestors.push(parent);
      const divider = split => {
        const info = splits.find(value => value.id === split.id);
        const [first] = childRects(info.rect, split.direction, split.ratio);
        return { split, rect: info.rect, first, edge: first[coordinate] + first[axis] };
      };
      // Same preference as the controller's resize verification: forward moves
      // take the divider on the far edge, backward moves the near edge.
      const nearEdge = rect[coordinate], farEdge = nearEdge + rect[axis];
      const at = edge => ancestors.map(divider).find(value => value.edge === edge);
      const chosen = forward ? at(farEdge) ?? at(nearEdge) : at(nearEdge) ?? at(farEdge);
      if (!chosen) throw invalid(`no ${direction} divider to resize`);
      const ratio = (chosen.first[axis] + (forward ? 1 : -1) * amount * area[axis]) / chosen.rect[axis];
      if (!(ratio > 0 && ratio < 1)) throw invalid('resize would collapse a pane');
      return commit(() => { chosen.split.ratio = ratio; return {}; });
    },
    focus: args => {
      const id = option(args, '--pane'); place(id);
      const next = neighborOf(id, option(args, '--direction'));
      if (!next) throw invalid('no neighbor in that direction');
      focus = next;
      return {};
    },
    neighbor: args => {
      const id = option(args, '--pane'); place(id);
      return { neighbor: { pane_id: id, neighbor_pane_id: neighborOf(id, option(args, '--direction')), layout: layout() } };
    },
  };

  const herdr = async (...args) => {
    calls.push([...args]);
    const verb = verbs[args[0]];
    if (!Object.hasOwn(verbs, args[0])) throw fail('unknown_command', `unexpected native command: ${args[0]}`);
    return verb(args);
  };
  return { herdr, layout, calls, panes: paneIds, focused: () => focus };
}
