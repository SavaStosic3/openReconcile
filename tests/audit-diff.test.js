import test from 'node:test';
import assert from 'node:assert/strict';
import { describeModelChanges, describeReadingChanges } from '../backend/audit-diff.js';
import { exampleModel } from '../public/model.js';

const changedModel = (model, change) => { const next = structuredClone(model); change(next); return next; };
const details = (events, category) => events.find(event => event.category === category)?.changes ?? [];

test('identical models and different object or collection ordering create no audit changes', () => {
  const before = exampleModel();
  const after = { streams: before.streams.slice().reverse().map(stream => Object.fromEntries(Object.entries(stream).reverse())), nodes: before.nodes.slice().reverse(), periodHours: before.periodHours, name: before.name, version: before.version };
  assert.deepEqual(describeModelChanges(before, after), []);
  assert.deepEqual(describeReadingChanges(before, after), []);
});

test('numeric string readings and explicit physical defaults do not create false changes', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.streams[0].value = '100'; next.streams[0].meterType = 'physical'; next.streams[0].meterName = ''; next.streams[0].density = '1000'; });
  assert.deepEqual(describeModelChanges(before, after), []);
  assert.deepEqual(describeReadingChanges(before, after), []);
});

test('a combined edit separates measurement, mapping, and diagram fields with exact context', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.streams[0].value = 104; next.streams[0].dataMapping = { sourceName: 'PLANT.FEED' }; next.nodes[1].x = 370; });
  const events = describeModelChanges(before, after);
  assert.deepEqual(events.map(event => event.category), ['measurement', 'mapping', 'model']);
  const reading = details(events, 'measurement').find(change => change.field === 'value');
  assert.deepEqual(reading, { itemId: 'f1', itemName: 'F-01', unit: 'kg', previousUnit: 'kg', metric: 'mass', previousMetric: 'mass', meterType: 'physical', previousMeterType: 'physical', field: 'value', before: 100, after: 104 });
  assert.equal(details(events, 'mapping').find(change => change.field === 'sourceName').after, 'PLANT.FEED');
  assert.deepEqual(details(events, 'model').map(change => [change.field, change.before, change.after]), [['x', 350, 370]]);
});

test('clearing and entering zero readings preserve null and zero separately', () => {
  const before = exampleModel();
  const cleared = changedModel(before, next => { next.streams[0].value = ''; });
  assert.deepEqual(describeReadingChanges(before, cleared).map(change => [change.before, change.after]), [[100, null]]);
  const zero = changedModel(cleared, next => { next.streams[0].value = 0; next.streams[0].uncertaintyType = 'absolute'; });
  assert.deepEqual(describeReadingChanges(cleared, zero).map(change => [change.before, change.after]), [[null, 0]]);
  const nullReading = changedModel(cleared, next => { next.streams[0].value = null; });
  assert.deepEqual(describeModelChanges(cleared, nullReading), []);
});

test('virtual formula edits are audited and cached virtual values never enter trends', () => {
  const before = exampleModel();
  Object.assign(before.streams[0], { meterType: 'virtual', formula: '[F-03] + [F-04]', value: 95 });
  const after = changedModel(before, next => { next.streams[0].formula = '[F-03] * 2'; next.streams[0].value = 120; });
  assert.deepEqual(describeReadingChanges(before, after), []);
  assert.deepEqual(details(describeModelChanges(before, after), 'measurement').map(change => change.field), ['formula']);
});

test('switching a physical meter to virtual ends its physical series without retaining a virtual cache', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.streams[0].meterType = 'virtual'; next.streams[0].formula = '[F-03] + [F-04]'; next.streams[0].value = 9999; });
  const [point] = describeReadingChanges(before, after);
  assert.equal(point.before, 100); assert.equal(point.after, null);
  assert.equal(point.meterType, 'virtual'); assert.equal(point.previousMeterType, 'physical');
  assert.ok(details(describeModelChanges(before, after), 'measurement').some(change => change.field === 'value' && change.after === null));
});

