import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineVisibility } from '../public/line-visibility.js';

const KEY = 'massflow-line-visibility-v1';
function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[KEY, initial]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const streams = () => [{ id: 'feed', value: 100, measured: true }, { id: 'product', value: 99, measured: true }];
const visible = { hiddenIds: [], showHidden: false };

test('hidden lines persist per account and model without modifying plant data', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage });
  const model = Object.freeze({ streams: Object.freeze(streams().map(stream => Object.freeze(stream))) });
  const original = JSON.stringify(model);
  assert.deepEqual(visibility.scope('viewer', 'plant-a', model.streams), visible);
  assert.deepEqual(visibility.hide('feed'), { hiddenIds: ['feed'], showHidden: false });
  assert.deepEqual(visibility.scope('viewer', 'plant-b', streams()), visible);
  visibility.hide('product');
  assert.deepEqual(visibility.scope('admin', 'plant-a', streams()), visible);
  const reloaded = createLineVisibility({ storage });
  assert.deepEqual(reloaded.scope('viewer', 'plant-a', model.streams), { hiddenIds: ['feed'], showHidden: false });
  assert.deepEqual(reloaded.scope('viewer', 'plant-b', streams()), { hiddenIds: ['product'], showHidden: false });
  assert.equal(JSON.stringify(model), original);
});

test('show hidden temporarily reveals lines while preserving individual hidden preferences', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage });
  visibility.scope('viewer', 'plant', streams()); visibility.hide('feed');
  assert.deepEqual(visibility.setShowHidden(true), { hiddenIds: ['feed'], showHidden: true });
  const reloaded = createLineVisibility({ storage });
  assert.deepEqual(reloaded.scope('viewer', 'plant', streams()), { hiddenIds: ['feed'], showHidden: true });
  assert.deepEqual(reloaded.setShowHidden(false), { hiddenIds: ['feed'], showHidden: false });
  assert.deepEqual(reloaded.show('feed'), visible);
  reloaded.hide('feed'); reloaded.hide('product'); reloaded.setShowHidden(true);
  assert.deepEqual(reloaded.showAll(), visible);
  assert.deepEqual(createLineVisibility({ storage }).scope('viewer', 'plant', streams()), visible);
});

test('deleted stream preferences are pruned, and unknown line IDs cannot be hidden', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage });
  visibility.scope('viewer', 'plant', streams()); visibility.hide('feed'); visibility.hide('product');
  assert.deepEqual(visibility.scope('viewer', 'plant', [{ id: 'product' }]), { hiddenIds: ['product'], showHidden: false });
  assert.deepEqual(visibility.hide('missing'), { hiddenIds: ['product'], showHidden: false });
  const reloaded = createLineVisibility({ storage });
  assert.deepEqual(reloaded.scope('viewer', 'plant', streams()), { hiddenIds: ['product'], showHidden: false });
});

test('scoping the same model for published and editor views preserves shared preferences', () => {
  const visibility = createLineVisibility({ storage: memoryStorage() });
  visibility.scope('viewer', 'plant', streams()); visibility.hide('feed');
  assert.deepEqual(visibility.scope('viewer', 'plant', ['feed', 'product']), { hiddenIds: ['feed'], showHidden: false });
  const detached = visibility.snapshot(); detached.hiddenIds.push('product'); detached.showHidden = true;
  assert.deepEqual(visibility.snapshot(), { hiddenIds: ['feed'], showHidden: false });
});

test('malformed, oversized, or unsupported stored preferences safely use defaults', () => {
  for (const raw of ['broken JSON', 'null', '[]', '{"version":2,"scopes":[]}', 'x'.repeat(2_000_001), JSON.stringify({ version: 1, scopes: [null, {}, { accountId: 'viewer', modelId: 'plant', hiddenIds: 'feed' }] })]) {
    const visibility = createLineVisibility({ storage: memoryStorage(raw) });
    assert.deepEqual(visibility.scope('viewer', 'plant', streams()), visible);
  }
  const saved = { version: 1, scopes: [{ accountId: 'viewer', modelId: 'plant', hiddenIds: ['feed', 'feed', null, '', 'x'.repeat(257), '\u0000'], showHidden: 'true' }] };
  const visibility = createLineVisibility({ storage: memoryStorage(JSON.stringify(saved)) });
  assert.deepEqual(visibility.scope('viewer', 'plant', streams()), { hiddenIds: ['feed'], showHidden: false });
});

