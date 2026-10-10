import test from 'node:test';
import assert from 'node:assert/strict';
import { NODE_TYPES, exampleModel, validateModel } from '../public/model.js';
import { createCatalog, validateCatalog, validateEditableModel } from '../public/management-store.js';
import { reconcile } from '../public/solver.js';
import { UNIT_SYMBOLS, appendUnitSymbol, portPosition, unitBounds } from '../public/unit-symbols.js';

const EQUIPMENT = ['process', 'mixer', 'splitter', 'pump', 'compressor', 'valve', 'heatExchanger', 'filter', 'cyclone', 'conveyor'];
const GLYPHS = [...EQUIPMENT, 'tank', 'bulkStorage'];

test('equipment symbols survive model export/import and editable catalog persistence', () => {
  for (const kind of EQUIPMENT) {
    assert.ok(Object.hasOwn(NODE_TYPES, kind), `${kind} must be an accepted process unit`);
    const model = exampleModel();
    model.nodes.find(node => node.id === 'mix').kind = kind;
    model.nodes.find(node => node.id === 'split').kind = kind;
    const imported = JSON.parse(JSON.stringify(model));
    assert.deepEqual(validateModel(imported), model);
    assert.deepEqual(validateEditableModel(imported), model);
    const catalog = createCatalog(imported, { id: 'equipment-model', now: '2026-10-09T20:00:00.000Z' });
    assert.deepEqual(validateCatalog(JSON.parse(JSON.stringify(catalog))).models[0].model, model);
  }
});

test('choosing an equipment symbol preserves conservation, estimates, and measurement corrections', () => {
  const baseline = exampleModel();
  for (const node of baseline.nodes) if (node.kind !== 'inlet' && node.kind !== 'outlet') node.kind = 'process';
  const expected = reconcile(baseline);
  assert.equal(expected.status, 'ok');
  assert.ok(expected.streams.some(stream => stream.status === 'estimated'));
  for (const kind of EQUIPMENT) {
    const model = structuredClone(baseline);
    for (const node of model.nodes) if (node.kind === 'process') node.kind = kind;
    const actual = reconcile(model);
    assert.deepEqual(actual, expected, `${kind} must only change the visual representation`);
    for (const balance of actual.balances) assert.ok(Math.abs(balance.reconciled) < 1e-8, `${kind} mass balance must close`);
    assert.ok(Math.abs(actual.streams.find(stream => stream.id === 'f1').value - 99.44444444444444) < 1e-8);
  }
});

test('ports stay on the same flow axis, independent of equipment type or negative coordinates', () => {
  for (const kind of GLYPHS) for (const [x, y] of [[360, 240], [-500, -120]]) {
    const node = { kind, x, y, name: 'Equipment' };
    const input = portPosition(node, 'in'), output = portPosition(node, 'out');
    assert.deepEqual(input, { x: x - 56, y });
    assert.deepEqual(output, { x: x + 56, y });
    const bounds = unitBounds(node);
    assert.ok(bounds.left <= input.x && bounds.right >= output.x, `${kind} bounds include both ports`);
    assert.ok(bounds.top < y && bounds.bottom > y, `${kind} has usable vertical bounds`);
    assert.ok(bounds.bottom >= y + 70, `${kind} bounds include the name and type labels`);
  }
  assert.deepEqual(portPosition({ kind: 'inlet', x: 100, y: 200 }, 'out'), { x: 127, y: 200 });
  assert.deepEqual(portPosition({ kind: 'outlet', x: 700, y: 200 }, 'in'), { x: 673, y: 200 });
});

test('every equipment symbol renders a distinct visible SVG glyph without text or image dependencies', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class Element {
    constructor(tag) { this.tag = tag; this.attributes = new Map(); this.children = []; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    append(item) { this.children.push(item); }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElementNS(namespace, tag) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return new Element(tag); }
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'document', original) : delete globalThis.document);
  assert.deepEqual(Object.keys(UNIT_SYMBOLS).sort(), [...GLYPHS].sort());
  const glyphs = new Set();
  const geometry = new Set(['d', 'points', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'rx']);
  for (const kind of GLYPHS) {
    const group = new Element('g');
    appendUnitSymbol(kind, group, { stroke: '#123456' });
    assert.ok(group.children.length >= 2, `${kind} needs a body and flow connections`);
    assert.ok(group.children.every(item => ['path', 'circle', 'rect', 'polygon', 'line', 'ellipse', 'polyline'].includes(item.tag)), `${kind} must use scalable vectors`);
    assert.ok(group.children.every(item => [...item.attributes.values()].every(value => !/NaN|undefined|Infinity/.test(value))), `${kind} must render finite coordinates`);
    assert.ok(group.children.every(item => item.attributes.get('stroke-width') === '2'), `${kind} maintains readable line weight`);
    const signature = JSON.stringify(group.children.map(item => [item.tag, [...item.attributes].filter(([name]) => geometry.has(name))]));
    assert.ok(!glyphs.has(signature), `${kind} needs a distinguishable equipment shape`);
    glyphs.add(signature);
  }
});
