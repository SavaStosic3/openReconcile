import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../public/editor.js';
import { exampleModel } from '../public/model.js';

// Exercise the editor's real event handlers with a small SVG surface. Geometry
// and browser hit testing remain covered by the browser checks.
function setup(t, allowed = false) {
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
  const model = exampleModel();
  const editor = createEditor({ svg, canEdit: () => state.allowed, onChange: () => state.changes++, onSelect: item => { state.selected = item; }, onEditNode: id => state.edits.push(['node', id]), onEditStream: id => state.edits.push(['stream', id]), onStatus: message => state.statuses.push(message) });
  editor.setModel(model);
  t.after(() => {
    editor.destroy();
    for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  return { state, svg, editor, model, node: id => svg.querySelectorAll('[data-node-id][tabindex]').find(item => item.getAttribute('data-node-id') === id), stream: id => svg.querySelectorAll('[data-stream-id][tabindex]').find(item => item.getAttribute('data-stream-id') === id), port: id => svg.querySelectorAll('[data-port]').find(item => item.getAttribute('data-node-id') === id && item.getAttribute('data-port') === 'out') };
}

test('read-only editor blocks public mutations, keyboard movement, and palette drops', t => {
  const { state, svg, editor, model, node } = setup(t);
  const original = structuredClone(model);
  assert.equal(editor.addNode('process'), false);
  editor.select('node', 'feed');
  assert.equal(editor.deleteSelection(), false);
  assert.equal(editor.setMode('connect'), false);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace']) svg.fire('keydown', { target: node('feed'), key });
  const transfer = { types: ['application/x-node-kind'], getData: () => 'process' };
  svg.fire('dragover', { dataTransfer: transfer });
  assert.equal(transfer.dropEffect, 'none');
  svg.fire('drop', { dataTransfer: transfer });
  assert.deepEqual(model, original);
  assert.equal(state.changes, 0);
  assert.ok(state.statuses.includes('This model is read-only or locked.'));
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
