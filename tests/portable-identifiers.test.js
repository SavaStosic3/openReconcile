import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PORTABLE_ID_LENGTH, validatePortableId } from '../public/identifiers.js';
import { exampleModel, validateModel } from '../public/model.js';
import { createCatalog, updateModel, validateEditableModel } from '../public/management-store.js';
import { reconcile } from '../public/solver.js';
import { sqlOutputRows } from '../backend/sql-connectors.js';
import { validateWrite } from '../connectors/sql-gateway/src/contract.js';

const window = { start: '2026-10-10T09:00:00.000Z', end: '2026-10-10T10:00:00.000Z' };
const invalidIds = ['', 'x'.repeat(129), ' id', 'id ', 'id\n', 'id\u0000', 'id\u007f', 'id\u0085', '\ud800', '\udc00'];

function withItemId(kind, id) {
  const model = exampleModel();
  if (kind === 'stream') {
    model.streams[0].id = id;
    model.streams[0].dataMapping = { sourceName: 'Plant.Feed' };
  } else {
    const node = model.nodes[0], before = node.id;
    node.id = id;
    node.dataMapping = { sourceName: 'Plant.Inlet' };
    for (const stream of model.streams) {
      if (stream.source === before) stream.source = id;
      if (stream.target === before) stream.target = id;
    }
  }
  return model;
}

function rows(model) {
  const result = reconcile(model);
  return sqlOutputRows({ id: 'run-1', modelId: 'model-1', modelName: model.name,
    modelSnapshot: model, result, status: result.status, finishedAt: window.end }, window).rows;
}

test('portable IDs preserve ordinary identifiers and reject lossy or ambiguous representations', () => {
  assert.equal(MAX_PORTABLE_ID_LENGTH, 128);
  for (const id of ['feed', 'plant.feed:line-2', 'Tank A', 'équipment-α', '💧'.repeat(64), 'x'.repeat(128)]) {
    assert.equal(validatePortableId(id), id);
  }
  for (const id of [...invalidIds, undefined, null, 123, '💧'.repeat(65)]) {
    assert.throws(() => validatePortableId(id), /1–128 characters/);
  }
});

test('model import and draft save reject IDs that cannot be written by connectors', () => {
  const catalog = createCatalog(exampleModel(), { id: 'model-1', now: window.end });
  for (const kind of ['stream', 'node']) for (const id of invalidIds) {
    const model = withItemId(kind, id), imported = JSON.parse(JSON.stringify(model));
    assert.throws(() => validateModel(model), /ID must contain 1–128 characters/);
    assert.throws(() => validateEditableModel(imported), /ID must contain 1–128 characters/);
    assert.throws(() => updateModel(catalog, 'model-1', model, window.end), /ID must contain 1–128 characters/);
    assert.equal(reconcile(model).status, 'invalid');
  }
});

test('128-character unit and stream IDs import, reconcile and pass the SQL write contract unchanged', () => {
  const id = 'x'.repeat(128);
  for (const kind of ['stream', 'node']) {
    const model = validateEditableModel(withItemId(kind, id));
    const output = rows(model);
    assert.ok(output.length > 0);
    assert.ok(output.every(row => row.item_id === id));
    const validated = validateWrite({ table: 'results', rows: output }, { writableTables: ['results'] });
    assert.ok(validated.every(row => row.item_id === id));
  }
});

test('SQL writes and local exports enforce the portable identifier contract for legacy data too', () => {
  const model = withItemId('stream', 'feed-stream'), output = rows(model);
  for (const id of invalidIds) {
    for (const field of ['run_id', 'model_id', 'item_id']) {
      assert.throws(() => validateWrite({ table: 'results', rows: output.map(row => ({ ...row, [field]: id })) }, { writableTables: ['results'] }), /1–128 characters/);
    }
    const legacy = structuredClone(model);
    legacy.streams[0].id = id;
    const result = { status: 'ok', warnings: [], streams: [{ id, status: 'reconciled', value: 1 }] };
    assert.throws(() => sqlOutputRows({ id: 'run-1', modelId: 'model-1', modelName: legacy.name,
      modelSnapshot: legacy, result, status: result.status, finishedAt: window.end }, window), /1–128 characters/);
  }
});
