import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../public/editor.js';
import { exampleModel, newStream } from '../public/model.js';
import { unitBounds } from '../public/unit-symbols.js';
import { reconcile } from '../public/solver.js';
import { getPublishedUnitSummary } from '../public/published-results.js';
import { sizedModel } from './helpers/large-model-fixture.js';

const EQUIPMENT = ['process', 'mixer', 'splitter', 'pump', 'compressor', 'valve', 'heatExchanger', 'filter', 'cyclone', 'conveyor'];

// Exercise the editor's real event handlers with a small SVG surface. Geometry
// and browser hit testing remain covered by the browser checks.
function setup(t, allowed = false, model = exampleModel(), options = {}) {
  const originals = new Map(['document', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const state = { allowed, changes: 0, edits: [], statuses: [], selected: null };
  let document;
  class Element {
    constructor(tag = 'g') { this.tag = tag; this.attributes = new Map(); this.children = []; this.listeners = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    matches(selector) { return selector.split(',').some(part => [...part.matchAll(/\[([^\]]+)\]/g)].every(match => this.hasAttribute(match[1]))); }
    closest(selector) { for (let item = this; item; item = item.parent) if (item.matches(selector)) return item; return null; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    contains(item) { for (; item; item = item.parent) if (item === this) return true; return false; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 600 }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    fire(type, props = {}) {
      const event = { target: this, button: 0, pointerId: 1, clientX: 100, clientY: 260, preventDefault() {}, ...props };
      this.listeners.get(type)?.(event);
      return event;
    }
  }
  const svg = new Element('svg');
  document = { activeElement: null, createElementNS: (_ns, tag) => new Element(tag), elementFromPoint: () => state.hit ?? null };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  const editor = createEditor({ svg, canEdit: () => state.allowed, onChange: () => state.changes++, onSelect: item => { state.selected = item; }, onEditNode: id => state.edits.push(['node', id]), onEditStream: id => state.edits.push(['stream', id]), onStatus: message => state.statuses.push(message), ...options });
  editor.setModel(model);
  t.after(() => {
    editor.destroy();
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return { state, svg, editor, model, node: id => svg.querySelectorAll('[data-node-id][tabindex]').find(item => item.getAttribute('data-node-id') === id), stream: id => svg.querySelectorAll('[data-stream-id][tabindex]').find(item => item.getAttribute('data-stream-id') === id), port: (id, type = 'out') => svg.querySelectorAll('[data-port]').find(item => item.getAttribute('data-node-id') === id && item.getAttribute('data-port') === type) };
}

test('read-only editor blocks public mutations, keyboard movement, and palette drops', t => {
  const { state, svg, editor, model, node } = setup(t);
  const original = structuredClone(model);
  for (const kind of EQUIPMENT) assert.equal(editor.addNode(kind), false);
  editor.select('node', 'feed');
  assert.equal(editor.deleteSelection(), false);
  assert.equal(editor.setMode('connect'), false);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) svg.fire('keydown', { target: node('feed'), key });
  for (const kind of EQUIPMENT) {
    const transfer = { types: ['application/x-node-kind'], getData: () => kind };
    svg.fire('dragover', { dataTransfer: transfer });
    assert.equal(transfer.dropEffect, 'none');
    svg.fire('drop', { dataTransfer: transfer });
  }
  assert.deepEqual(model, original);
  assert.equal(state.changes, 0);
  assert.ok(state.statuses.includes('This model is read-only or locked.'));
});

test('read-only visibility omits complete stream groups and reveals them without changing the model', t => {
  const { state, svg, editor, model, stream } = setup(t);
  const original = structuredClone(model);
  editor.select('stream', 'f1');
  editor.setLineVisibility({ hiddenIds: ['f1'], showHidden: false });
  assert.equal(stream('f1'), undefined);
  assert.equal(editor.getSelection(), null);
  assert.equal(state.selected, null);
  assert.equal(svg.querySelectorAll('[data-stream-id]').length, model.streams.length - 1);
  assert.equal(svg.querySelectorAll('[font-size]').some(item => item.textContent === model.streams[0].name), false);
  editor.setLineVisibility({ hiddenIds: new Set(['f1']), showHidden: true });
  assert.match(stream('f1').getAttribute('class'), /is-hidden-revealed/);
  assert.match(stream('f1').getAttribute('aria-label'), /Hidden line, temporarily revealed/);
  assert.equal(svg.querySelectorAll('[data-stream-id]').length, model.streams.length);
  editor.setLineVisibility({ hiddenIds: [], showHidden: false });
  assert.doesNotMatch(stream('f1').getAttribute('class'), /is-hidden-revealed/);
  assert.deepEqual(model, original);
  assert.equal(state.changes, 0);
  assert.deepEqual(state.edits, []);
});

test('hidden lines retain their mass in published unit summaries', t => {
  const { state, svg, editor, model, stream, node } = setup(t);
  editor.setPresentation('published');
  editor.setResults(reconcile(model));
  const originalSummary = node('mix').getAttribute('aria-label');
  editor.setLineVisibility({ hiddenIds: ['f1', 'f2'], showHidden: false });
  assert.equal(stream('f1'), undefined);
  assert.equal(stream('f2'), undefined);
  assert.equal(node('mix').getAttribute('aria-label'), originalSummary);
  assert.match(originalSummary, /99\.444/);
  assert.ok(svg.querySelectorAll('[font-size]').some(item => item.textContent === 'In 99.444'));
  assert.equal(state.changes, 0);
});

test('fit excludes hidden detours and restores their extent when revealed', t => {
  const model = exampleModel();
  for (let index = 0; index < 8; index++) model.streams.push({ ...model.streams[0], id: `detour-${index}`, name: `Detour ${index}`, source: 'split', target: 'mix' });
  const { editor, svg } = setup(t, false, model);
  const transform = () => svg.children.find(item => item.getAttribute('class') === 'flow-world').getAttribute('transform');
  editor.fit();
  const withDetours = transform();
  const hiddenIds = model.streams.filter(stream => stream.id.startsWith('detour-')).map(stream => stream.id);
  editor.setLineVisibility({ hiddenIds });
  editor.fit();
  assert.notEqual(transform(), withDetours);
  editor.setLineVisibility({ hiddenIds, showHidden: true });
  editor.fit();
  assert.equal(transform(), withDetours);
});

test('read-only right click opens the optional stream menu without opening an editor', t => {
  const contexts = [];
  const { state, svg, stream } = setup(t, false, exampleModel(), { onStreamContext: (id, event) => contexts.push({ id, x: event.clientX, y: event.clientY }) });
  let prevented = false;
  svg.fire('contextmenu', { target: stream('f1'), clientX: 210, clientY: 245, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(contexts, [{ id: 'f1', x: 210, y: 245 }]);
  assert.deepEqual(state.selected, { kind: 'stream', id: 'f1' });
  assert.deepEqual(state.edits, []);
  assert.equal(state.changes, 0);
});

test('read-only node selection remains available without starting a move', t => {
  const { state, svg, model, node } = setup(t);
  const original = structuredClone(model);
  svg.fire('pointerdown', { target: node('feed') });
  svg.fire('pointermove', { clientX: 200, clientY: 300 });
  svg.fire('pointerup', { clientX: 200, clientY: 300 });
  assert.deepEqual(state.selected, { kind: 'node', id: 'feed' });
  assert.deepEqual(model, original);
  assert.equal(state.changes, 0);
});

test('revoking editing during a drag rolls back its temporary coordinates', t => {
  const { state, svg, model, node } = setup(t, true);
  svg.fire('pointerdown', { target: node('feed') });
  svg.fire('pointermove', { clientX: 170, clientY: 320 });
  assert.equal(model.nodes[0].x, 170);
  assert.equal(model.nodes[0].y, 320);
  state.allowed = false;
  svg.fire('pointerup', { clientX: 170, clientY: 320 });
  assert.equal(model.nodes[0].x, 100);
  assert.equal(model.nodes[0].y, 260);
  assert.equal(state.changes, 0);
});

test('permission refresh cancels a pending port connection and drag before further movement', t => {
  const { state, svg, editor, model, node, port } = setup(t, true);
  svg.fire('pointerdown', { target: node('feed') });
  svg.fire('pointermove', { clientX: 190, clientY: 330 });
  state.allowed = false;
  editor.setResults({ streams: [] });
  assert.equal(model.nodes[0].x, 100);
  assert.equal(model.nodes[0].y, 260);
  state.allowed = true;
  // A fresh connection may start after permission has been restored.
  svg.fire('pointerdown', { target: port('feed'), pointerId: 2 });
  svg.fire('pointermove', { pointerId: 2, clientX: 350 });
  state.allowed = false;
  state.hit = node('mix');
  svg.fire('pointerup', { pointerId: 2, clientX: 350 });
  svg.fire('click', { target: port('feed') });
  assert.equal(model.streams.length, 4);
  assert.equal(state.changes, 0);
});

test('read-only edit requests do not open node or stream editors', t => {
  const { state, svg, node, stream } = setup(t);
  svg.fire('dblclick', { target: node('feed') });
  svg.fire('dblclick', { target: stream('f1') });
  svg.fire('contextmenu', { target: stream('f1') });
  svg.fire('keydown', { target: node('feed'), key: 'Enter' });
  svg.fire('keydown', { target: stream('f1'), key: 'e' });
  for (let tap = 0; tap < 2; tap++) {
    svg.fire('pointerdown', { target: stream('f1') });
    svg.fire('pointerup', { target: stream('f1') });
  }
  assert.deepEqual(state.edits, []);
  assert.deepEqual(state.selected, { kind: 'stream', id: 'f1' });
});

test('read-only pan, zoom, and reconciled overlays remain available', t => {
  const { svg, editor, model } = setup(t);
  editor.setMode('pan');
  const world = () => svg.children.find(item => item.getAttribute('class') === 'flow-world');
  const before = world().getAttribute('transform');
  svg.fire('pointerdown');
  svg.fire('pointermove', { clientX: 140, clientY: 290 });
  svg.fire('pointerup', { clientX: 140, clientY: 290 });
  assert.notEqual(world().getAttribute('transform'), before);
  const panned = world().getAttribute('transform');
  editor.zoom(0.2);
  assert.notEqual(world().getAttribute('transform'), panned);
  editor.setResults({ streams: [{ id: 'f1', value: 99.44, status: 'reconciled' }] });
  const texts = svg.querySelectorAll('[font-size]');
  assert.ok(texts.some(item => item.textContent === '99.44 kg'));
  assert.equal(model.nodes[0].x, 100);
});

test('editable editor still supports addition, deletion, keyboard edits, and connections', t => {
  const { state, svg, editor, model, node, port } = setup(t, true);
  const added = editor.addNode('process', { x: 400, y: 400 });
  assert.ok(added.id);
  assert.equal(model.nodes.length, 6);
  editor.deleteSelection();
  assert.equal(model.nodes.length, 5);
  svg.fire('keydown', { target: node('feed'), key: 'ArrowRight' });
  assert.equal(model.nodes[0].x, 110);
  svg.fire('keydown', { target: node('feed'), key: 'Enter' });
  assert.deepEqual(state.edits, [['node', 'feed']]);
  editor.setMode('connect');
  svg.fire('click', { target: port('feed') });
  svg.fire('click', { target: node('mix') });
  assert.equal(model.streams.length, 5);
  assert.equal(state.changes, 4);
});

test('editor addition, palette drops, and connections pass the former count limits', t => {
  const f = setup(t, true, sizedModel(200, 500));
  assert.ok(f.editor.addNode('process', { x: 400, y: 400 }));
  assert.equal(f.model.nodes.length, 201);
  f.svg.fire('drop', { dataTransfer: { getData: () => 'pump' }, clientX: 500, clientY: 400 });
  assert.equal(f.model.nodes.length, 202);
  assert.equal(f.model.nodes.at(-1).kind, 'pump');
  f.editor.setMode('connect');
  f.svg.fire('click', { target: f.port('feed') });
  f.svg.fire('click', { target: f.node('mix') });
  assert.equal(f.model.streams.length, 501);
  assert.equal(f.model.streams.at(-1).source, 'feed');
  assert.equal(f.model.streams.at(-1).target, 'mix');
  assert.equal(f.state.changes, 3);
});

test('editing and published diagram overlays retain small positive masses', t => {
  const f = setup(t, true);
  const result = { status: 'ok', streams: f.model.streams.map(stream => ({ id: stream.id, value: 0.0004, status: 'reconciled' })) };
  f.editor.setResults(result);
  assert.ok(f.svg.querySelectorAll('[font-size]').some(item => item.textContent === '4.000e-4 kg'));
  f.editor.setPresentation('published');
  const texts = f.svg.querySelectorAll('[font-size]');
  assert.ok(texts.some(item => item.textContent === '4.000e-4 kg'));
  assert.ok(texts.some(item => item.textContent === 'Inflow 4.000e-4'));
  assert.match(f.node('feed').getAttribute('aria-label'), /inflow: 4\.000e-4 kg/);
});

function equipmentModel() {
  const model = exampleModel();
  model.nodes = [
    { id: 'feed', kind: 'inlet', name: 'Feed', x: 100, y: 200 },
    ...EQUIPMENT.map((kind, index) => ({ id: kind, kind, name: kind, x: 350, y: 100 + index * 90 })),
    { id: 'exit', kind: 'outlet', name: 'Product', x: 800, y: 200 }
  ];
  model.streams = EQUIPMENT.map((kind, index) => ({ ...newStream('feed', kind, index + 1), id: `input-${kind}` }));
  return model;
}

test('palette drops add each equipment kind with reachable input and output ports', t => {
  const { state, svg, model, port } = setup(t, true);
  for (const kind of EQUIPMENT) {
    const transfer = { types: ['application/x-node-kind'], getData: () => kind };
    svg.fire('dragover', { dataTransfer: transfer });
    assert.equal(transfer.dropEffect, 'copy');
    svg.fire('drop', { dataTransfer: transfer, clientX: 504, clientY: 407 });
    const added = model.nodes.at(-1);
    assert.equal(added.kind, kind);
    assert.equal(added.x, 500); assert.equal(added.y, 410);
    for (const type of ['in', 'out']) {
      const circles = port(added.id, type).children.filter(item => item.tag === 'circle');
      assert.equal(Number(circles[0].getAttribute('cx')), type === 'out' ? 56 : -56);
      assert.ok(Number(circles[0].getAttribute('r')) >= 12, `${kind} has a practical port hit area`);
    }
  }
  assert.equal(state.changes, EQUIPMENT.length);
});

test('moving equipment keeps existing routes attached and drag previews connect from the visible output port', t => {
  const f = setup(t, true, equipmentModel());
  const route = id => f.stream(id).children.find(item => item.tag === 'path').getAttribute('d');
  const endpoint = path => {
    let x, y;
    for (const [, command, values] of path.matchAll(/([MHVA]) ([^MHVA]+)/g)) {
      const numbers = values.trim().split(/\s+/).map(Number);
      if (command === 'M') [x, y] = numbers;
      if (command === 'H') [x] = numbers;
      if (command === 'V') [y] = numbers;
      if (command === 'A') [x, y] = numbers.slice(-2);
    }
    return { x, y };
  };
  for (const kind of EQUIPMENT) {
    const unit = f.model.nodes.find(node => node.id === kind), originalY = unit.y;
    assert.ok(route(`input-${kind}`).startsWith('M 127 200 '));
    assert.deepEqual(endpoint(route(`input-${kind}`)), { x: 294, y: originalY });
    f.svg.fire('pointerdown', { target: f.node(kind), clientX: 350, clientY: originalY });
    f.svg.fire('pointermove', { clientX: 410, clientY: originalY + 30 });
    f.svg.fire('pointerup', { clientX: 410, clientY: originalY + 30 });
    assert.equal(unit.x, 410); assert.equal(unit.y, originalY + 30);
    assert.deepEqual(endpoint(route(`input-${kind}`)), { x: 354, y: unit.y }, `${kind} input stream follows a moved symbol`);
    f.svg.fire('pointerdown', { target: f.port(kind), clientX: 466, clientY: unit.y });
    f.svg.fire('pointermove', { clientX: 773, clientY: 200 });
    const world = f.svg.children.find(item => item.getAttribute('class') === 'flow-world');
    const preview = world.children.find(item => item.tag === 'path' && item.getAttribute('stroke-dasharray') === '6 4');
    assert.ok(preview.getAttribute('d').startsWith(`M 466 ${unit.y} `), `${kind} preview starts at its drawn output port`);
    f.state.hit = f.port('exit', 'in');
    f.svg.fire('pointerup', { clientX: 773, clientY: 200 });
    const connected = f.model.streams.at(-1);
    assert.equal(connected.source, kind); assert.equal(connected.target, 'exit');
    assert.ok(route(connected.id).startsWith(`M 466 ${unit.y} `));
    assert.deepEqual(endpoint(route(connected.id)), { x: 773, y: 200 });
  }
  assert.equal(f.state.changes, EQUIPMENT.length * 2);
});

test('read-only equipment allows selection but blocks moves, ports, edits, and deletion for every symbol', t => {
  const f = setup(t, false, equipmentModel()), original = structuredClone(f.model);
  for (const kind of EQUIPMENT) {
    f.svg.fire('pointerdown', { target: f.node(kind) });
    f.svg.fire('pointermove', { clientX: 500, clientY: 400 });
    f.svg.fire('pointerup', { clientX: 500, clientY: 400 });
    assert.deepEqual(f.state.selected, { kind: 'node', id: kind });
    f.svg.fire('pointerdown', { target: f.port(kind) });
    f.state.hit = f.port('exit', 'in');
    f.svg.fire('pointermove', { clientX: 773, clientY: 200 });
    f.svg.fire('pointerup', { clientX: 773, clientY: 200 });
    f.svg.fire('dblclick', { target: f.node(kind) });
    f.svg.fire('keydown', { target: f.node(kind), key: 'Delete' });
  }
  assert.deepEqual(f.model, original);
  assert.deepEqual(f.state.edits, []);
  assert.equal(f.state.changes, 0);
});

test('fit includes equipment ports and label bounds without altering the model', t => {
  const f = setup(t, false, equipmentModel()), original = structuredClone(f.model);
  f.editor.fit();
  const world = f.svg.children.find(item => item.getAttribute('class') === 'flow-world');
  const match = world.getAttribute('transform').match(/^translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)$/i);
  assert.ok(match);
  const [, px, py, zoom] = match.map(Number);
  for (const unit of f.model.nodes) {
    const bounds = unitBounds(unit);
    assert.ok(bounds.left * zoom + px >= 48 - 1e-8, `${unit.kind} left extent stays visible`);
    assert.ok(bounds.right * zoom + px <= 900 - 48 + 1e-8, `${unit.kind} right extent stays visible`);
    assert.ok(bounds.top * zoom + py >= 48 - 1e-8, `${unit.kind} top extent stays visible`);
    assert.ok(bounds.bottom * zoom + py <= 600 - 48 + 1e-8, `${unit.kind} labels stay visible`);
  }
  assert.deepEqual(f.model, original);
});

test('reverse-routed streams clear equipment names and keep both endpoints on their ports', t => {
  const model = equipmentModel();
  model.streams.push({ ...newStream('conveyor', 'pump', 12), id: 'reverse-flow' });
  const f = setup(t, true, model);
  const path = f.stream('reverse-flow').children.find(item => item.tag === 'path').getAttribute('d');
  const source = model.nodes.find(node => node.id === 'conveyor'), target = model.nodes.find(node => node.id === 'pump');
  assert.ok(path.startsWith(`M ${source.x + 56} ${source.y} `));
  assert.ok(path.endsWith(`V ${target.y} H ${target.x - 56}`));
  const lowest = Math.max(...[...path.matchAll(/V ([-\d.]+)/g)].map(match => Number(match[1])));
  assert.ok(lowest >= Math.max(unitBounds(source).bottom, unitBounds(target).bottom) + 40, 'the return leg must clear both symbol labels');
  assert.equal(f.state.changes, 0);
});

test('published presentation renders accessible mass badges and 3-decimal stream values only for saved results', t => {
  const f = setup(t, true), result = reconcile(f.model);
  f.editor.setResults(result);
  assert.equal(f.svg.querySelectorAll('[data-result-status]').length, 0, 'editing view keeps its current compact symbols');
  assert.equal(f.editor.setPresentation('published'), true);
  assert.equal(f.svg.dataset.presentation, 'published');
  assert.equal(f.svg.querySelectorAll('[data-result-status]').length, f.model.nodes.length);
  let texts = f.svg.querySelectorAll('[font-size]');
  assert.ok(texts.some(item => item.textContent === 'In 99.444'));
  assert.ok(texts.some(item => item.textContent === 'Out 99.444'));
  assert.ok(texts.some(item => item.textContent === '62.222 kg'));
  assert.match(f.node('mix').getAttribute('aria-label'), /incoming mass: 99\.444 kg per reporting period/);
  f.editor.setResults(null);
  texts = f.svg.querySelectorAll('[font-size]');
  assert.equal(texts.filter(item => item.textContent === 'Awaiting run').length, f.model.nodes.length);
  assert.ok(!texts.some(item => item.textContent === 'In 99.444'));
  f.editor.setResults({ status: 'invalid', streams: result.streams });
  assert.ok(!f.svg.querySelectorAll('[font-size]').some(item => item.textContent === '62.222 kg'), 'failed runs cannot masquerade as successful stream results');
  assert.equal(f.editor.setPresentation('other'), false);
  assert.equal(f.svg.dataset.presentation, 'published');
});

test('published presentation independently blocks editing but preserves selection, pan, and zoom', t => {
  const f = setup(t, true), original = structuredClone(f.model);
  f.editor.setPresentation('published');
  f.editor.setResults(reconcile(f.model));
  for (const kind of EQUIPMENT) assert.equal(f.editor.addNode(kind), false);
  f.svg.fire('pointerdown', { target: f.node('mix') });
  f.svg.fire('pointermove', { clientX: 200, clientY: 300 });
  f.svg.fire('pointerup', { clientX: 200, clientY: 300 });
  assert.deepEqual(f.state.selected, { kind: 'node', id: 'mix' });
  f.svg.fire('dblclick', { target: f.node('mix') });
  f.svg.fire('keydown', { target: f.node('mix'), key: 'Enter' });
  f.svg.fire('keydown', { target: f.node('mix'), key: 'ArrowRight' });
  assert.equal(f.editor.deleteSelection(), false);
  assert.equal(f.editor.setMode('connect'), false);
  const world = () => f.svg.children.find(item => item.getAttribute('class') === 'flow-world').getAttribute('transform');
  const before = world();
  f.editor.setMode('pan'); f.svg.fire('pointerdown');
  f.svg.fire('pointermove', { clientX: 170, clientY: 300 }); f.svg.fire('pointerup', { clientX: 170, clientY: 300 });
  assert.notEqual(world(), before);
  const panned = world(); f.editor.zoom(0.2); assert.notEqual(world(), panned);
  assert.deepEqual(f.model, original); assert.equal(f.state.changes, 0); assert.deepEqual(f.state.edits, []);
  f.editor.setPresentation('editing');
  assert.ok(f.editor.addNode('pump'), 'switching back restores the caller-granted editing permission');
});

test('published fit includes each unit mass badge without moving symbols or their fixed ports', t => {
  const f = setup(t, false), original = structuredClone(f.model), result = reconcile(f.model);
  f.editor.setPresentation('published'); f.editor.setResults(result); f.editor.fit();
  const world = f.svg.children.find(item => item.getAttribute('class') === 'flow-world');
  const match = world.getAttribute('transform').match(/^translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)$/i);
  const [, px, py, zoom] = match.map(Number);
  for (const node of f.model.nodes) {
    const badge = getPublishedUnitSummary(node, f.model, result).bounds;
    assert.ok((node.x + badge.left) * zoom + px >= 48 - 1e-8);
    assert.ok((node.x + badge.right) * zoom + px <= 900 - 48 + 1e-8);
    assert.ok((node.y + badge.top) * zoom + py >= 48 - 1e-8);
    assert.ok((node.y + badge.bottom) * zoom + py <= 600 - 48 + 1e-8);
    assert.ok(badge.bottom < 0, 'annotations are clear of the horizontal connection ports');
  }
  assert.deepEqual(f.model, original);
});

test('switching to published presentation rolls back a temporary edit and preserves original port locations', t => {
  const f = setup(t, true);
  f.svg.fire('pointerdown', { target: f.node('feed') });
  f.svg.fire('pointermove', { clientX: 170, clientY: 320 });
  assert.equal(f.model.nodes[0].x, 170);
  f.editor.setPresentation('published');
  assert.equal(f.model.nodes[0].x, 100); assert.equal(f.model.nodes[0].y, 260);
  assert.equal(f.state.changes, 0);
});
