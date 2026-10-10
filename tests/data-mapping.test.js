import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelItemName, getDataMapping, validateDataMapping, setItemDataMapping } from '../public/data-mapping.js';
import { exampleModel, validateModel } from '../public/model.js';
import { createCatalog, duplicateModel, validateEditableModel } from '../public/management-store.js';
import { reconcile } from '../public/solver.js';

test('mapping model names follow process, stream, physical meter and virtual meter names', () => {
  const model = exampleModel();
  assert.equal(getModelItemName(model.nodes[1], 'node'), 'Feed mixer');
  assert.equal(getModelItemName(model.streams[1], 'stream'), 'F-02');
  const physical = model.streams[0]; physical.meterName = ' Feed meter ';
  assert.equal(getModelItemName(physical, 'stream'), 'Feed meter');
  const virtual = model.streams[1]; Object.assign(virtual, { measured: true, meterType: 'virtual', meterName: 'Calculated feed', formula: '[Feed meter]' });
  assert.equal(getModelItemName(virtual, 'stream'), 'Calculated feed');
  virtual.meterName = '';
  assert.equal(getModelItemName(virtual, 'stream'), 'F-02');
});

test('mapping metadata is bounded plain data with only a canonical source identifier', () => {
  assert.equal(validateDataMapping(undefined), undefined);
  for (const sourceName of ['plant.feed.tonnage', 'CSV Feed Column', 'タグ/流量', 'x'.repeat(200)]) {
    assert.doesNotThrow(() => validateDataMapping({ sourceName }));
  }
  for (const mapping of [null, [], 'Feed', 2, {}, { sourceName: null }, { sourceName: 1 }, { sourceName: '' }, { sourceName: '   ' }, { sourceName: ' Feed ' }, { sourceName: 'x'.repeat(201) }, { sourceName: 'Feed', modelName: 'Stale name' }, { sourceName: 'Feed', value: 100 }, Object.create({ sourceName: 'Inherited' }), new Date()]) {
    assert.throws(() => validateDataMapping(mapping, 'Feed meter'), /Feed meter.*(Source Name|source)/);
  }
  const symbolMetadata = { sourceName: 'Feed', [Symbol('secret')]: true };
  assert.throws(() => validateDataMapping(symbolMetadata), /only Source Name/);
});

test('mapping updates target the requested stable item ID and return detached data without changing readings', () => {
  const original = exampleModel(), before = structuredClone(original);
  let mapped = setItemDataMapping(original, { kind: 'node', id: 'mix', sourceName: ' Plant/Mixer ' });
  mapped = setItemDataMapping(mapped, { kind: 'stream', id: 'f1', sourceName: ' Plant/Feed ' });
  assert.deepEqual(original, before);
  assert.equal(mapped.nodes[1].dataMapping.sourceName, 'Plant/Mixer');
  assert.equal(mapped.streams[0].dataMapping.sourceName, 'Plant/Feed');
  assert.equal(mapped.streams[0].value, before.streams[0].value);
  assert.equal(getDataMapping(mapped.streams[1]), null);
  const detached = getDataMapping(mapped.streams[0]); detached.sourceName = 'Changed';
  assert.equal(mapped.streams[0].dataMapping.sourceName, 'Plant/Feed');
  mapped.nodes[1].name = 'Renamed mixer'; mapped.streams[0].meterName = 'Renamed feed meter';
  assert.equal(getModelItemName(mapped.nodes[1], 'node'), 'Renamed mixer');
  assert.equal(getModelItemName(mapped.streams[0], 'stream'), 'Renamed feed meter');
  assert.equal(mapped.nodes[1].dataMapping.sourceName, 'Plant/Mixer');
  assert.equal(mapped.streams[0].dataMapping.sourceName, 'Plant/Feed');
});

test('blank source identifiers remove mappings and invalid or stale targets fail before mutation', () => {
  const mapped = setItemDataMapping(exampleModel(), { kind: 'stream', id: 'f1', sourceName: 'Feed' });
  const removed = setItemDataMapping(mapped, { kind: 'stream', id: 'f1', sourceName: ' \t ' });
  assert.equal(Object.hasOwn(removed.streams[0], 'dataMapping'), false);
  assert.deepEqual(mapped.streams[0].dataMapping, { sourceName: 'Feed' });
  for (const changes of [
    { kind: 'stream', id: 'deleted', sourceName: 'Feed' },
    { kind: 'node', id: 'f1', sourceName: 'Feed' },
    { kind: 'meter', id: 'f1', sourceName: 'Feed' },
    { kind: 'stream', id: 'f1', sourceName: null },
    { kind: 'stream', id: 'f1', sourceName: 'x'.repeat(201) }
  ]) assert.throws(() => setItemDataMapping(mapped, changes));
  assert.deepEqual(mapped.streams[0].dataMapping, { sourceName: 'Feed' });
});

test('model and editable import validators accept optional mappings and reject bad unit or stream metadata', () => {
  const legacy = exampleModel();
  assert.deepEqual(validateModel(legacy), legacy);
  for (const collection of ['nodes', 'streams']) {
    const good = exampleModel(); good[collection][0].dataMapping = { sourceName: 'Plant/F01' };
    assert.deepEqual(validateModel(good), good); assert.deepEqual(validateEditableModel(good), good);
    for (const bad of [null, [], { sourceName: '' }, { sourceName: 'x'.repeat(201) }, { sourceName: 'Plant/F01', modelName: 'Ignored target' }]) {
      const model = exampleModel(); model[collection][0].dataMapping = bad;
      assert.throws(() => validateModel(model)); assert.throws(() => validateEditableModel(model));
    }
  }
});

test('mapping roundtrips through model JSON and detached duplicates without changing reconciliation', () => {
  const baseline = exampleModel();
  let mapped = setItemDataMapping(baseline, { kind: 'node', id: 'mix', sourceName: 'Plant/Mixer' });
  mapped = setItemDataMapping(mapped, { kind: 'stream', id: 'f1', sourceName: 'Plant/Feed' });
  const restored = validateEditableModel(JSON.parse(JSON.stringify(mapped)));
  assert.deepEqual(restored, mapped); assert.deepEqual(reconcile(restored), reconcile(baseline));
  const catalog = createCatalog(restored, { id: 'original', now: 0 });
  const duplicated = duplicateModel(catalog, 'original', { id: 'copy', now: 1 });
  const copy = duplicated.models.find(entry => entry.id === 'copy').model;
  assert.deepEqual(copy.nodes[1].dataMapping, mapped.nodes[1].dataMapping);
  assert.deepEqual(copy.streams[0].dataMapping, mapped.streams[0].dataMapping);
  copy.streams[0].dataMapping.sourceName = 'Copy/Feed';
  assert.equal(catalog.models[0].model.streams[0].dataMapping.sourceName, 'Plant/Feed');
});
