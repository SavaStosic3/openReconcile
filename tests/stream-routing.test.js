import test from 'node:test';
import assert from 'node:assert/strict';
import { addCrossingBridges, getStreamRoutes, routeStream } from '../public/stream-routing.js';

const route = (id, points) => ({ id, points, label: { ...points[0] } });
const horizontal = (id = 'horizontal', start = 0, end = 100) => route(id, [{ x: start, y: 0 }, { x: end, y: 0 }]);
const vertical = (id = 'vertical', x = 50, top = -50, bottom = 50) => route(id, [{ x, y: top }, { x, y: bottom }]);

test('strict perpendicular crossings produce an upward horizontal bridge and expanded bounds', () => {
  const [h, v] = addCrossingBridges([horizontal(), vertical()]);
  assert.equal(h.bridges.length, 1);
  assert.equal(h.bridges[0].radius, 7);
  assert.equal(h.d, 'M 0 0 H 43 A 7 7 0 0 1 57 0 H 100');
  assert.deepEqual(h.bounds, { left: 0, right: 100, top: -7, bottom: 0 });
  assert.equal(v.d, 'M 50 -50 V 50');
  assert.deepEqual(v.bridges, []);
});

test('reverse-direction bridges stay above the stream and do not depend on stream order', () => {
  const input = [horizontal('horizontal', 100, 0), vertical()];
  const forwardOrder = addCrossingBridges(input);
  const reverseOrder = addCrossingBridges([...input].reverse());
  assert.equal(forwardOrder[0].d, 'M 100 0 H 57 A 7 7 0 0 0 43 0 H 0');
  assert.deepEqual(forwardOrder[0], reverseOrder[1]);
  assert.deepEqual(forwardOrder[1], reverseOrder[0]);
});

test('nearby labels leave the published value row and its outline clear of the crossing bridge', () => {
  const source = horizontal();
  source.label = { x: 80, y: 0 };
  const [h] = addCrossingBridges([source, vertical()]);
  const bridge = h.bridges[0];
  // The editor places the 10 px result baseline 12 px below the label anchor.
  // Include 3 px descenders, its 4 px outline, and the bridge's 7 px halo.
  const valueBottom = h.label.y - 15 + 27 + 3 + 2;
  const bridgeTop = bridge.y - bridge.radius - 3.5;
  assert.ok(valueBottom <= bridgeTop - 2, 'the published result row must leave visible space above the complete bridge halo');
});

test('endpoints, shared ports, corners, and collinear overlaps never imply a nonconnection bump', () => {
  const cases = [
    [horizontal(), vertical('endpoint', 0)],
    [horizontal(), vertical('endpoint', 100)],
    [horizontal(), vertical('branch', 50, 0, 50)],
    [horizontal(), route('corner', [{ x: 50, y: -50 }, { x: 50, y: 0 }, { x: 80, y: 0 }])],
    [horizontal(), horizontal('overlap', 20, 80)],
    // A route may return past its own shared endpoint; it remains a real join.
    [horizontal(), route('shared-port', [{ x: 50, y: -50 }, { x: 50, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 0 }, { x: 50, y: 0 }])]
  ];
  for (const input of cases) assert.equal(addCrossingBridges(input)[0].bridges.length, 0);
});

test('clustered, repeated, and near-corner crossings shrink without overlapping or reversing', () => {
  const [h] = addCrossingBridges([horizontal(), vertical('a', 40), vertical('b', 41), vertical('repeat', 41), vertical('corner', 99.9)]);
  assert.equal(h.bridges.length, 3);
  assert.equal(h.bridges[0].radius, 0.4);
  assert.equal(h.bridges[1].radius, 0.4);
  assert.ok(Math.abs(h.bridges[2].radius - 0.08) < 1e-8);
  for (let index = 0; index < h.bridges.length; index++) {
    const bridge = h.bridges[index];
    assert.ok(bridge.x - bridge.radius > 0 && bridge.x + bridge.radius < 100);
    if (index > 0) assert.ok(h.bridges[index - 1].x + h.bridges[index - 1].radius < bridge.x - bridge.radius);
  }
  assert.doesNotMatch(h.d, /NaN|Infinity/);
  assert.match(h.d, /H 99.82 A 0.08 0.08 0 0 1 99.98 0 H 100$/);
});

test('self-crossings are not presented as separate disconnected streams', () => {
  const [self] = addCrossingBridges([route('loop', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }])]);
  assert.deepEqual(self.bridges, []);
});

test('parallel routes have stable lanes and unchanged endpoints when the model order changes', () => {
  const model = { nodes: [{ id: 'source', kind: 'inlet', x: 0, y: 0 }, { id: 'target', kind: 'outlet', x: 300, y: 0 }], streams: [{ id: 'b', source: 'source', target: 'target' }, { id: 'a', source: 'source', target: 'target' }] };
  const original = structuredClone(model);
  const reversed = { ...model, streams: [...model.streams].reverse() };
  for (const stream of model.streams) assert.deepEqual(routeStream(model, stream), routeStream(reversed, stream));
  assert.equal(routeStream(model, model.streams[0]).label.y, 16);
  assert.equal(routeStream(model, model.streams[1]).label.y, -16);
  assert.deepEqual(model, original);
});

test('hidden stream routes and their crossings are omitted while remaining routes retain their lanes', () => {
  const model = {
    nodes: [
      { id: 'left', kind: 'inlet', x: 0, y: 0 }, { id: 'right', kind: 'outlet', x: 400, y: 0 },
      { id: 'top', kind: 'inlet', x: 0, y: -100 }, { id: 'bottom', kind: 'outlet', x: 300, y: 100 }
    ],
    streams: [{ id: 'h', source: 'left', target: 'right' }, { id: 'v', source: 'top', target: 'bottom' }]
  };
  const original = structuredClone(model);
  const all = getStreamRoutes(model);
  const hidden = getStreamRoutes(model, { hiddenIds: ['v'] });
  const revealed = getStreamRoutes(model, { hiddenIds: ['v'], showHidden: true });
  assert.equal(all.get('h').bridges.length, 1);
  assert.equal(hidden.has('v'), false);
  assert.equal(hidden.get('h').bridges.length, 0);
  assert.deepEqual(hidden.get('h').points, all.get('h').points);
  assert.deepEqual(revealed, all);
  assert.deepEqual(model, original);
});

test('empty models and invalid stream endpoints safely produce no visible route', () => {
  assert.equal(getStreamRoutes({ nodes: [], streams: [] }).size, 0);
  assert.equal(getStreamRoutes({ nodes: [], streams: [{ id: 'missing', source: 'a', target: 'b' }] }).size, 0);
});