test('adding and removing physical meters create clear value and configuration changes', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.streams[1].measured = true; next.streams[1].value = 97; next.streams[0].measured = false; });
  assert.deepEqual(describeReadingChanges(before, after).map(change => [change.itemId, change.before, change.after]), [['f1', 100, null], ['f2', null, 97]]);
  const changes = details(describeModelChanges(before, after), 'measurement');
  assert.equal(changes.filter(change => change.field === 'measured').length, 2);
  assert.equal(changes.filter(change => change.field === 'value').length, 2);
});

test('removing and adding streams records structure, mappings, and physical readings', () => {
  const before = exampleModel(); before.streams[0].dataMapping = { sourceName: 'FEED' };
  const after = changedModel(before, next => { next.streams = next.streams.slice(1); next.streams.push({ ...before.streams[0], id: 'new', name: 'New feed', dataMapping: { sourceName: 'OTHER.FEED' }, value: 90 }); });
  const events = describeModelChanges(before, after);
  assert.deepEqual(details(events, 'model').filter(change => change.field === 'presence').map(change => [change.itemId, change.before, change.after]), [['f1', true, false], ['new', false, true]]);
  assert.deepEqual(describeReadingChanges(before, after).map(change => [change.itemId, change.before, change.after]), [['f1', 100, null], ['new', null, 90]]);
  assert.ok(details(events, 'mapping').some(change => change.itemId === 'f1' && change.field === 'sourceName' && change.after === null));
});

test('unmetered cached readings never generate measurement events or trend points', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.streams[1].value = 800; next.streams[1].meterType = 'virtual'; next.streams[1].formula = '[F-01]'; });
  assert.deepEqual(describeModelChanges(before, after), []);
  assert.deepEqual(describeReadingChanges(before, after), []);
});

test('mapping renames record the derived target name for both units and meters', () => {
  const before = exampleModel(); before.nodes[0].dataMapping = { sourceName: 'UNIT.FEED' }; before.streams[0].dataMapping = { sourceName: 'FLOW.FEED' };
  const after = changedModel(before, next => { next.nodes[0].name = 'Fresh feed'; next.streams[0].meterName = 'Feed meter'; });
  const mapping = details(describeModelChanges(before, after), 'mapping');
  assert.deepEqual(mapping.map(change => [change.itemId, change.field, change.before, change.after]), [['feed', 'modelName', 'Raw feed', 'Fresh feed'], ['f1', 'modelName', 'F-01', 'Feed meter']]);
});

test('unit, metric, uncertainty and density edits identify conversion-relevant measurement changes', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { Object.assign(next.streams[0], { unit: 'L', metric: 'volume', density: 850, uncertainty: 3, uncertaintyType: 'percent' }); });
  assert.deepEqual(details(describeModelChanges(before, after), 'measurement').map(change => change.field).sort(), ['density', 'metric', 'uncertainty', 'uncertaintyType', 'unit']);
  const [point] = describeReadingChanges(before, after);
  assert.equal(point.before, 100); assert.equal(point.after, 100); assert.equal(point.unit, 'L'); assert.equal(point.previousUnit, 'kg');
  assert.equal(point.metric, 'volume'); assert.equal(point.previousMetric, 'mass');
});

test('period, material, topology and unit position changes remain searchable model events', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.periodHours = 24; next.name = 'Daily balance'; next.nodes[1].kind = 'pump'; next.nodes[1].y = 300; next.streams[0].material = 'Water'; next.streams[0].source = 'mix'; next.streams[0].phase = 'Gas'; next.streams[0].temperature = 25; next.streams[0].pressure = 200; });
  assert.deepEqual(details(describeModelChanges(before, after), 'model').map(change => change.field).sort(), ['kind', 'material', 'name', 'periodHours', 'phase', 'pressure', 'source', 'temperature', 'y']);
});

