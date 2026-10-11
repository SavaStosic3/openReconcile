import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel } from '../public/model.js';
import { createCatalog, validateCatalog, validateEditableModel } from '../public/management-store.js';
import { sizedModel } from './helpers/large-model-fixture.js';

test('models above the former count limits survive JSON import and catalog persistence', () => {
  const model = JSON.parse(JSON.stringify(sizedModel()));
  assert.equal(model.nodes.length, 201);
  assert.equal(model.streams.length, 501);
  assert.equal(validateModel(model), model);
  assert.deepEqual(validateEditableModel(model), model);
  const catalog = createCatalog(model, { id: 'large-plant', now: '2026-10-11T12:00:00.000Z' });
  assert.deepEqual(validateCatalog(JSON.parse(JSON.stringify(catalog))).models[0].model, model);
});
