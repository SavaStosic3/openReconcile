import { newNode, newStream, NODE_TYPES } from './model.js';
import { appendUnitSymbol, getUnitGeometry, portPosition, unitBounds } from './unit-symbols.js';
import { formatPublishedMass, getPublishedUnitSummary, hasPublishedResults } from './published-results.js';

const NS = 'http://www.w3.org/2000/svg';
const BLUE = '#2563eb', INK = '#243a54', MUTED = '#7890aa';
const element = (tag, attrs = {}, content) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = String(content);
  return node;
};
const short = (value, length = 22) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
const boundary = node => node.kind === 'inlet' || node.kind === 'outlet';
const hasInput = node => node.kind !== 'inlet';
const hasOutput = node => node.kind !== 'outlet';
const number = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

export function createEditor({ svg, canEdit = () => true, onChange = () => {}, onSelect = () => {}, onEditStream = () => {}, onEditNode = () => {}, onStatus = () => {} }) {
  let model = { nodes: [], streams: [] }, results = null, selected = null, mode = 'select';
  let pendingSource = null, pointer = null, ignoreClickUntil = 0, destroyed = false, lastTap = null;
  let width = 900, height = 600, scale = 1, panX = 0, panY = 0;
  let previewPoint = null;
  let presentation = 'editing';
  const prefix = `flow-${crypto.randomUUID()}`;
  const listeners = [];
  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  };
  svg.setAttribute('role', 'application');
  svg.setAttribute('aria-label', 'Plant flowsheet');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('touch-action', 'none');
  svg.style.touchAction = 'none';
  svg.style.userSelect = 'none';

  function dimensions() {
    const rect = svg.getBoundingClientRect();
    width = Math.max(1, rect.width || 900);
    height = Math.max(1, rect.height || 600);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  function screenPoint(event) {
    const rect = svg.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * width / (rect.width || width), y: (event.clientY - rect.top) * height / (rect.height || height) };
  }
  function worldPoint(event) {
    const p = screenPoint(event);
    return { x: (p.x - panX) / scale, y: (p.y - panY) / scale };
  }
  function lookupNode(id) { return model.nodes.find(node => node.id === id); }
  const port = portPosition;
  function announce(message) { onStatus(message); }
  function editable() { return presentation === 'editing' && canEdit() === true; }
  function cancelMutation() {
    if (pointer?.type === 'node' || pointer?.type === 'connect') {
      if (pointer.type === 'node') {
        const node = lookupNode(pointer.nodeId);
        if (node) { node.x = pointer.x; node.y = pointer.y; }
      }
      try { svg.releasePointerCapture(pointer.id); } catch {}
      pointer = null;
      ignoreClickUntil = Date.now() + 180;
    }
    clearPending();
    if (mode === 'connect') mode = 'select';
  }
  function allowEdit() {
    if (editable()) return true;
    cancelMutation();
    render();
    announce('This model is read-only or locked.');
    return false;
  }
  function editItem(kind, id) {
    if (!allowEdit()) return false;
    if (kind === 'node') onEditNode(id); else onEditStream(id);
    return true;
  }
  function focusItem(kind, id) {
    const key = kind === 'node' ? 'data-node-id' : 'data-stream-id';
    for (const item of svg.querySelectorAll(`[${key}][tabindex]`)) if (item.getAttribute(key) === id) { item.focus({ preventScroll: true }); break; }
  }
  function selection(kind, id, focus = false) {
    const exists = kind === 'node' ? lookupNode(id) : model.streams.find(stream => stream.id === id);
    selected = exists ? { kind, id } : null;
    onSelect(selected && { ...selected });
    render();
    if (focus && selected) focusItem(kind, id);
  }
  function clearPending() { pendingSource = null; previewPoint = null; }
  function connect(sourceId, targetId) {
    if (!allowEdit()) return false;
    const source = lookupNode(sourceId), target = lookupNode(targetId);
    if (!source || !target) return false;
    if (sourceId === targetId) { announce('Choose a different process unit for the destination.'); return false; }
    if (!hasOutput(source)) { announce('Outflows cannot have outgoing streams.'); return false; }
    if (!hasInput(target)) { announce('Inflows cannot have incoming streams.'); return false; }
    if (model.streams.length >= 500) { announce('This model supports up to 500 streams.'); return false; }
    const stream = newStream(sourceId, targetId, model.streams.length + 1);
    model.streams.push(stream);
    clearPending();
    onChange();
    selection('stream', stream.id);
    announce(`${stream.name} connected. Double-click the stream to add a measurement.`);
    return true;
  }
  function beginConnection(node) {
    if (!allowEdit()) return false;
    if (!node) { clearPending(); render(); return; }
    if (!hasOutput(node)) { announce('Choose an inflow or process unit as the source.'); return; }
    pendingSource = node.id;
    previewPoint = port(node, 'out');
    render();
    announce(`Connecting from ${node.name}. Choose a destination or press Escape to cancel.`);
  }
  function tapItem(kind, id) {
    const now = Date.now();
    const doubleTap = lastTap?.kind === kind && lastTap.id === id && now - lastTap.time < 420;
    lastTap = { kind, id, time: now };
    selection(kind, id);
    if (doubleTap) { lastTap = null; editItem(kind, id); }
  }

  function route(stream) {
    const source = lookupNode(stream.source), target = lookupNode(stream.target);
    if (!source || !target) return null;
    const s = port(source, 'out'), t = port(target, 'in');
    const parallel = model.streams.filter(edge => edge.source === stream.source && edge.target === stream.target);
    const index = parallel.findIndex(edge => edge.id === stream.id);
    const lane = (index - (parallel.length - 1) / 2) * 32;
    const routed = (d, label, xs, ys) => ({ d, label, bounds: { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) } });
    if (t.x - s.x > 85) {
      const mid = (s.x + t.x) / 2 + lane;
      if (Math.abs(s.y - t.y) < 6 && parallel.length > 1) {
        const y = s.y + lane;
        return routed(`M ${s.x} ${s.y} H ${s.x + 34} V ${y} H ${t.x - 34} V ${t.y} H ${t.x}`, { x: (s.x + t.x) / 2, y }, [s.x, s.x + 34, t.x - 34, t.x], [s.y, t.y, y]);
      }
      return routed(`M ${s.x} ${s.y} H ${mid} V ${t.y} H ${t.x}`, { x: mid, y: (s.y + t.y) / 2 }, [s.x, mid, t.x], [s.y, t.y]);
    }
    const bottom = Math.max(unitBounds(source).bottom, unitBounds(target).bottom) + 65 + index * 32;
    return routed(`M ${s.x} ${s.y} H ${s.x + 42} V ${bottom} H ${t.x - 42} V ${t.y} H ${t.x}`, { x: (s.x + t.x) / 2, y: bottom }, [s.x, s.x + 42, t.x - 42, t.x], [s.y, t.y, bottom]);
  }
  function resultFor(stream) { return presentation === 'published' && !hasPublishedResults(results) ? null : results?.streams?.find(item => item.id === stream.id); }
  function drawStream(stream, layer) {
    const path = route(stream);
    if (!path) return;
    const active = selected?.kind === 'stream' && selected.id === stream.id;
    const output = resultFor(stream);
    const color = active ? BLUE : output?.status === 'unobservable' ? '#bc8c3f' : MUTED;
    const group = element('g', { class: `flow-stream${active ? ' is-selected' : ''}`, 'data-stream-id': stream.id, tabindex: '0', role: 'button', 'aria-label': `${stream.name}, ${stream.measured ? 'measured' : 'unmeasured'} stream. ${editable() ? 'Press Enter to edit.' : 'Read-only.'}`, 'aria-pressed': active });
    group.append(element('title', {}, `${stream.name} · ${stream.material}\n${stream.measured ? `Measured: ${stream.value} ${stream.unit}` : 'No measurement; value may be estimated from the balance.'}`));
    group.append(element('path', { d: path.d, fill: 'none', stroke: color, 'stroke-width': active ? 3 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': stream.measured ? 'none' : '7 5', 'marker-end': `url(#${prefix}-${active ? 'selected' : 'arrow'})` }));
    group.append(element('path', { d: path.d, fill: 'none', stroke: 'transparent', 'stroke-width': 20, 'pointer-events': 'stroke', cursor: 'pointer', class: 'flow-stream-hit' }));
    const label = element('g', { transform: `translate(${path.label.x} ${path.label.y - 15})`, class: 'flow-stream-label', cursor: 'pointer' });
    const name = short(stream.name, 18);
    const labelWidth = Math.max(56, name.length * 6.6 + (stream.measured ? 34 : 22));
    label.append(element('rect', { x: -labelWidth / 2, y: -13, width: labelWidth, height: 24, rx: 6, fill: '#fff', stroke: active ? '#a8c9ff' : '#e3eaf3', 'stroke-width': 1 }));
    if (stream.measured) {
      const meterX = -labelWidth / 2 + 13;
      label.append(element('circle', { cx: meterX, cy: -1, r: 7, fill: '#edf4ff', stroke: active ? BLUE : '#688bb7', 'stroke-width': 1.2 }));
      label.append(element('text', { x: meterX, y: 2, fill: active ? BLUE : '#688bb7', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 8, 'font-weight': 700 }, 'M'));
    }
    label.append(element('text', { x: stream.measured ? 7 : 0, y: 3, fill: active ? BLUE : INK, 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 11, 'font-weight': 650 }, name));
    if (output) {
      const value = Number.isFinite(output.value) ? `${presentation === 'published' ? formatPublishedMass(output.value) : number(output.value)} kg` : 'Unobservable';
      label.append(element('text', { x: 0, y: 27, fill: output.status === 'unobservable' ? '#9c6d24' : '#426184', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 10, 'font-weight': 600, 'paint-order': 'stroke', stroke: '#f7f9fc', 'stroke-width': 4, 'stroke-linejoin': 'round' }, `${value}${output.status === 'estimated' ? ' · inferred' : ''}`));
    }
    group.append(label);
    layer.append(group);
  }
  function drawPort(node, type, group) {
    if (type === 'in' && !hasInput(node) || type === 'out' && !hasOutput(node)) return;
    const x = port(node, type).x - node.x;
    const pending = pendingSource === node.id && type === 'out';
    const wrapper = element('g', { 'data-port': type, 'data-node-id': node.id, cursor: editable() ? 'crosshair' : 'default', class: `flow-port flow-port-${type}` });
    wrapper.append(element('circle', { cx: x, cy: 0, r: 13, fill: 'transparent', 'pointer-events': 'all' }));
    wrapper.append(element('circle', { cx: x, cy: 0, r: pending ? 7 : 5, fill: pending ? BLUE : '#fff', stroke: pending ? BLUE : '#82a5d0', 'stroke-width': 2 }));
    wrapper.append(element('title', {}, editable() ? type === 'out' ? 'Drag from this port to connect a stream' : 'Drop a stream here' : 'This model is read-only or locked.'));
    group.append(wrapper);
  }
  function drawNode(node, layer) {
    const active = selected?.kind === 'node' && selected.id === node.id;
    const pending = pendingSource === node.id;
    const summary = presentation === 'published' ? getPublishedUnitSummary(node, model, results) : null;
    const group = element('g', { transform: `translate(${node.x} ${node.y})`, 'data-node-id': node.id, tabindex: 0, role: 'button', 'aria-label': `${node.name}, ${NODE_TYPES[node.kind]}. ${editable() ? 'Press Enter to edit.' : 'Read-only.'}${summary ? ` ${summary.description}` : ''}`, 'aria-pressed': active, class: `flow-node flow-node-${node.kind}${active ? ' is-selected' : ''}${pending ? ' is-connecting' : ''}`, cursor: editable() ? mode === 'connect' ? 'crosshair' : 'grab' : 'pointer' });
    group.append(element('title', {}, `${node.name} · ${NODE_TYPES[node.kind]}\n${editable() ? 'Drag to move. Double-click to edit.' : 'This model is read-only or locked.'}${summary ? `\n${summary.description}` : ''}`));
    if (boundary(node)) {
      if (active || pending) group.append(element('rect', { x: -38, y: -38, width: 76, height: 76, rx: 18, fill: '#e9f1ff', stroke: '#a5c8ff', 'stroke-width': 1.5 }));
      group.append(element('path', { d: 'M -21 -23 L 24 0 L -21 23 Z', fill: '#ee6666', stroke: '#d74c54', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
      group.append(element('path', { d: 'M -10 0 H 8 M 2 -5 L 8 0 L 2 5', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      group.append(element('text', { y: 48, fill: INK, 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 12, 'font-weight': 650 }, short(node.name)));
      group.append(element('text', { y: 64, fill: '#8b9ab0', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 10 }, NODE_TYPES[node.kind]));
    } else {
      const geometry = getUnitGeometry(node.kind), bounds = geometry.bounds;
      // A generous invisible hit area keeps fine SVG strokes easy to select and drag.
      group.append(element('rect', { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, fill: 'transparent', 'pointer-events': 'all', class: 'flow-node-hit' }));
      if (active || pending) group.append(element('rect', { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, rx: 8, fill: '#eff6ff', stroke: active ? BLUE : '#a5c8ff', 'stroke-width': 1.3, 'stroke-dasharray': '4 4', 'pointer-events': 'none', class: 'flow-node-selection' }));
      const symbol = element('g', { class: 'flow-unit-symbol', 'aria-hidden': 'true' });
      appendUnitSymbol(node.kind, symbol, { stroke: active || pending ? BLUE : INK, fill: active || pending ? '#eff6ff' : '#fff', strokeWidth: 2 });
      group.append(symbol);
      group.append(element('text', { y: geometry.labelY, fill: INK, 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 12, 'font-weight': 650 }, short(node.name, 22)));
      group.append(element('text', { y: geometry.typeY, fill: '#7890aa', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 10 }, NODE_TYPES[node.kind]));
    }
    drawPort(node, 'in', group);
    drawPort(node, 'out', group);
    if (summary) {
      const { bounds } = summary;
      const badge = element('g', { class: 'flow-unit-result', 'data-result-status': summary.status, 'aria-hidden': 'true' });
      badge.append(element('rect', { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, rx: 8, fill: '#fff', stroke: summary.status === 'unresolved' ? '#dfcfa8' : '#c4dfdc', 'stroke-width': 1.2 }));
      badge.append(element('text', { x: 0, y: bounds.top + 18, fill: summary.status === 'awaiting' ? '#7890aa' : '#497c79', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 10, 'font-weight': 650 }, summary.heading));
      summary.lines.forEach((line, index) => badge.append(element('text', { x: 0, y: bounds.top + 36 + index * 18, fill: summary.status === 'unresolved' ? '#8b6a2e' : '#176b65', 'text-anchor': 'middle', 'font-family': 'inherit', 'font-size': 12, 'font-weight': 700 }, line)));
      group.append(badge);
    }
    layer.append(group);
  }

  function render() {
    if (destroyed) return;
    if (!editable()) cancelMutation();
    const focused = document.activeElement?.closest?.('[data-node-id][tabindex], [data-stream-id][tabindex]');
    const focusedKind = focused?.hasAttribute('data-node-id') ? 'node' : 'stream';
    const focusedId = focused?.getAttribute(focusedKind === 'node' ? 'data-node-id' : 'data-stream-id');
    svg.replaceChildren();
    svg.dataset.mode = mode;
    svg.dataset.presentation = presentation;
    svg.style.cursor = pointer?.type === 'pan' ? 'grabbing' : mode === 'pan' ? 'grab' : mode === 'connect' ? 'crosshair' : 'default';
    const defs = element('defs');
    const pattern = element('pattern', { id: `${prefix}-grid`, x: ((panX % (24 * scale)) + 24 * scale) % (24 * scale), y: ((panY % (24 * scale)) + 24 * scale) % (24 * scale), width: 24 * scale, height: 24 * scale, patternUnits: 'userSpaceOnUse' });
    pattern.append(element('circle', { cx: 1, cy: 1, r: 0.9, fill: '#d9e2ee' }));
    defs.append(pattern);
    for (const [name, color] of [['arrow', MUTED], ['selected', BLUE]]) {
      const marker = element('marker', { id: `${prefix}-${name}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto', markerUnits: 'userSpaceOnUse' });
      marker.append(element('path', { d: 'M 0 1 L 9 5 L 0 9 Z', fill: color }));
      defs.append(marker);
    }
    svg.append(defs, element('rect', { width: '100%', height: '100%', fill: '#f8fafd', class: 'flow-canvas-background' }), element('rect', { width: '100%', height: '100%', fill: `url(#${prefix}-grid)`, 'pointer-events': 'none' }));
    const world = element('g', { transform: `translate(${panX} ${panY}) scale(${scale})`, class: 'flow-world' });
    const streams = element('g', { class: 'flow-streams' });
    for (const stream of model.streams) drawStream(stream, streams);
    world.append(streams);
    if (pendingSource && previewPoint) {
      const source = lookupNode(pendingSource);
      if (source) {
        const start = port(source, 'out'), mid = (start.x + previewPoint.x) / 2;
        world.append(element('path', { d: `M ${start.x} ${start.y} H ${mid} V ${previewPoint.y} H ${previewPoint.x}`, stroke: BLUE, 'stroke-width': 2, 'stroke-dasharray': '6 4', fill: 'none', 'pointer-events': 'none', 'marker-end': `url(#${prefix}-selected)` }));
      }
    }
    const nodes = element('g', { class: 'flow-nodes' });
    for (const node of model.nodes) drawNode(node, nodes);
    world.append(nodes);
    svg.append(world);
    if (focusedId && svg.contains(document.activeElement) === false) focusItem(focusedKind, focusedId);
  }

  function addNode(kind, location) {
    if (!allowEdit()) return false;
    if (!NODE_TYPES[kind]) return;
    if (model.nodes.length >= 200) { announce('This model supports up to 200 units.'); return; }
    const center = location || { x: (width / 2 - panX) / scale, y: (height / 2 - panY) / scale };
    if (!location) {
      let attempt = 0;
      while (model.nodes.some(node => Math.abs(node.x - center.x) < 100 && Math.abs(node.y - center.y) < 90) && attempt++ < 15) { center.x += 30; center.y += 30; }
    }
    const node = newNode(kind, Math.round(center.x / 10) * 10, Math.round(center.y / 10) * 10, model.nodes.filter(item => item.kind === kind).length + 1);
    model.nodes.push(node);
    clearPending();
    onChange();
    selection('node', node.id);
    announce(`${node.name} added. Drag the unit to position it.`);
    return node;
  }
  function deleteSelection() {
    if (!allowEdit()) return false;
    if (!selected) return;
    const item = selected;
    const name = item.kind === 'node' ? lookupNode(item.id)?.name : model.streams.find(stream => stream.id === item.id)?.name;
    if (item.kind === 'node') {
      model.nodes = model.nodes.filter(node => node.id !== item.id);
      model.streams = model.streams.filter(stream => stream.source !== item.id && stream.target !== item.id);
    } else model.streams = model.streams.filter(stream => stream.id !== item.id);
    selected = null;
    clearPending();
    onSelect(null);
    onChange();
    render();
    svg.focus({ preventScroll: true });
    announce(`${name || 'Selection'} deleted.`);
  }
  function fit() {
    dimensions();
    if (!model.nodes.length) { scale = 1; panX = 0; panY = 0; render(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of model.nodes) {
      const bounds = unitBounds(node);
      minX = Math.min(minX, bounds.left); maxX = Math.max(maxX, bounds.right); minY = Math.min(minY, bounds.top); maxY = Math.max(maxY, bounds.bottom);
      if (presentation === 'published') {
        const badge = getPublishedUnitSummary(node, model, results).bounds;
        minX = Math.min(minX, node.x + badge.left); maxX = Math.max(maxX, node.x + badge.right);
        minY = Math.min(minY, node.y + badge.top); maxY = Math.max(maxY, node.y + badge.bottom);
      }
    }
    for (const stream of model.streams) {
      const path = route(stream);
      if (path) {
        const labelHalfWidth = Math.max(70, short(stream.name, 18).length * 3.3 + 17);
        minX = Math.min(minX, path.bounds.left, path.label.x - labelHalfWidth); maxX = Math.max(maxX, path.bounds.right, path.label.x + labelHalfWidth);
        minY = Math.min(minY, path.bounds.top, path.label.y - 40); maxY = Math.max(maxY, path.bounds.bottom, path.label.y + 40);
      }
    }
    const padding = 48;
    scale = Math.max(0.15, Math.min(1.4, (width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY)));
    panX = width / 2 - (minX + maxX) / 2 * scale;
    panY = height / 2 - (minY + maxY) / 2 * scale;
    render();
  }
  function zoomAt(delta, screen = { x: width / 2, y: height / 2 }) {
    const next = Math.max(0.15, Math.min(3, scale * Math.exp(delta)));
    const world = { x: (screen.x - panX) / scale, y: (screen.y - panY) / scale };
    scale = next;
    panX = screen.x - world.x * scale;
    panY = screen.y - world.y * scale;
    render();
  }

  listen(svg, 'pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1 || mode === 'pan' || event.altKey) {
      pointer = { type: 'pan', id: event.pointerId, screen: screenPoint(event), panX, panY, moved: false };
    } else {
      const target = event.target.closest?.('[data-node-id]');
      const node = target && lookupNode(target.getAttribute('data-node-id'));
      const portTarget = event.target.closest?.('[data-port]');
      if (portTarget?.getAttribute('data-port') === 'out' && node) {
        if (!allowEdit()) { event.preventDefault(); selection('node', node.id); return; }
        pendingSource = node.id;
        previewPoint = port(node, 'out');
        pointer = { type: 'connect', id: event.pointerId, source: node.id, screen: screenPoint(event), moved: false };
      } else if (node && mode === 'select' && !portTarget) {
        if (editable()) {
          const point = worldPoint(event);
          pointer = { type: 'node', id: event.pointerId, nodeId: node.id, start: point, x: node.x, y: node.y, screen: screenPoint(event), moved: false };
        }
        selection('node', node.id);
      } else if (mode === 'select') {
        const stream = event.target.closest?.('[data-stream-id]');
        if (stream) pointer = { type: 'stream', id: event.pointerId, streamId: stream.getAttribute('data-stream-id'), screen: screenPoint(event), moved: false };
      }
    }
    if (pointer) { event.preventDefault(); try { svg.setPointerCapture(event.pointerId); } catch {} render(); }
  });
  listen(svg, 'pointermove', event => {
    if ((pendingSource || pointer?.type === 'node' || pointer?.type === 'connect') && !allowEdit()) return;
    if (!pointer) {
      if (pendingSource) { previewPoint = worldPoint(event); render(); }
      return;
    }
    if (pointer.id !== event.pointerId) return;
    const current = screenPoint(event);
    if (Math.hypot(current.x - pointer.screen.x, current.y - pointer.screen.y) > 4) pointer.moved = true;
    if (pointer.type === 'pan') { panX = pointer.panX + current.x - pointer.screen.x; panY = pointer.panY + current.y - pointer.screen.y; }
    else if (pointer.type === 'node' && pointer.moved) {
      const node = lookupNode(pointer.nodeId), point = worldPoint(event);
      if (node) { node.x = Math.round((pointer.x + point.x - pointer.start.x) / 10) * 10; node.y = Math.round((pointer.y + point.y - pointer.start.y) / 10) * 10; }
    } else if (pointer.type === 'connect') previewPoint = worldPoint(event);
    render();
  });
  function endPointer(event, cancel = false) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if ((pointer.type === 'node' || pointer.type === 'connect') && !allowEdit()) return;
    const interaction = pointer;
    pointer = null;
    try { svg.releasePointerCapture(event.pointerId); } catch {}
    if (interaction.moved) ignoreClickUntil = Date.now() + 180;
    if (!cancel && !interaction.moved && ['node', 'stream'].includes(interaction.type)) {
      ignoreClickUntil = Date.now() + 180;
      tapItem(interaction.type, interaction.nodeId || interaction.streamId);
    }
    if (interaction.type === 'node' && interaction.moved) {
      if (cancel) { const node = lookupNode(interaction.nodeId); if (node) { node.x = interaction.x; node.y = interaction.y; } }
      else onChange();
    }
    if (interaction.type === 'connect') {
      if (cancel) clearPending();
      else if (!interaction.moved) { ignoreClickUntil = Date.now() + 180; beginConnection(lookupNode(interaction.source)); }
      else if (interaction.moved) {
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-node-id]');
        const targetId = hit?.getAttribute('data-node-id');
        if (!targetId || !svg.contains(hit)) { announce('Drop the stream on a destination unit or its input port.'); clearPending(); }
        else if (!connect(interaction.source, targetId)) clearPending();
      }
    }
    render();
  }
  listen(svg, 'pointerup', event => endPointer(event));
  listen(svg, 'pointercancel', event => endPointer(event, true));
  listen(svg, 'click', event => {
    if (Date.now() < ignoreClickUntil || mode === 'pan') return;
    const nodeTarget = event.target.closest?.('[data-node-id]');
    const node = nodeTarget && lookupNode(nodeTarget.getAttribute('data-node-id'));
    const portTarget = event.target.closest?.('[data-port]');
    if (node && (mode === 'connect' || portTarget)) {
      if (!allowEdit()) { selection('node', node.id); return; }
      if (pendingSource && pendingSource !== node.id) { if (!connect(pendingSource, node.id)) render(); }
      else beginConnection(node);
    } else if (node) selection('node', node.id);
    else {
      const stream = event.target.closest?.('[data-stream-id]');
      if (stream) selection('stream', stream.getAttribute('data-stream-id'));
      else { clearPending(); selected = null; onSelect(null); render(); }
    }
  });
  listen(svg, 'dblclick', event => {
    if (mode !== 'select') return;
    const node = event.target.closest?.('[data-node-id]');
    const stream = event.target.closest?.('[data-stream-id]');
    if (node) { selection('node', node.getAttribute('data-node-id')); editItem('node', node.getAttribute('data-node-id')); }
    else if (stream) { selection('stream', stream.getAttribute('data-stream-id')); editItem('stream', stream.getAttribute('data-stream-id')); }
  });
  listen(svg, 'contextmenu', event => {
    const stream = event.target.closest?.('[data-stream-id]');
    if (stream) { event.preventDefault(); selection('stream', stream.getAttribute('data-stream-id')); editItem('stream', stream.getAttribute('data-stream-id')); }
  });
  listen(svg, 'keydown', event => {
    const item = event.target.closest?.('[data-node-id][tabindex], [data-stream-id][tabindex]');
    if (event.key === 'Escape') { clearPending(); render(); announce('Connection cancelled.'); event.preventDefault(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { if (item) selected = { kind: item.hasAttribute('data-node-id') ? 'node' : 'stream', id: item.getAttribute(item.hasAttribute('data-node-id') ? 'data-node-id' : 'data-stream-id') }; event.preventDefault(); deleteSelection(); return; }
    if (event.key === 'Enter' || event.key.toLowerCase() === 'e') {
      const kind = item?.hasAttribute('data-node-id') ? 'node' : item ? 'stream' : selected?.kind;
      const id = item?.getAttribute(kind === 'node' ? 'data-node-id' : 'data-stream-id') || selected?.id;
      if (kind && id) { event.preventDefault(); selection(kind, id); editItem(kind, id); }
    } else if (event.key === ' ') {
      if (item) { event.preventDefault(); selection(item.hasAttribute('data-node-id') ? 'node' : 'stream', item.getAttribute(item.hasAttribute('data-node-id') ? 'data-node-id' : 'data-stream-id'), true); }
    } else if (item?.hasAttribute('data-node-id') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      if (!allowEdit()) return;
      const node = lookupNode(item.getAttribute('data-node-id'));
      if (node) { const step = event.shiftKey ? 50 : 10; node.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0; node.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0; onChange(); render(); focusItem('node', node.id); }
    }
  });
  listen(svg, 'wheel', event => { event.preventDefault(); zoomAt(-Math.max(-100, Math.min(100, event.deltaY)) * 0.0025, screenPoint(event)); }, { passive: false });
  listen(svg, 'dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('application/x-node-kind')) { event.preventDefault(); event.dataTransfer.dropEffect = editable() ? 'copy' : 'none'; } });
  listen(svg, 'drop', event => {
    const kind = event.dataTransfer?.getData('application/x-node-kind');
    if (NODE_TYPES[kind]) { event.preventDefault(); addNode(kind, worldPoint(event)); }
  });
  const observer = new ResizeObserver(() => { dimensions(); render(); });
  observer.observe(svg);
  dimensions();
  render();
  return {
    setModel(value) { if (!editable()) cancelMutation(); model = value; selected = null; results = null; pointer = null; lastTap = null; clearPending(); onSelect(null); render(); },
    setResults(value) { results = value; render(); },
    setPresentation(value) { if (!['published', 'editing'].includes(value)) return false; cancelMutation(); presentation = value; render(); return true; },
    setMode(value) { if (value === 'connect' && !allowEdit()) return false; if (['select', 'connect', 'pan'].includes(value)) { mode = value; clearPending(); render(); if (mode === 'connect') announce('Choose a source unit, then choose its destination.'); } },
    addNode,
    fit,
    zoom(delta) { zoomAt(delta); },
    deleteSelection,
    select: selection,
    getSelection() { return selected && { ...selected }; },
    destroy() { destroyed = true; observer.disconnect(); listeners.forEach(remove => remove()); svg.replaceChildren(); }
  };
}