test('bulk edits use bounded event chunks without losing any audit detail or physical reading point', () => {
  const before = exampleModel(); before.streams = Array.from({ length: 500 }, (_, index) => ({ ...before.streams[0], id: `m${String(index).padStart(3, '0')}`, value: index }));
  const after = changedModel(before, next => { for (const stream of next.streams) stream.value += 1; });
  const events = describeModelChanges(before, after);
  assert.equal(events.length, 5);
  for (const [index, event] of events.entries()) {
    assert.equal(event.category, 'measurement'); assert.equal(event.changes.length, 100); assert.equal(event.totalChanges, 500); assert.equal(event.truncated, false);
    assert.equal(event.part, index + 1); assert.equal(event.parts, 5);
    assert.match(event.summary, /500/);
  }
  assert.equal(new Set(events.flatMap(event => event.changes.map(change => change.itemId))).size, 500);
  assert.equal(describeReadingChanges(before, after).length, 500);
});

test('long supported IDs remain exact in trend records and distinct in comparisons', () => {
  const before = exampleModel(); before.streams[0].id = 'id'.repeat(1000);
  const after = changedModel(before, next => { next.streams[0].value = 101; next.streams[0].source = `${'s'.repeat(1000)}b`; });
  before.streams[0].source = `${'s'.repeat(1000)}a`;
  assert.equal(describeReadingChanges(before, after)[0].itemId, before.streams[0].id);
  const connection = details(describeModelChanges(before, after), 'model').find(change => change.field === 'source');
  assert.equal(connection.before, before.streams[0].source); assert.equal(connection.after, after.streams[0].source);
  assert.equal(details(describeModelChanges(before, after), 'measurement')[0].itemId, before.streams[0].id);
});

test('known fields are bounded and arbitrary imported secrets never enter descriptions', () => {
  const before = exampleModel();
  const after = changedModel(before, next => { next.password = 'DO_NOT_AUDIT'; next.connectionString = 'DO_NOT_AUDIT'; next.streams[0].credentials = { token: 'DO_NOT_AUDIT' }; next.streams[0].formula = 'DO_NOT_AUDIT'; next.streams[0].measured = false; next.streams[0].name = 'N'.repeat(5000); next.nodes[0].dataMapping = { sourceName: 'S'.repeat(5000), password: 'DO_NOT_AUDIT' }; });
  const serialized = JSON.stringify(describeModelChanges(before, after));
  assert.ok(!serialized.includes('DO_NOT_AUDIT'));
  for (const event of describeModelChanges(before, after)) for (const change of event.changes) for (const value of Object.values(change)) if (typeof value === 'string') assert.ok(value.length <= 1000);
});

test('invalid editable reading and uncertainty text changes retain actual bounded values without numeric trend points', () => {
  const before = exampleModel(); Object.assign(before.streams[0], { value: 'abc', uncertainty: 'first uncertainty' });
  const after = changedModel(before, next => { next.streams[0].value = 'def'; next.streams[0].uncertainty = 'second uncertainty'; });
  assert.deepEqual(details(describeModelChanges(before, after), 'measurement').map(change => [change.field, change.before, change.after]), [['value', 'abc', 'def'], ['uncertainty', 'first uncertainty', 'second uncertainty']]);
  assert.deepEqual(describeReadingChanges(before, after), []);
  const long = changedModel(after, next => { next.streams[0].value = 'invalid'.repeat(1000); });
  assert.equal(details(describeModelChanges(after, long), 'measurement').find(change => change.field === 'value').after.length, 1000);
  const cleared = changedModel(after, next => { next.streams[0].value = null; });
  assert.deepEqual(details(describeModelChanges(after, cleared), 'measurement').map(change => [change.field, change.before, change.after]), [['value', 'def', null]]);
  const valid = changedModel(after, next => { next.streams[0].value = 0; });
  assert.deepEqual(describeReadingChanges(after, valid).map(change => [change.before, change.after]), [[null, 0]]);
});