test('unavailable and full storage retain usable session-only line preferences', () => {
  for (const storage of [null, {}, { getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Full'); } }]) {
    const visibility = createLineVisibility({ storage });
    visibility.scope('viewer', 'plant', streams()); visibility.hide('feed');
    assert.deepEqual(visibility.snapshot(), { hiddenIds: ['feed'], showHidden: false });
    assert.deepEqual(visibility.showAll(), visible);
  }
  const options = {}; Object.defineProperty(options, 'storage', { get() { throw new Error('Disabled'); } });
  assert.doesNotThrow(() => createLineVisibility(options));
  assert.doesNotThrow(() => createLineVisibility());
});

test('invalid scopes cannot reuse another account model preferences', () => {
  const visibility = createLineVisibility({ storage: memoryStorage() });
  assert.deepEqual(visibility.hide('feed'), visible);
  visibility.scope('viewer', 'plant', streams()); visibility.hide('feed');
  for (const [accountId, modelId] of [[null, 'plant'], ['viewer', ''], ['viewer', '\nplant'], ['x'.repeat(257), 'plant']]) {
    assert.deepEqual(visibility.scope(accountId, modelId, streams()), visible);
    assert.deepEqual(visibility.hide('feed'), visible);
    assert.deepEqual(visibility.setShowHidden(true), visible);
  }
  assert.deepEqual(visibility.scope('viewer', 'plant', streams()), { hiddenIds: ['feed'], showHidden: false });
});

test('storage count stays bounded while retaining recently visited model preferences', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage });
  for (let index = 0; index < 105; index++) {
    visibility.scope('viewer', `plant-${index}`, ['feed']); visibility.hide('feed');
  }
  const saved = JSON.parse(storage.getItem(KEY));
  assert.equal(saved.scopes.length, 100);
  assert.equal(saved.scopes.some(entry => entry.modelId === 'plant-0'), false);
  const reloaded = createLineVisibility({ storage });
  assert.deepEqual(reloaded.scope('viewer', 'plant-104', ['feed']), { hiddenIds: ['feed'], showHidden: false });
  const manyStreams = Array.from({ length: 505 }, (_, index) => `line-${index}`);
  visibility.scope('viewer', 'large-plant', manyStreams);
  for (const id of manyStreams) visibility.hide(id);
  assert.equal(visibility.snapshot().hiddenIds.length, 500);
  assert.deepEqual(visibility.hide('line-504'), visibility.snapshot());
});

test('custom storage key and IDs containing punctuation keep scopes distinct', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage, key: 'other-view-preferences' });
  visibility.scope('person@example.com', 'plant:one', ['__proto__']); visibility.hide('__proto__');
  assert.equal(storage.getItem(KEY), null);
  assert.deepEqual(createLineVisibility({ storage, key: 'other-view-preferences' }).scope('person@example.com', 'plant:one', ['__proto__']), { hiddenIds: ['__proto__'], showHidden: false });
});

test('draft and publication unions retain later IDs after duplicate streams and cap hidden preferences', () => {
  const storage = memoryStorage(), visibility = createLineVisibility({ storage });
  const draft = Array.from({ length: 500 }, (_, index) => ({ id: `draft-${index}` }));
  const published = Array.from({ length: 500 }, (_, index) => ({ id: `published-${index}` }));
  const union = [...draft, ...draft, ...published];
  visibility.scope('viewer', 'plant', union);
  assert.deepEqual(visibility.hide('published-499'), { hiddenIds: ['published-499'], showHidden: false });
  for (const stream of draft.slice(0, 499)) visibility.hide(stream.id);
  assert.equal(visibility.snapshot().hiddenIds.length, 500);
  assert.equal(visibility.hide('draft-499').hiddenIds.includes('draft-499'), false);
  assert.equal(JSON.parse(storage.getItem(KEY)).scopes[0].hiddenIds.length, 500);
  assert.deepEqual(createLineVisibility({ storage }).scope('viewer', 'plant', union), visibility.snapshot());
  visibility.show('draft-0');
  assert.equal(visibility.hide('draft-499').hiddenIds.includes('draft-499'), true);
});

test('unchanged scope refreshes and reveal settings avoid redundant browser storage writes', () => {
  const storage = memoryStorage(); let writes = 0;
  const savedSetItem = storage.setItem;
  storage.setItem = (key, value) => { writes++; savedSetItem(key, value); };
  const visibility = createLineVisibility({ storage });
  visibility.scope('viewer', 'plant', streams()); visibility.hide('feed');
  const afterHide = writes;
  visibility.scope('viewer', 'plant', streams()); visibility.scope('viewer', 'plant', streams());
  visibility.hide('feed'); visibility.setShowHidden(false);
  assert.equal(writes, afterHide);
  visibility.setShowHidden(true);
  assert.equal(writes, afterHide + 1);
});
